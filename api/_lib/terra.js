// Terra Classic (columbus-5) CW20 token scanner. Token id = the CW20 contract address (terra1..., 44 chars for
// contracts from before the 2023 wasm upgrade, 64 chars for newer ones).
// No API keys: public Terra Classic LCD + GeckoTerminal + DexScreener. Set TERRA_LCD to use your own node first.
const { getOrders, dexPaid } = require("./dexpaid");

const LCDS = () => [process.env.TERRA_LCD, "https://terra-classic-lcd.publicnode.com", "https://terra-mainnet-rpc.allthatnode.com:1317"].filter(Boolean).map((u) => u.replace(/\/$/, ""));
const CONTRACT_RE = /^terra1(?:[02-9ac-hj-np-z]{58}|[02-9ac-hj-np-z]{38})$/;
const BURN = new Set(["terra1sk06e3dyexuq4shw77y3dsv480xv42mq73anxu"]); // community LUNC burn wallet
const FINDER = "https://finder.terra-classic.hexxagon.io/mainnet/address/";
const PTS = { critical: 100, high: 25, medium: 10, low: 4, info: 0, ok: 0 };
const fail = (status, message) => Object.assign(new Error(message), { status });
const isTerraId = (s) => CONTRACT_RE.test(String(s || "").trim().toLowerCase());
const isAddr = (a) => CONTRACT_RE.test(String(a || ""));
// Old (44-char) contracts look like wallets, so ask the chain. Cached per warm instance.
const kindCache = new Map();
async function isContract(a) {
  if (!isAddr(a)) return false;
  if (a.length === 64) return true;
  if (kindCache.has(a)) return kindCache.get(a);
  const r = await lcd(`/cosmwasm/wasm/v1/contract/${a}`, 4000);
  const v = !!(r && !r.notFound && r.contract_info);
  if (r) kindCache.set(a, v);
  if (kindCache.size > 2000) kindCache.delete(kindCache.keys().next().value);
  return v;
}

async function jget(u, ms = 6000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json" } }); return { status: r.status, body: r.ok ? await r.json() : null }; }
  catch (e) { return { status: 0, body: null }; } finally { clearTimeout(t); }
}
// LCD GET with failover. Returns the JSON body, or { notFound: true } when a node answered that it does not exist.
async function lcd(path, ms = 6000) {
  for (const base of LCDS()) {
    const r = await jget(base + path, ms);
    if (r.body) return r.body;
    // Node is up and the query itself failed (missing contract, not a pool, bad query): no point asking the next node.
    if (r.status === 404 || r.status === 400 || r.status === 500 || r.status === 501) return { notFound: true };
  }
  return null;
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
async function smart(addr, msg) {
  const r = await lcd(`/cosmwasm/wasm/v1/contract/${addr}/smart/${encodeURIComponent(b64(msg))}`);
  return r && !r.notFound && "data" in r ? r.data : undefined; // undefined = query failed, null = contract answered "none"
}

// ---- bech32 (only needed to decode older CW20 storage that keys balances by raw address bytes)
const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; } return c; }
const hrpx = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function bech32(hrp, bytes) {
  const d = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } }
  if (bits) d.push((acc << (5 - bits)) & 31);
  const p = polymod([...hrpx(hrp), ...d, 0, 0, 0, 0, 0, 0]) ^ 1, cs = [];
  for (let i = 0; i < 6; i++) cs.push((p >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...d, ...cs].map((x) => CH[x]).join("");
}
function bechValid(a) {
  const m = /^([a-z]+)1([02-9ac-hj-np-z]{6,})$/.exec(a); if (!m) return false;
  return polymod([...hrpx(m[1]), ...[...m[2]].map((c) => CH.indexOf(c))]) === 1;
}

