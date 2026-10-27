// XRP Ledger (native issued tokens) scanner. Token id = "CODE.rIssuer". No API keys needed: public XRPL JSON-RPC + DexScreener.
const RPCS = ["https://xrplcluster.com", "https://s1.ripple.com:51234"];
const BLACKHOLE = new Set(["rrrrrrrrrrrrrrrrrrrrrhoLvTp", "rrrrrrrrrrrrrrrrrrrrBZbvji", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"]);
const ISSUER_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const ID_RE = /^([A-Za-z0-9]{1,20}|[0-9A-Fa-f]{40})\.(r[1-9A-HJ-NP-Za-km-z]{24,34})$/;

const fail = (status, message) => Object.assign(new Error(message), { status });
const { getOrders, dexPaid } = require("./dexpaid");
const db = require("./db");

/**
 * Issuer domain verification (XLS-26 / xrp-ledger.toml): the issuer points to a domain with its Domain field,
 * and that domain confirms the issuer in https://<domain>/.well-known/xrp-ledger.toml. Both directions must match.
 */
async function verifyDomain(host, issuer) {
  host = String(host || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  // Only real public hostnames (no IPs, ports or localhost), so the server can't be pointed at internal addresses.
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(host)) return { domain: host || null, verified: null };
  const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
  try {
    const r = await fetch(`https://${host}/.well-known/xrp-ledger.toml`, { signal: c.signal, redirect: "follow", headers: { accept: "text/plain, application/toml, */*" } });
    if (!r.ok) return { domain: host, verified: false };
    const txt = (await r.text()).slice(0, 200000);
    const re = new RegExp(`(address|issuer)\\s*=\\s*["']${issuer}["']`);
    return { domain: host, verified: re.test(txt) };
  } catch (e) { return { domain: host, verified: false }; } finally { clearTimeout(t); }
}
async function onXrplaunch(issuer) {
  if (!db.on()) return null;
  try { const r = await db.select("launches", "select=issuer,created_at&issuer=eq." + db.enc(issuer) + "&limit=1"); return !!(r && r[0]); } catch (e) { return null; }
}
const isXrplId = (s) => ID_RE.test(s) || ISSUER_RE.test(s);

function decodeCode(c) {
  if (/^[0-9A-Fa-f]{40}$/.test(c)) {
    const b = Buffer.from(c, "hex"), s = b.toString("utf8").replace(/\0+$/g, "");
    if (s && /^[\x20-\x7e]+$/.test(s)) return s;
    return c.slice(0, 8).toUpperCase();
  }
  return c;
}
function encodeCode(c) {
  if (/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
  if (c.length === 3) return c;
  return Buffer.from(c, "utf8").toString("hex").toUpperCase().padEnd(40, "0");
}

async function rpc(method, params, ms = 6000) {
  for (const base of RPCS) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(base, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.result) return j.result;
    } catch (e) { /* try next */ } finally { clearTimeout(t); }
  }
  return null;
}
const jget = async (u, ms = 7000) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json" } }); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
};

async function allLines(account, cur, pages = 3) {
  const out = []; let marker, n = 0;
  do {
    const r = await rpc("account_lines", { account, ledger_index: "validated", limit: 400, ...(marker ? { marker } : {}) }, 8000);
    if (!r || !r.lines) return n === 0 ? null : out;
    r.lines.forEach((l) => { if (!cur || l.currency === cur) out.push(l); });
    marker = r.marker; n++;
  } while (marker && n < pages);
  return out;
}

async function xrpUsd() {
  const a = await jget("https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd", 4000);
  if (a && a.ripple && a.ripple.usd) return a.ripple.usd;
  const b = await jget("https://api.coinbase.com/v2/prices/XRP-USD/spot", 4000);
  return b && b.data && parseFloat(b.data.amount) || null;
}

async function dexPair(code, hex, issuer) {
  const ids = Array.from(new Set([`${code}.${issuer}`, `${hex}.${issuer}`]));
  for (const id of ids) {
    for (const u of [`https://api.dexscreener.com/tokens/v1/xrpl/${encodeURIComponent(id)}`, `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(id)}`]) {
      const j = await jget(u);
      const arr = Array.isArray(j) ? j : j && j.pairs;
      const ps = (arr || []).filter((p) => p && p.chainId === "xrpl" && JSON.stringify([p.baseToken, p.quoteToken]).toLowerCase().includes(issuer.toLowerCase()));
      if (ps.length) return ps.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
    }
  }
  return null;
}

/** Can this account still sign anything? Blackholed = master key off, no usable regular key, no signer list. */
function acctState(ai) {
  const d = ai && ai.account_data;
  if (!d) return null;
  const F = d.Flags || 0, master = (F & 0x00100000) === 0;
  const sl = (d.signer_lists || ai.signer_lists || []).length > 0;
  const key = d.RegularKey && !BLACKHOLE.has(d.RegularKey) ? d.RegularKey : null;
  return { blackholed: !master && !key && !sl, master, key, signers: sl };
}
const PTS = { critical: 100, high: 25, medium: 10, low: 4, info: 0, ok: 0 };
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