// All balances of a CW20 contract, read straight from contract storage (one paged call instead of one query per holder).
// cw20-base keeps balances in Map "balance": key = 0x0007 "balance" <address>. Older contracts use raw address bytes.
const PREFIX = Buffer.concat([Buffer.from([0, 7]), Buffer.from("balance")]);
async function allBalances(addr, maxPages = 5) {
  const out = new Map(); let next = PREFIX.toString("base64"), pages = 0, complete = false;
  while (pages < maxPages) {
    const r = await lcd(`/cosmwasm/wasm/v1/contract/${addr}/state?pagination.limit=1000&pagination.key=${encodeURIComponent(next)}`, 9000);
    if (!r || r.notFound || !Array.isArray(r.models)) return pages ? { out, complete: false } : null;
    pages++;
    let stop = false;
    for (const m of r.models) {
      const k = /^[0-9A-Fa-f]+$/.test(m.key) ? Buffer.from(m.key, "hex") : Buffer.from(m.key, "base64");
      if (!k.subarray(0, PREFIX.length).equals(PREFIX)) { if (k.compare(PREFIX) > 0) { stop = true; break; } continue; }
      const rest = k.subarray(PREFIX.length), s = rest.toString("utf8");
      const who = /^terra1[02-9ac-hj-np-z]{38,58}$/.test(s) ? s : rest.length === 20 || rest.length === 32 ? bech32("terra", rest) : null;
      let v = null; try { v = JSON.parse(Buffer.from(m.value, "base64").toString("utf8")); } catch (e) { /* skip */ }
      const n = Number(v); if (who && n > 0) out.set(who, n);
    }
    const nk = r.pagination && r.pagination.next_key;
    if (stop || !nk) { complete = true; break; }
    next = nk;
  }
  return { out, complete };
}

async function prices() {
  const cg = await jget("https://api.coingecko.com/api/v3/simple/price?ids=terra-luna,terrausd&vs_currencies=usd", 4000);
  let lunc = cg.body && cg.body["terra-luna"] && cg.body["terra-luna"].usd, ustc = cg.body && cg.body.terrausd && cg.body.terrausd.usd;
  if (!lunc || !ustc) {
    const cc = await jget("https://min-api.cryptocompare.com/data/pricemulti?fsyms=LUNC,USTC&tsyms=USD", 4000);
    lunc = lunc || (cc.body && cc.body.LUNC && cc.body.LUNC.USD); ustc = ustc || (cc.body && cc.body.USTC && cc.body.USTC.USD);
  }
  return { uluna: lunc || null, uusd: ustc || null };
}
const assetId = (info) => info && (info.token ? info.token.contract_addr : info.native_token ? info.native_token.denom : null);

// Market data sources (both optional): GeckoTerminal ("terra" = Terra Classic there) and DexScreener if it lists the chain.
async function gtPools(ca) {
  for (const net of ["terra", "terra-classic"]) {
    const r = await jget(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${ca}/pools?page=1`, 6000);
    const d = r.body && r.body.data;
    if (Array.isArray(d) && d.length) return { net, pools: d.map((p) => ({ ...p.attributes, dex: p.relationships && p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id, base: p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id })) };
  }
  return null;
}
async function dsPair(ca) {
  const r = await jget("https://api.dexscreener.com/latest/dex/tokens/" + ca, 5000);
  const ps = ((r.body && r.body.pairs) || []).filter((p) => /terra.?classic|columbus/i.test(p.chainId || ""));
  return ps.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] || null;
}

// On-chain pool: reserves, LP token and USD liquidity.
async function poolOf(pairAddr, ca, px) {
  const [pool, pair] = await Promise.all([smart(pairAddr, { pool: {} }), smart(pairAddr, { pair: {} })]);
  if (!pool || !Array.isArray(pool.assets) || pool.assets.length !== 2) return null;
  const mine = pool.assets.find((a) => assetId(a.info) === ca), other = pool.assets.find((a) => assetId(a.info) !== ca);
  if (!mine || !other) return null;
  const oid = assetId(other.info), oUsd = px[oid] || null;
  const otherAmt = Number(other.amount) / 1e6; // uluna / uusd use 6 decimals
  return { pair: pairAddr, lpToken: pair && pair.liquidity_token, totalShare: Number(pool.total_share) || 0, other: oid, otherNative: !!(other.info && other.info.native_token), otherAmt,
    tokenRaw: Number(mine.amount), liqUsd: oUsd ? otherAmt * oUsd * 2 : null, otherUsd: oUsd };
}

// Pools for a token, best (most USD liquidity) first. Used by the swap quote endpoint. Cached per warm instance.
const poolCache = new Map();
async function findPools(ca) {
  const h = poolCache.get(ca);
  if (h && Date.now() - h.t < 300000) return h.v;
  const [gt, ds, bals, px] = await Promise.all([gtPools(ca), dsPair(ca), allBalances(ca, 3), prices()]);
  const cand = new Set();
  (gt && gt.pools || []).slice(0, 4).forEach((p) => p.address && isAddr(p.address) && cand.add(p.address));
  if (ds && ds.pairAddress && isAddr(ds.pairAddress)) cand.add(ds.pairAddress);
  // Pools are usually among the biggest holders; a pool query on a plain wallet just fails.
  if (bals) [...bals.out.entries()].sort((x, y) => y[1] - x[1]).filter((e) => !BURN.has(e[0])).slice(0, 6).forEach((e) => cand.add(e[0]));
  const v = (await Promise.all([...cand].slice(0, 9).map((p) => poolOf(p, ca, px).catch(() => null)))).filter(Boolean)
    .sort((a, b) => (b.liqUsd || 0) - (a.liqUsd || 0));
  poolCache.set(ca, { t: Date.now(), v });
  if (poolCache.size > 300) poolCache.delete(poolCache.keys().next().value);
  return v;
}

async function runTerra(input, depth = 0) {
  let ca = String(input || "").trim().toLowerCase();
  if (!isTerraId(ca)) throw fail(400, "Send a Terra Classic CW20 token contract address (terra1...).");

  const ci = await lcd(`/cosmwasm/wasm/v1/contract/${ca}`);
  if (!ci) throw fail(502, "Terra Classic nodes did not answer. Try again.");
  if (ci.notFound || !ci.contract_info) throw fail(404, "That is not a token contract on Terra Classic (columbus-5). Wallet addresses and Terra 2.0 tokens can't be scanned.");
  let ti = await smart(ca, { token_info: {} });
  if (!ti) {
    // Maybe a pair address was pasted: scan the token side of the pool instead.
    const pool = depth ? null : await smart(ca, { pool: {} });
    const tok = pool && Array.isArray(pool.assets) && pool.assets.map((a) => a.info && a.info.token && a.info.token.contract_addr).find(Boolean);
    if (tok && isTerraId(tok)) return runTerra(tok, 1);
    throw fail(400, "This Terra Classic contract is not a CW20 token.");
  }
  const C = ci.contract_info, dec = Number(ti.decimals) || 0, supply = Number(ti.total_supply) || 0;
  const human = (raw) => raw / 10 ** dec;

  const [minter, mkt, bals, gt, ds, px] = await Promise.all([
    smart(ca, { minter: {} }), smart(ca, { marketing_info: {} }), allBalances(ca), gtPools(ca), dsPair(ca), prices(),
  ]);

  // Pairs: from market APIs, plus any contract among the top holders that answers like a pool.
  const holders = bals ? [...bals.out.entries()].map(([a, v]) => ({ a, v })).sort((x, y) => y.v - x.v) : [];
  const cand = new Set();
  (gt && gt.pools || []).slice(0, 4).forEach((p) => p.address && isAddr(p.address) && cand.add(p.address));
  if (ds && ds.pairAddress && isAddr(ds.pairAddress)) cand.add(ds.pairAddress);
  holders.filter((h) => !BURN.has(h.a)).slice(0, 6).forEach((h) => cand.add(h.a));
  const pools = (await Promise.all([...cand].slice(0, 9).map((p) => poolOf(p, ca, px).catch(() => null)))).filter(Boolean);
  const pairSet = new Set(pools.map((p) => p.pair));
  pools.sort((a, b) => (b.liqUsd || 0) - (a.liqUsd || 0));
  const best = pools[0] || null;

  // Market: DexScreener > GeckoTerminal > on-chain pool.
  const g0 = gt && gt.pools && (gt.pools.find((p) => best && p.address === best.pair) || gt.pools[0]);
  let price = null, market = null;
  if (best && best.otherUsd && best.tokenRaw > 0) price = (best.otherAmt * best.otherUsd) / human(best.tokenRaw);
  if (ds) {
    market = { price: ds.priceUsd, liquidity: ds.liquidity && ds.liquidity.usd, fdv: ds.fdv, marketCap: ds.marketCap, volume24h: ds.volume && ds.volume.h24,
      change24h: ds.priceChange && ds.priceChange.h24, pairCreatedAt: ds.pairCreatedAt, dex: ds.dexId, url: ds.url };
  } else if (g0) {
    const mineIsBase = String(g0.base || "").endsWith(ca);
    const p = Number(mineIsBase ? g0.base_token_price_usd : g0.quote_token_price_usd) || price;
    const ch = g0.price_change_percentage && Number(g0.price_change_percentage.h24);
    market = { price: p ? String(p) : null, liquidity: Number(g0.reserve_in_usd) || (best && best.liqUsd) || null, fdv: p ? human(supply) * p : null, marketCap: Number(g0.market_cap_usd) || null,
      volume24h: g0.volume_usd && Number(g0.volume_usd.h24), change24h: mineIsBase && Number.isFinite(ch) ? ch : null,
      pairCreatedAt: g0.pool_created_at ? Date.parse(g0.pool_created_at) : null, dex: g0.dex || "terraswap", url: `https://www.geckoterminal.com/${gt.net}/pools/${g0.address}` };
  } else if (best && price) {
    market = { price: String(price), liquidity: best.liqUsd, fdv: human(supply) * price, marketCap: null, volume24h: null, change24h: null, pairCreatedAt: null, dex: "on-chain pool", url: null };
  }

  const R = [], add = (sev, title, detail) => R.push({ sev, title, detail: detail || "" });
  const pc = (n) => n.toFixed(1) + "%", pctSup = (v) => (supply > 0 ? (v / supply) * 100 : 0);

  // Contract controls
  if (C.admin) add("high", "Contract can be upgraded", `Admin ${C.admin} can migrate the contract to new code at any time, which can change balances or block selling.${C.admin === C.creator ? " The admin is the creator." : ""}`);
  else add("ok", "Contract is immutable (no admin)");
  if (minter && minter.minter && !BURN.has(minter.minter)) {
    const cap = minter.cap ? Number(minter.cap) : null;
    if (cap && supply >= cap) add("ok", "Mint cap reached", "A minter exists but the supply is already at its cap.");
    else add("high", "Supply can be increased", `Minter ${minter.minter} can create new tokens${cap ? ` up to ${human(cap).toLocaleString("en-US")}` : " with no cap"}.`);
  } else if (minter === undefined) add("info", "Could not check the minter");
  else add("ok", "No minter, supply is fixed");
  if (mkt && mkt.marketing && !BURN.has(mkt.marketing)) add("info", "Metadata can be changed", `Marketing address ${mkt.marketing} can change the logo, description and project link.`);

  // Holders
  const burnedV = holders.filter((h) => BURN.has(h.a)).reduce((a, b) => a + b.v, 0);
  if (pctSup(burnedV) >= 1) add("ok", `${pc(pctSup(burnedV))} of supply burned`);
  const creatorBal = bals ? bals.out.get(C.creator) || 0 : null;
  if (creatorBal !== null) {
    const cp = pctSup(creatorBal);
    if (cp >= 20) add("high", `Creator wallet holds ${pc(cp)}`, `Check ${FINDER}${C.creator}`);
    else if (cp >= 5) add("medium", `Creator wallet holds ${pc(cp)}`, `Check ${FINDER}${C.creator}`);
    else add("ok", `Creator wallet holds ${pc(cp)}`);
  }
  let top = [], topAcc = null;
  if (bals) {
    const n = holders.length;
    add(n < 50 ? "medium" : n < 200 ? "low" : "ok", `${n.toLocaleString("en-US")}${bals.complete ? "" : "+"} holders`);
    const th = holders.filter((h) => !BURN.has(h.a) && !pairSet.has(h.a)).slice(0, 10);
    top = th.map((h) => pctSup(h.v)); topAcc = th[0] && th[0].a;
    if (top.length) {
      const t10 = top.reduce((a, b) => a + b, 0), cx = th[0] && (await isContract(th[0].a)) ? " It is a contract (staking, vesting or a locker), check what it is." : "";
      add(top[0] >= 30 ? "high" : top[0] >= 15 ? "medium" : "ok", `Largest wallet holds ${pc(top[0])}`, `Top 10 wallets ${pc(t10)}. Pools and burn wallet excluded.${cx} Check ${FINDER}${topAcc}`);
      if (t10 >= 70) add("high", `Top 10 wallets hold ${pc(t10)}`); else if (t10 >= 50) add("medium", `Top 10 wallets hold ${pc(t10)}`);
    }
  } else add("info", "Holder list unavailable");

  // Liquidity ownership: who holds the LP tokens of the main pool.
  let lpInfo = null;
  if (best && best.lpToken && isAddr(best.lpToken)) {
    const lb = await allBalances(best.lpToken, 2).catch(() => null);
    const tot = best.totalShare || (lb ? [...lb.out.values()].reduce((a, b) => a + b, 0) : 0);
    if (lb && tot > 0 && lb.out.size) {
      const hs = [...lb.out.entries()].map(([a, v]) => ({ a, v, p: (v / tot) * 100 })).sort((x, y) => y.v - x.v);
      const burned = hs.filter((h) => BURN.has(h.a)).reduce((a, b) => a + b.p, 0);
      const t = hs[0], tc = !BURN.has(t.a) && (await isContract(t.a));
      lpInfo = { burned: +burned.toFixed(1), topPct: +t.p.toFixed(1), topContract: tc, top: t.a, providers: hs.length };
      if (burned >= 90) add("ok", `${pc(Math.min(100, burned))} of liquidity is burned`, "LP tokens were sent to the burn wallet. That liquidity cannot be pulled.");
      else if (t.p >= 50 && BURN.has(t.a)) add("ok", `Largest LP holder (${t.p.toFixed(0)}%) is the burn wallet`);
      else if (t.p >= 50 && tc) add("medium", `${t.p.toFixed(0)}% of liquidity sits in a contract`, `Usually a liquidity locker or farm. Check its unlock date and admin. ${FINDER}${t.a}`);
      else if (t.p >= 50) add(t.p >= 80 ? "high" : "medium", `One wallet controls ${t.p.toFixed(0)}% of the liquidity`, `Not burned or locked. That wallet can withdraw the pool at any time. ${FINDER}${t.a}`);
      else add("ok", `Liquidity is spread across ${hs.length} providers`);
    }
  }
  if (!best && !market) add("info", "No liquidity pool found", "No Terraswap/Terraport pool was found for this token.");
  if (market) {
    const liq = market.liquidity;
    if (typeof liq === "number" && liq > 0) add(liq < 5000 ? "high" : liq < 25000 ? "medium" : "ok", `Liquidity $${Math.round(liq).toLocaleString("en-US")} on ${market.dex}`);
    if (typeof liq === "number" && liq < 1000) add("medium", "Under $1,000 of liquidity", "Almost nothing to trade against. Any buy or sell moves the price heavily and exits may be impossible.");
    if (market.pairCreatedAt) { const days = (Date.now() - market.pairCreatedAt) / 864e5; if (days < 1) add("high", "Pair is less than 24 hours old"); else if (days < 7) add("low", `New pair (${Math.round(days)} days old)`); }
    const fdv = market.fdv || market.marketCap;
    if (liq && fdv && liq / fdv < 0.005) add("medium", "Very thin liquidity compared to market cap");
    if (typeof market.change24h === "number" && market.change24h <= -50) add("high", `Price down ${Math.abs(market.change24h).toFixed(0)}% in 24h`);
  }

  let score = 100;
  for (const r of R) score -= PTS[r.sev] || 0;
  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 80 ? "Low risk" : score >= 60 ? "Moderate risk" : score >= 40 ? "High risk" : "Very high risk";
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4, ok: 5 };
  R.sort((a, b) => order[a.sev] - order[b.sev]);

  const links = {};
  const proj = mkt && mkt.project; if (proj && /^https:\/\//.test(proj)) links.web = String(proj).slice(0, 300);
  if (ds && ds.info) { (ds.info.websites || []).slice(0, 1).forEach((w) => { links.web = links.web || w.url; }); (ds.info.socials || []).forEach((s) => { if (s.type === "twitter") links.x = s.url; if (s.type === "telegram") links.tg = s.url; }); }
  const logo = (ds && ds.info && ds.info.imageUrl) || (mkt && mkt.logo && mkt.logo.url && /^https:\/\//.test(mkt.logo.url) ? mkt.logo.url : null);
  const dexInfo = ds ? dexPaid(await getOrders(ds.chainId, ca).catch(() => null), ds) : null;
  return {
    ok: true, chain: "terraclassic", address: ca, ts: Date.now(),
    token: { name: ti.name || "Unknown token", symbol: ti.symbol || "", logo },
    market, links, flags: { admin: C.admin || null, mint: !!(minter && minter.minter && !(minter.cap && supply >= Number(minter.cap))) },
    deep: null, lp: null, dex: dexInfo,
    terraInfo: { admin: C.admin || null, creator: C.creator, codeId: C.code_id, label: C.label || null, minter: (minter && minter.minter) || null, lp: lpInfo, pair: best && best.pair, quote: best && best.other },
    score, verdict, confidence: market && bals ? "high" : "medium", reasons: R,
    sources: { terra: true, geckoterminal: !!gt, dexscreener: !!ds },
  };
}

module.exports = { runTerra, isTerraId, bech32, bechValid, allBalances, findPools, smart, lcd, FINDER, isContract, isAddr };