async function runXrpl(input) {
  const raw = String(input || "").trim();
  let code, issuer;
  const m = raw.match(ID_RE);
  if (m) { code = m[1]; issuer = m[2]; }
  else if (ISSUER_RE.test(raw)) issuer = raw;
  else throw fail(400, "Send an XRPL token as CODE.rIssuerAddress, for example SOLO.rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz");

  const [ai, gb] = await Promise.all([
    rpc("account_info", { account: issuer, ledger_index: "validated", signer_lists: true }),
    rpc("gateway_balances", { account: issuer, ledger_index: "validated", hotwallet: [] }),
  ]);
  if (!ai) throw fail(502, "XRP Ledger did not answer. Try again.");
  if (ai.error === "actNotFound" || !ai.account_data) throw fail(404, "That issuer account does not exist on the XRP Ledger.");
  const ob = (gb && gb.obligations) || {};
  if (!code) {
    const best = Object.keys(ob).sort((a, b) => parseFloat(ob[b]) - parseFloat(ob[a]))[0];
    if (!best) throw fail(404, "This account has not issued any tokens. Send the token as CODE.rIssuer.");
    code = decodeCode(best);
  }
  const hex = encodeCode(code), label = decodeCode(hex);
  const supply = num(ob[hex]);
  if (supply === null && !(gb && gb.obligations)) { /* gateway_balances failed: continue with partial data */ }

  const [lines, amm, pair] = await Promise.all([
    allLines(issuer, hex, 3),
    rpc("amm_info", { asset: { currency: "XRP" }, asset2: { currency: hex, issuer }, ledger_index: "validated" }),
    dexPair(label, hex, issuer),
  ]);
  const A = amm && amm.amm ? amm.amm : null;
  const ammAcc = A && A.account;
  const lpLines = A && A.lp_token ? await allLines(ammAcc, A.lp_token.currency, 1) : null;

  const d = ai.account_data, F = d.Flags || 0, has = (f) => (F & f) !== 0;
  const sl = (d.signer_lists || ai.signer_lists || []).length > 0;
  const noKey = !d.RegularKey || BLACKHOLE.has(d.RegularKey);
  const blackholed = has(0x00100000) && noKey && !sl;
  const rate = d.TransferRate && d.TransferRate > 1e9 ? (d.TransferRate - 1e9) / 1e7 : 0;
  let web = null, domainRaw = null;
  if (d.Domain) { try { domainRaw = Buffer.from(d.Domain, "hex").toString("utf8"); web = "https://" + domainRaw.replace(/^https?:\/\//, ""); } catch (e) { /* ignore */ } }
  // Hype / trust info (never scored): DexScreener paid status, verified issuer domain, launched on XRPLabs.
  const [orders, dom, launched] = await Promise.all([
    pair && pair.baseToken ? getOrders("xrpl", pair.baseToken.address) : Promise.resolve(null),
    domainRaw ? verifyDomain(domainRaw, issuer) : Promise.resolve({ domain: null, verified: null }),
    onXrplaunch(issuer),
  ]);
  const dexInfo = pair ? dexPaid(orders, pair) : null;

  // holders: lines seen from the issuer, negative balance = the holder owns tokens
  let holders = null, top = [], poolPct = 0, topAcc = null;
  if (lines && supply > 0) {
    const hs = lines.map((l) => ({ a: l.account, v: -parseFloat(l.balance) })).filter((x) => x.v > 0);
    holders = hs.length;
    hs.sort((x, y) => y.v - x.v);
    const pool = ammAcc ? hs.find((x) => x.a === ammAcc) : null;
    poolPct = pool ? (pool.v / supply) * 100 : 0;
    const th = hs.filter((x) => x.a !== ammAcc).slice(0, 10);
    top = th.map((x) => (x.v / supply) * 100); topAcc = th[0] && th[0].a;
  }

  // market: DexScreener first, AMM reserves as fallback
  let market = null;
  if (pair) {
    market = { price: pair.priceUsd, liquidity: pair.liquidity && pair.liquidity.usd, fdv: pair.fdv, marketCap: pair.marketCap,
      volume24h: pair.volume && pair.volume.h24, change24h: pair.priceChange && pair.priceChange.h24, pairCreatedAt: pair.pairCreatedAt, dex: pair.dexId, url: pair.url };
  } else if (A && typeof A.amount === "string" && A.amount2) {
    const xrp = parseFloat(A.amount) / 1e6, tok = parseFloat(A.amount2.value || A.amount2), usd = await xrpUsd();
    if (usd && tok > 0) market = { price: String((xrp / tok) * usd), liquidity: xrp * 2 * usd, fdv: supply ? supply * (xrp / tok) * usd : null, marketCap: supply ? supply * (xrp / tok) * usd : null, volume24h: null, change24h: null, pairCreatedAt: null, dex: "xrpl-amm", url: null };
  }

  const R = [];
  const add = (sev, title, detail) => R.push({ sev, title, detail: detail || "" });
  if (dom.verified) add("ok", `Issuer domain verified: ${dom.domain}`, "The issuer links to this domain and the domain's xrp-ledger.toml confirms the issuer.");
  else if (dom.domain) add("info", `Issuer domain not verified: ${dom.domain}`, "The issuer points to this domain, but the domain does not confirm the issuer in its xrp-ledger.toml. Anyone can set any domain.");
  if (launched) add("ok", "Launched on XRPLabs", "Created through XRPLabs by CBL: issuer blackholed and launch liquidity locked at creation.");
  const pc = (n) => n.toFixed(1) + "%";
  if (has(0x00400000)) add("critical", "Issuer froze all trading", "Global freeze is switched on for this issuer.");
  if (blackholed) add("ok", "Issuer is blackholed", "The issuer can no longer create more tokens or change settings.");
  else {
    add("high", "Issuer can still create more tokens", "The issuer account is not blackholed, so it can issue new supply at any time.");
    if (!has(0x00200000)) add("medium", "Issuer can freeze holders", "No-freeze is not set, so the issuer can freeze individual wallets.");
  }
  if (has(0x00200000) && !blackholed) add("ok", "Issuer cannot freeze trustlines", "No-freeze is permanently set.");
  if (has(0x80000000)) add("high", "Issuer can claw back tokens", "Clawback is enabled, so the issuer can take tokens from holders.");
  if (has(0x00040000)) add("high", "Holders need issuer approval", "Require-auth is on, so the issuer decides who can hold or sell.");
  if (rate > 0) add(rate >= 5 ? "high" : rate >= 1 ? "medium" : "low", `Transfer fee ${rate.toFixed(2)}%`, "Charged by the issuer on every transfer of this token.");
  else add("ok", "No transfer fee");
  if (holders !== null) {
    add(holders < 50 ? "medium" : holders < 200 ? "low" : "ok", `${holders.toLocaleString("en-US")} holders`);
    if (top.length) {
      add(top[0] >= 30 ? "high" : top[0] >= 15 ? "medium" : "ok", `Largest wallet holds ${pc(top[0])}`, `Top 10 wallets ${pc(top.reduce((a, b) => a + b, 0))}. Pool excluded. Check https://xrpscan.com/account/${topAcc}`);
      const t10 = top.reduce((a, b) => a + b, 0);
      if (t10 >= 70) add("high", `Top 10 wallets hold ${pc(t10)}`);
      else if (t10 >= 50) add("medium", `Top 10 wallets hold ${pc(t10)}`);
    }
  } else add("info", "Holder list unavailable");
  let lpInfo = null;
  if (A && lpLines) {
    const lpSupply = num(A.lp_token && A.lp_token.value);
    const hs = lpLines.map((l) => ({ a: l.account, v: -parseFloat(l.balance) })).filter((x) => x.v > 0).sort((x, y) => y.v - x.v);
    if (lpSupply > 0 && hs.length) {
      // Burned = LP tokens sitting on a blackhole address. Locked = LP held by a blackholed wallet that can never sign a withdrawal.
      const pctOf = (x) => (x.v / lpSupply) * 100, f0 = (n) => (n >= 99.5 && n < 99.95 ? n.toFixed(1) : n.toFixed(0)) + "%";
      const burned = hs.filter((x) => BLACKHOLE.has(x.a)).reduce((a, b) => a + pctOf(b), 0);
      const look = hs.filter((x) => !BLACKHOLE.has(x.a) && pctOf(x) >= 2).slice(0, 5);
      const st = await Promise.all(look.map((x) => x.a === issuer ? Promise.resolve({ blackholed, master: !has(0x00100000), key: null, signers: sl }) : rpc("account_info", { account: x.a, ledger_index: "validated", signer_lists: true }).then(acctState)));
      const S = new Map(look.map((x, i) => [x.a, st[i]]));
      const locked = look.filter((x) => S.get(x.a) && S.get(x.a).blackholed).reduce((a, b) => a + pctOf(b), 0);
      const safe = Math.min(100, burned + locked), top = hs[0], t = pctOf(top), ts = S.get(top.a);
      const topSafe = BLACKHOLE.has(top.a) || (ts && ts.blackholed);
      lpInfo = { burned: +burned.toFixed(1), locked: +locked.toFixed(1), safe: +safe.toFixed(1), topPct: +t.toFixed(1), topSafe: !!topSafe, top: top.a, checked: !!ts || BLACKHOLE.has(top.a), providers: hs.length };
      const how = [burned > 0.5 ? `${f0(burned)} burned (sent to a blackhole address)` : "", locked > 0.5 ? `${f0(locked)} held by blackholed wallet${look.filter((x) => S.get(x.a) && S.get(x.a).blackholed).length > 1 ? "s" : ""} that can never sign a withdrawal` : ""].filter(Boolean).join(", ");
      const link = `Check https://xrpscan.com/account/${top.a}`, cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : "");
      if (safe >= 90) add("ok", `${f0(safe)} of liquidity is burned or locked forever`, cap(how) + ". It cannot be pulled.");
      else if (t >= 50 && !topSafe) {
        const why = !ts ? "Could not check this wallet's keys, so assume it can withdraw the pool."
          : ts.key ? "Master key is off, but a regular key can still sign, so it is NOT blackholed and can withdraw the pool."
          : ts.signers ? "Controlled by a multisig signer list, so it is NOT blackholed and can withdraw the pool."
          : "Not blackholed and not burned. That wallet can withdraw the pool at any time.";
        add(t >= 80 ? "high" : "medium", `One wallet controls ${t.toFixed(0)}% of the liquidity`, `${why} ${link}`);
      } else if (topSafe && t >= 50) {
        add("ok", `Largest LP wallet (${t.toFixed(0)}%) is ${BLACKHOLE.has(top.a) ? "a blackhole address (burned)" : "blackholed"}`, `That share can never be withdrawn. ${f0(safe)} of liquidity is burned or locked in total.`);
      } else {
        add("ok", `Liquidity is spread across ${hs.length} providers`);
        if (safe > 0.5) add("info", `${f0(safe)} of liquidity is burned or locked`, cap(how) + ".");
      }
      if (safe < 0.5 && !(t >= 50)) add("info", "Liquidity is not burned or locked", "No LP tokens are burned or held by blackholed wallets.");
    }
  } else if (!A) add("info", "No AMM pool found", "The token may trade only on the order book. Liquidity numbers can be misleading.");
  if (market) {
    const liq = market.liquidity;
    if (typeof liq === "number") add(liq < 5000 ? "high" : liq < 25000 ? "medium" : "ok", `Liquidity $${Math.round(liq).toLocaleString("en-US")} on ${market.dex}`);
    if (typeof liq === "number" && liq < 1000) add("medium", "Under $1,000 of liquidity", "Almost nothing to trade against. Any buy or sell moves the price heavily and exits may be impossible.");
    if (market.pairCreatedAt) { const days = (Date.now() - market.pairCreatedAt) / 864e5; if (days < 1) add("high", "Pair is less than 24 hours old"); else if (days < 7) add("low", `New pair (${Math.round(days)} days old)`); }
    const fdv = market.fdv || market.marketCap;
    if (liq && fdv && liq / fdv < 0.005) add("medium", "Very thin liquidity compared to market cap");
    if (typeof market.change24h === "number" && market.change24h <= -50) add("high", `Price down ${Math.abs(market.change24h).toFixed(0)}% in 24h`);
  } else add("info", "No market data found", "DexScreener and the AMM pool returned nothing for this token.");

  let score = 100;
  for (const r of R) score -= PTS[r.sev] || 0;
  score = Math.max(0, Math.min(100, score));
  const critical = R.some((r) => r.sev === "critical");
  if (critical) score = Math.min(score, 20);
  const verdict = critical ? "Critical risk" : score >= 80 ? "Low risk" : score >= 60 ? "Moderate risk" : score >= 40 ? "High risk" : "Very high risk";
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4, ok: 5 };
  R.sort((a, b) => order[a.sev] - order[b.sev]);

  const links = {};
  if (web) links.web = web;
  if (pair && pair.info) { (pair.info.websites || []).slice(0, 1).forEach((w) => { links.web = links.web || w.url; }); (pair.info.socials || []).forEach((s) => { if (s.type === "twitter") links.x = s.url; if (s.type === "telegram") links.tg = s.url; }); }
  return {
    ok: true, chain: "xrpl", address: `${label}.${issuer}`, issuer, hex, ts: Date.now(),
    token: { name: label, symbol: label, logo: (pair && pair.info && pair.info.imageUrl) || null },
    market, links, flags: {}, deep: null, lp: lpInfo, dex: dexInfo, xrplInfo: { domain: dom.domain, domainVerified: dom.verified, xrplaunch: launched },
    score, verdict, confidence: pair ? "high" : "medium", reasons: R,
    sources: { dexscreener: !!pair, xrpl: true },
  };
}

module.exports = { runXrpl, isXrplId, ID_RE, ISSUER_RE, encodeCode, decodeCode };
