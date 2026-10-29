// Wallet tracker: buys, sells, new tokens and big transfers for any wallet, on the scanner's chains.
// Used by the Telegram bot (/track, /wallet, 👤 Track dev) and by /api/cron?job=wallets (alerts every 5 minutes).
//
// Data sources (no indexer of our own):
//   EVM      Etherscan V2 (ETHERSCAN_API_KEY, one key for all chains), with free fallbacks:
//            Blockscout (Ethereum, Base, Optimism, Arbitrum, Polygon, Scroll, zkSync, Robinhood) and Routescan (Avalanche).
//   Solana   Helius (HELIUS_API_KEY), parsed address history.
//   XRPL     public XRP Ledger nodes, account_tx.
//   Terra    public Terra Classic LCD, tx search by sender.
// Every tx is reduced to "how did this wallet's balances change", then classified:
//   token up + base (native/stable) down = buy, token down + base up = sell, token A down + token B up = swap,
//   wallet deployed a contract / created a mint / opened an AMM pool = new token, token only leaving = transfer.
const db = require("./db");
const { EVM } = require("./scanner");
const { decodeCode } = require("./xrpl");
const { lcd, smart } = require("./terra");

const MAX_TRACK = 10, MAX_EVM_CHAINS = 6, MAX_AGE = 30 * 60; // never alert on anything older than 30 minutes
const now = () => Math.floor(Date.now() / 1000);
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");

// ---------- address families ----------
const RE = {
  evm: /^0x[a-fA-F0-9]{40}$/,
  terraclassic: /^terra1[02-9ac-hj-np-z]{38}$/,
  xrpl: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};
function familyOf(a) {
  a = String(a || "").trim();
  if (RE.evm.test(a)) return "evm";
  if (RE.terraclassic.test(a.toLowerCase())) return "terraclassic";
  if (RE.xrpl.test(a)) return "xrpl";
  if (RE.solana.test(a)) return "solana";
  return null;
}
const normAddr = (a) => { a = String(a || "").trim(); return /^(0x|terra1)/i.test(a) ? a.toLowerCase() : a; };

// ---------- small fetch helpers ----------
async function jget(u, ms = 7000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; CBLScanner/1.0; +https://cryptobarlounge.space)" } }); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
async function jpost(u, body, ms = 8000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- EVM ----------
const NATIVE = { ethereum: "ETH", base: "ETH", arbitrum: "ETH", optimism: "ETH", linea: "ETH", blast: "ETH", zksync: "ETH", scroll: "ETH", unichain: "ETH", robinhood: "ETH",
  bsc: "BNB", polygon: "POL", avalanche: "AVAX", mantle: "MNT", sonic: "S", cronos: "CRO" };
const BASE_SYM = /^(W?ETH|WEETH|W?BNB|W?POL|W?MATIC|W?AVAX|W?MNT|W?S|W?CRO|USDC(\.E)?|USDBC|USDT0?|USDT\.E|DAI|BUSD|FDUSD|USDE|USD1|CRVUSD|FRXUSD|PYUSD|RLUSD)$/i;
const BLOCKSCOUT = { ethereum: "eth.blockscout.com", base: "base.blockscout.com", optimism: "optimism.blockscout.com", arbitrum: "arbitrum.blockscout.com",
  polygon: "polygon.blockscout.com", scroll: "scroll.blockscout.com", zksync: "zksync.blockscout.com", robinhood: "robinhoodchain.blockscout.com" };
function evmEndpoints(chain) {
  const L = [], key = clean(process.env.ETHERSCAN_API_KEY);
  if (key && EVM[chain] && chain !== "robinhood") L.push(`https://api.etherscan.io/v2/api?chainid=${EVM[chain]}&apikey=${key}&`);
  if (BLOCKSCOUT[chain]) L.push(`https://${BLOCKSCOUT[chain]}/api?`);
  if (chain === "avalanche") L.push("https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?");
  return L;
}
const skipEp = new Map(); // endpoint -> until (ms): e.g. a chain the free Etherscan plan doesn't cover
// Etherscan-compatible call. Returns an array (possibly empty) or null when no provider answered.
async function esCall(chain, params) {
  for (const base of evmEndpoints(chain)) {
    const host = base.split("?")[0] + "|" + chain;
    if ((skipEp.get(host) || 0) > Date.now()) continue;
    for (let k = 0; k < 2; k++) {
      const j = await jget(base + params);
      if (j && Array.isArray(j.result)) return j.result;
      const m = String((j && (j.result || j.message)) || "");
      if (/no (transactions|records) found/i.test(m)) return [];
      if (/rate limit|max calls/i.test(m) && k === 0) { await sleep(1100); continue; }
      if (/not supported|upgrade|free api access|invalid chain/i.test(m)) skipEp.set(host, Date.now() + 6 * 3600e3);
      break;
    }
  }
  return null;
}

/** Recent activity of an EVM wallet on one chain, newest first, only txs after cursor.ts. */
async function evmEvents(chain, addr, cur) {
  const a = addr.toLowerCase(), q = (action, n) => `module=account&action=${action}&address=${a}&startblock=0&endblock=99999999&page=1&offset=${n}&sort=desc`;
  const tok = await esCall(chain, q("tokentx", 100));
  if (tok === null) return null; // chain unavailable right now: keep the cursor, try again next run
  const [txs, internal] = [await esCall(chain, q("txlist", 50)), await esCall(chain, q("txlistinternal", 50))];
  const G = new Map(), cut = cur.ts || 0, seen = new Set(cur.h || []);
  const fresh = (ts, h) => ts > cut || (ts === cut && !seen.has(h));
  const grp = (h, ts) => { let e = G.get(h); if (!e) G.set(h, (e = { hash: h, ts, tok: {}, native: 0, created: null, to: {} })); return e; };
  for (const t of tok) {
    const ts = Number(t.timeStamp), h = String(t.hash).toLowerCase();
    if (!fresh(ts, h)) continue;
    const e = grp(h, ts), ca = String(t.contractAddress).toLowerCase(), dec = Number(t.tokenDecimal || 18);
    const amt = Number(t.value) / Math.pow(10, Number.isFinite(dec) ? dec : 18);
    const k = e.tok[ca] || (e.tok[ca] = { ca, sym: t.tokenSymbol || "", name: t.tokenName || "", amt: 0 });
    if (String(t.to).toLowerCase() === a) k.amt += amt;
    if (String(t.from).toLowerCase() === a) { k.amt -= amt; e.to[ca] = String(t.to).toLowerCase(); }
  }
  for (const x of txs || []) {
    const ts = Number(x.timeStamp), h = String(x.hash).toLowerCase();
    if (!fresh(ts, h) || x.isError === "1" || String(x.from).toLowerCase() !== a) continue;
    if (!x.to && x.contractAddress) { grp(h, ts).created = { ca: String(x.contractAddress).toLowerCase() }; continue; }
    if (G.has(h)) G.get(h).native -= Number(x.value) / 1e18;
  }
  for (const x of internal || []) {
    const ts = Number(x.timeStamp), h = String(x.hash).toLowerCase();
    if (!fresh(ts, h) || x.isError === "1" || String(x.to).toLowerCase() !== a || !G.has(h)) continue;
    G.get(h).native += Number(x.value) / 1e18;
  }
  const out = [];
  for (const e of G.values()) {
    const toks = Object.values(e.tok).filter((k) => Math.abs(k.amt) > 0);
    const base = toks.filter((k) => BASE_SYM.test(k.sym)), other = toks.filter((k) => !BASE_SYM.test(k.sym));
    const paid = [], got = [];
    if (e.native < -1e-9) paid.push({ sym: NATIVE[chain], amt: -e.native }); else if (e.native > 1e-9) got.push({ sym: NATIVE[chain], amt: e.native });
    base.forEach((k) => (k.amt < 0 ? paid : got).push({ sym: k.sym, amt: Math.abs(k.amt) }));
    const ev = classify(other.map((k) => ({ id: k.ca, sym: k.sym, name: k.name, amt: k.amt, to: e.to[k.ca] })), paid, got, e.created && { id: e.created.ca });
    ev.forEach((x) => out.push(Object.assign(x, { chain, hash: e.hash, ts: e.ts })));
  }
  return out;
}

/** Shared classifier. tokens: [{id, sym, amt(+in/-out)}], paid/got: base assets [{sym, amt}]. */
function classify(tokens, paid, got, created) {
  const ev = [], ins = tokens.filter((k) => k.amt > 0), outs = tokens.filter((k) => k.amt < 0);
  if (created) {
    const t = tokens.find((k) => k.id === created.id) || ins[0] || {};
    ev.push({ type: "create", token: { id: created.id, sym: t.sym || "", name: t.name || "" }, amt: t.amt > 0 ? t.amt : null, paid });
    return ev;
  }
  if (ins.length && outs.length) { ev.push({ type: "swap", token: tok(ins[0]), amt: ins[0].amt, from: { sym: outs[0].sym || short(outs[0].id), amt: -outs[0].amt, id: outs[0].id } }); return ev; }
  for (const k of ins) if (paid.length) ev.push({ type: "buy", token: tok(k), amt: k.amt, paid });
  for (const k of outs) {
    if (got.length) ev.push({ type: "sell", token: tok(k), amt: -k.amt, got });
    else ev.push({ type: "transfer", token: tok(k), amt: -k.amt, to: k.to || null });
  }
  return ev;
}
const tok = (k) => ({ id: k.id, sym: k.sym || "", name: k.name || "" });
const short = (a) => (a ? String(a).slice(0, 6) + "…" + String(a).slice(-4) : "");

/** Which EVM chains is this wallet active on (last 180 days)? Most recent first, capped. */
async function evmChains(addr) {
  const since = now() - 180 * 86400, hits = [], keys = Object.keys(EVM);
  for (let i = 0; i < keys.length; i += 4) {
    await Promise.all(keys.slice(i, i + 4).map(async (c) => {
      const r = await esCall(c, `module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=1&sort=desc`);
      const r2 = r && r.length ? r : await esCall(c, `module=account&action=tokentx&address=${addr}&startblock=0&endblock=99999999&page=1&offset=1&sort=desc`);
      const ts = r2 && r2[0] ? Number(r2[0].timeStamp) : 0;
      if (ts >= since) hits.push([c, ts]);
    }));
    if (i + 4 < keys.length) await sleep(250);
  }
  return hits.sort((x, y) => y[1] - x[1]).slice(0, MAX_EVM_CHAINS).map((x) => x[0]);
}

// ---------- Solana ----------
const SOL_BASE = { So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };
async function solEvents(addr, cur) {
  const key = clean(process.env.HELIUS_API_KEY);
  if (!key) return null;
  const list = await jget(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${key}&limit=50`, 9000);
  if (!Array.isArray(list)) return null;
  const cut = cur.ts || 0, seen = new Set(cur.h || []), out = [];
  for (const t of list) {
    const ts = Number(t.timestamp), h = t.signature;
    if (!(ts > cut || (ts === cut && !seen.has(h))) || t.transactionError) continue;
    const toks = {}; let sol = 0;
    for (const ad of t.accountData || []) {
      if (ad.account === addr) sol += Number(ad.nativeBalanceChange || 0) / 1e9;
      for (const b of ad.tokenBalanceChanges || []) {
        if (b.userAccount !== addr || !b.rawTokenAmount) continue;
        const amt = Number(b.rawTokenAmount.tokenAmount) / Math.pow(10, Number(b.rawTokenAmount.decimals || 0));
        toks[b.mint] = (toks[b.mint] || 0) + amt;
      }
    }
    if (t.feePayer === addr) sol += Number(t.fee || 0) / 1e9; // network fee is not a payment
    const paid = [], got = [], other = [];
    if (sol < -0.001) paid.push({ sym: "SOL", amt: -sol }); else if (sol > 0.001) got.push({ sym: "SOL", amt: sol });
    for (const [m, amt] of Object.entries(toks)) {
      if (!amt) continue;
      if (SOL_BASE[m]) (amt < 0 ? paid : got).push({ sym: SOL_BASE[m], amt: Math.abs(amt) });
      else other.push({ id: m, sym: "", amt, to: null });
    }
    const typ = String(t.type || ""), desc = String(t.description || "");
    let created = null;
    if (t.feePayer === addr && (/^CREATE/.test(typ) || /\bcreated?\b.*\b(token|coin|mint)\b/i.test(desc))) {
      const m = other.find((k) => k.amt > 0) || (t.tokenTransfers || []).find((x) => x.mint && !SOL_BASE[x.mint]);
      if (m) created = { id: m.id || m.mint };
    }
    if (created && !other.find((k) => k.id === created.id)) other.push({ id: created.id, sym: "", amt: 0 });
    for (const x of other) if (x.amt < 0) { const tr = (t.tokenTransfers || []).find((z) => z.mint === x.id && z.fromUserAccount === addr); x.to = tr ? tr.toUserAccount : null; }
    classify(other, paid, got, created).forEach((x) => out.push(Object.assign(x, { chain: "solana", hash: h, ts })));
  }
  return out;
}

// ---------- XRP Ledger ----------
const XRPL_RPC = ["https://xrplcluster.com", "https://s2.ripple.com:51234", "https://s1.ripple.com:51234"];
const RIPPLE_EPOCH = 946684800;
async function xrplRpc(method, params) {
  for (const u of XRPL_RPC) { const j = await jpost(u, { method, params: [params] }); if (j && j.result && j.result.status !== "error") return j.result; }
  return null;
}
async function xrplEvents(addr, cur) {
  const r = await xrplRpc("account_tx", { account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 40, forward: false });
  if (!r) return null;
  const cut = cur.ts || 0, seen = new Set(cur.h || []), out = [];
  for (const t of r.transactions || []) {
    const tx = t.tx_json || t.tx || {}, meta = t.meta || t.metaData, h = t.hash || tx.hash;
    if (!meta || meta.TransactionResult !== "tesSUCCESS") continue;
    const ts = t.close_time_iso ? Math.floor(Date.parse(t.close_time_iso) / 1000) : tx.date != null ? tx.date + RIPPLE_EPOCH : 0;
    if (!(ts > cut || (ts === cut && !seen.has(h)))) continue;
    let xrp = 0; const iou = {};
    for (const n of meta.AffectedNodes || []) {
      const b = n.ModifiedNode || n.CreatedNode || n.DeletedNode; if (!b) continue;
      const f = b.FinalFields || b.NewFields || {}, p = b.PreviousFields || {};
      if (b.LedgerEntryType === "AccountRoot" && f.Account === addr) {
        const fin = Number(f.Balance || 0), prev = n.CreatedNode ? 0 : p.Balance !== undefined ? Number(p.Balance) : fin;
        xrp += (fin - prev) / 1e6;
      } else if (b.LedgerEntryType === "RippleState" && f.Balance) {
        const lo = f.LowLimit && f.LowLimit.issuer, hi = f.HighLimit && f.HighLimit.issuer;
        if (lo !== addr && hi !== addr) continue;
        const sign = lo === addr ? 1 : -1, other = lo === addr ? hi : lo;
        const fin = n.DeletedNode ? 0 : Number(f.Balance.value) * sign, prev = n.CreatedNode ? 0 : p.Balance ? Number(p.Balance.value) * sign : fin;
        const id = f.Balance.currency + "." + other;
        iou[id] = (iou[id] || 0) + (fin - prev);
      }
    }
    if (tx.Account === addr) xrp += Number(tx.Fee || 0) / 1e6;
    const paid = [], got = [];
    if (xrp < -0.000001) paid.push({ sym: "XRP", amt: -xrp }); else if (xrp > 0.000001) got.push({ sym: "XRP", amt: xrp });
    const other = Object.entries(iou).filter(([, v]) => Math.abs(v) > 1e-12).map(([id, amt]) => ({ id, sym: decodeCode(id.split(".")[0]), amt, to: tx.Destination || null }));
    // RLUSD and other dollar stablecoins count as base, like USDC on EVM
    const stable = other.filter((k) => /^(RLUSD|USD|USDC|USDT)$/i.test(k.sym)), toks = other.filter((k) => !stable.includes(k));
    stable.forEach((k) => (k.amt < 0 ? paid : got).push({ sym: k.sym, amt: Math.abs(k.amt) }));
    let created = null;
    if (tx.TransactionType === "AMMCreate" && tx.Account === addr) {
      const a2 = typeof tx.Amount2 === "object" ? tx.Amount2 : typeof tx.Amount === "object" ? tx.Amount : null;
      if (a2) { created = { id: a2.currency + "." + a2.issuer }; if (!toks.find((k) => k.id === created.id)) toks.push({ id: created.id, sym: decodeCode(a2.currency), amt: 0 }); }
    }
    classify(toks, paid, got, created).forEach((x) => out.push(Object.assign(x, { chain: "xrpl", hash: h, ts, pool: created ? true : undefined })));
  }
  return out;
}

// ---------- Terra Classic ----------
const TERRA_BASE = { uluna: "LUNC", uusd: "USTC" };
async function terraEvents(addr, cur) {
  const qs = [`/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`message.sender='${addr}'`)}&order_by=ORDER_BY_DESC&pagination.limit=25&limit=25`,
    `/cosmos/tx/v1beta1/txs?events=${encodeURIComponent(`message.sender='${addr}'`)}&order_by=ORDER_BY_DESC&pagination.limit=25`];
  let r = null;
  for (const q of qs) { r = await lcd(q, 8000); if (r && !r.notFound && Array.isArray(r.tx_responses)) break; r = null; }
  if (!r) return null;
  const cut = cur.ts || 0, seen = new Set(cur.h || []), out = [];
  for (const t of r.tx_responses) {
    const ts = Math.floor(Date.parse(t.timestamp) / 1000), h = t.txhash;
    if (t.code || !(ts > cut || (ts === cut && !seen.has(h)))) continue;
    const evs = (t.events && t.events.length ? t.events : [].concat(...(t.logs || []).map((l) => l.events || [])));
    const attrs = (e) => { const o = {}; for (const x of e.attributes || []) { let k = x.key, v = x.value; try { if (!/^[\x20-\x7e]*$/.test(k)) { k = Buffer.from(k, "base64").toString(); v = Buffer.from(v || "", "base64").toString(); } } catch (z) {} o[k] = v; } return o; };
    const paid = [], got = [], toks = []; let created = null;
    for (const e of evs) {
      if (e.type !== "wasm" && !/^wasm-/.test(e.type) && e.type !== "instantiate") continue;
      const a = attrs(e);
      if ((a.action === "swap" || e.type === "wasm-swap") && a.offer_asset && a.ask_asset && (!a.sender || a.sender === addr || a.receiver === addr)) {
        const offer = a.offer_asset, ask = a.ask_asset, oa = Number(a.offer_amount) / 1e6, ra = Number(a.return_amount) / 1e6;
        if (TERRA_BASE[offer]) paid.push({ sym: TERRA_BASE[offer], amt: oa }); else toks.push({ id: offer, sym: "", amt: -oa });
        if (TERRA_BASE[ask]) got.push({ sym: TERRA_BASE[ask], amt: ra }); else toks.push({ id: ask, sym: "", amt: ra });
      } else if (a.action === "transfer" && a.from === addr && a.to && a._contract_address && !toks.length) {
        toks.push({ id: a._contract_address, sym: "", amt: -Number(a.amount) / 1e6, to: a.to });
      } else if (e.type === "instantiate" && a._contract_address) {
        const msgs = ((t.tx && t.tx.body && t.tx.body.messages) || []);
        const init = msgs.map((m) => m.msg).find((m) => m && typeof m === "object" && (m.symbol || m.name)) || {};
        if (init.symbol || init.decimals != null) { created = { id: a._contract_address }; toks.push({ id: a._contract_address, sym: String(init.symbol || ""), name: String(init.name || ""), amt: 0 }); }
      }
    }
    classify(toks, paid, got, created).forEach((x) => out.push(Object.assign(x, { chain: "terraclassic", hash: h, ts })));
  }
  return out;
}


// ---------- developer history: every token this wallet created, and how each one is doing ----------
const DS_CHAIN = { ethereum: "ethereum", bsc: "bsc", base: "base", arbitrum: "arbitrum", polygon: "polygon", optimism: "optimism", avalanche: "avalanche", linea: "linea",
  blast: "blast", zksync: "zksync", scroll: "scroll", mantle: "mantle", sonic: "sonic", unichain: "unichain", cronos: "cronos", robinhood: "robinhood", solana: "solana" };
async function createdSolana(addr) {
  const out = new Map(), key = clean(process.env.HELIUS_API_KEY);
  const [pf, hel] = await Promise.all([
    jget(`https://frontend-api-v3.pump.fun/coins/user-created-coins/${addr}?offset=0&limit=50&includeNsfw=true`, 6000),
    key ? jget(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${key}&type=CREATE&limit=50`, 9000) : null,
  ]);
  const coins = Array.isArray(pf) ? pf : (pf && (pf.coins || pf.data)) || [];
  for (const c of coins) if (c && c.mint) out.set(c.mint, { id: c.mint, sym: c.symbol || "", name: c.name || "", ts: Math.floor(Number(c.created_timestamp || 0) / 1000) || null,
    mcap: Number(c.usd_market_cap) || null, graduated: !!c.complete, src: "pump.fun" });
  if (Array.isArray(hel)) for (const t of hel) {
    if (t.feePayer !== addr || t.transactionError) continue;
    const m = (t.tokenTransfers || []).map((x) => x.mint).find((x) => x && !SOL_BASE[x]);
    if (m && !out.has(m)) out.set(m, { id: m, sym: "", name: "", ts: Number(t.timestamp) || null, src: t.source || "" });
  }
  return [...out.values()];
}
async function createdEvm(addr, chains) {
  const out = [];
  for (const c of chains) {
    const txs = await esCall(c, `module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=1000&sort=desc`);
    for (const x of txs || []) if (!x.to && x.contractAddress && x.isError !== "1" && String(x.from).toLowerCase() === addr) out.push({ id: String(x.contractAddress).toLowerCase(), chain: c, ts: Number(x.timeStamp), sym: "", name: "" });
  }
  return out;
}
async function createdXrpl(addr) {
  const out = []; let marker;
  for (let i = 0; i < 3; i++) {
    const r = await xrplRpc("account_tx", { account: addr, ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false, ...(marker ? { marker } : {}) });
    if (!r) break;
    for (const t of r.transactions || []) {
      const tx = t.tx_json || t.tx || {}, meta = t.meta || t.metaData;
      if (tx.TransactionType !== "AMMCreate" || tx.Account !== addr || !meta || meta.TransactionResult !== "tesSUCCESS") continue;
      const a = typeof tx.Amount2 === "object" ? tx.Amount2 : typeof tx.Amount === "object" ? tx.Amount : null;
      if (a) out.push({ id: a.currency + "." + a.issuer, sym: decodeCode(a.currency), name: "", ts: t.close_time_iso ? Math.floor(Date.parse(t.close_time_iso) / 1000) : tx.date != null ? tx.date + RIPPLE_EPOCH : null });
    }
    marker = r.marker; if (!marker) break;
  }
  return out;
}
/** Market status for created tokens via DexScreener (30 per request). */
async function marketFor(chain, list) {
  const ds = DS_CHAIN[chain]; if (!ds) return;
  for (let i = 0; i < list.length; i += 30) {
    const part = list.slice(i, i + 30), j = await jget(`https://api.dexscreener.com/tokens/v1/${ds}/${part.map((x) => x.id).join(",")}`, 7000);
    if (!Array.isArray(j)) continue;
    for (const t of part) {
      const low = t.id.toLowerCase(), ps = j.filter((p) => String(p.baseToken && p.baseToken.address).toLowerCase() === low);
      if (!ps.length) { t.listed = false; continue; }
      const p = ps.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
      t.listed = true; t.sym = t.sym || p.baseToken.symbol; t.name = t.name || p.baseToken.name;
      t.liq = (p.liquidity && p.liquidity.usd) || 0; t.mcap = p.marketCap || p.fdv || t.mcap || null; t.url = p.url;
      t.ath = null; t.ts = t.ts || (p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null);
    }
  }
}
function statusOf(t) {
  const age = t.ts ? now() - t.ts : null;
  if (t.graduated && (t.liq == null || t.liq >= 1000)) return "live";
  if (t.liq >= 1000 || (t.mcap >= 15000 && t.listed !== false)) return "live";
  if (age !== null && age < 86400) return "new";
  return "dead";
}
/** Full developer report: created tokens (with status) + recent trades. */
async function devReport(addrIn, chainHint, deadline) {
  const fam = familyOf(addrIn);
  if (!fam) throw Object.assign(new Error("That doesn't look like a wallet address."), { status: 400 });
  const address = normAddr(addrIn);
  const chains = fam === "evm" ? (chainHint && EVM[chainHint] ? [chainHint] : (await evmChains(address)).slice(0, 4)) : [fam];
  let created = [];
  try {
    if (fam === "solana") created = (await createdSolana(address)).map((t) => Object.assign(t, { chain: "solana" }));
    else if (fam === "evm") created = await createdEvm(address, chains);
    else if (fam === "xrpl") created = (await createdXrpl(address)).map((t) => Object.assign(t, { chain: "xrpl" }));
    else created = ((await terraEvents(address, { ts: 0 })) || []).filter((e) => e.type === "create").map((e) => ({ id: e.token.id, sym: e.token.sym, name: e.token.name || "", ts: e.ts, chain: "terraclassic" }));
  } catch (e) { created = []; }
  const byChain = {};
  created.forEach((t) => (byChain[t.chain] = byChain[t.chain] || []).push(t));
  await Promise.all(Object.entries(byChain).map(([c, l]) => marketFor(c, l).catch(() => {})));
  if (fam === "evm") created = created.filter((t) => t.listed || t.sym); // non-token contracts (routers, multisigs) drop out
  created.forEach((t) => (t.status = statusOf(t)));
  created.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const left = deadline ? deadline - Date.now() : 15000;
  const recent = left > 4000 ? (await poll({ address, family: fam, chains: chains.length ? chains : [fam] }, { since: now() - 7 * 86400, deadline }).catch(() => ({ events: [] }))).events.reverse() : [];
  return { address, family: fam, chains, created, events: recent };
}

// ---------- token info for alerts (name, market cap, liquidity, chart) ----------
const infoCache = new Map();
async function tokenInfo(chain, id) {
  if (chain === "xrpl") return null;
  const k = chain + "|" + id, c = infoCache.get(k);
  if (c && Date.now() - c.t < 120000) return c.v;
  if (chain === "terraclassic") { // CW20 contract knows its own name
    const ti = await smart(id, { token_info: {} }).catch(() => null);
    const v = ti && ti.symbol ? { sym: ti.symbol, name: ti.name || "" } : null;
    infoCache.set(k, { t: Date.now(), v }); return v;
  }
  const j = await jget("https://api.dexscreener.com/latest/dex/tokens/" + id, 5000);
  const ps = ((j && j.pairs) || []).filter((p) => p.chainId === chain).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const p = ps[0], low = String(id).toLowerCase();
  const t = p ? (String(p.baseToken.address).toLowerCase() === low ? p.baseToken : p.quoteToken) : null;
  let v = p ? { sym: t.symbol, name: t.name, mcap: p.marketCap || p.fdv || null, liq: (p.liquidity && p.liquidity.usd) || null, price: p.priceUsd || null, url: p.url } : null;
  if (!v && chain === "solana" && clean(process.env.HELIUS_API_KEY)) { // brand-new mint: not on DexScreener yet, ask Helius for its metadata
    const a = await jpost("https://mainnet.helius-rpc.com/?api-key=" + clean(process.env.HELIUS_API_KEY), { jsonrpc: "2.0", id: 1, method: "getAsset", params: { id } }, 5000);
    const md = a && a.result && a.result.content && a.result.content.metadata;
    if (md && (md.symbol || md.name)) v = { sym: md.symbol || "", name: md.name || "", url: "https://dexscreener.com/solana/" + id };
  }
  infoCache.set(k, { t: Date.now(), v }); if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value);
  return v;
}

// ---------- poll one wallet ----------
/** w: wallets row. Returns { events, cursor, chains } — events newest last, cursor updated per chain. */
async function poll(w, opts = {}) {
  const cursor = Object.assign({}, w.cursor || {}), events = [], floor = opts.since != null ? opts.since : now() - MAX_AGE;
  const chains = w.family === "evm" ? (w.chains && w.chains.length ? w.chains : ["ethereum", "bsc", "base"]) : [w.family];
  for (const ch of chains) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const cur = cursor[ch] || { ts: opts.since != null ? opts.since : now() };
    if (opts.since == null && cur.ts < floor) cur.ts = floor; // after a long gap, don't replay old history
    const fn = w.family === "evm" ? (c) => evmEvents(c, w.address, cur) : w.family === "solana" ? () => solEvents(w.address, cur) : w.family === "xrpl" ? () => xrplEvents(w.address, cur) : () => terraEvents(w.address, cur);
    let ev = null;
    try { ev = await fn(ch); } catch (e) { ev = null; }
    if (ev === null) continue;
    if (ev.length) {
      const maxTs = Math.max(cur.ts, ...ev.map((e) => e.ts));
      cursor[ch] = { ts: maxTs, h: [...new Set(ev.filter((e) => e.ts === maxTs).map((e) => e.hash))].slice(0, 20) };
      events.push(...ev);
    } else if (!cursor[ch]) cursor[ch] = { ts: cur.ts, h: [] };
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, cursor };
}

// ---------- tracking (Supabase) ----------
async function addTrack(userId, addrIn, label, chainHint) {
  const fam = familyOf(addrIn);
  if (!fam) throw Object.assign(new Error("That doesn't look like a wallet address."), { status: 400 });
  const address = normAddr(addrIn);
  const mine = await db.select("tracked", `user_id=eq.${userId}&select=address`);
  if (mine.some((r) => r.address === address)) return { dup: true, address, family: fam };
  if (mine.length >= MAX_TRACK) return { full: true, max: MAX_TRACK };
  let row = (await db.select("wallets", `address=eq.${db.enc(address)}&select=*`))[0];
  if (!row) {
    const chains = fam === "evm" ? (chainHint && EVM[chainHint] ? [chainHint] : await evmChains(address)) : [];
    row = { address, family: fam, chains: fam === "evm" && !chains.length ? ["ethereum", "bsc", "base"] : chains, cursor: {}, checked_at: new Date().toISOString() };
    const t = now(); (fam === "evm" ? row.chains : [fam]).forEach((c) => (row.cursor[c] = { ts: t, h: [] })); // start from now: no replay of old history
    await db.upsert("wallets", [row], "address");
  } else if (fam === "evm" && chainHint && EVM[chainHint] && !(row.chains || []).includes(chainHint)) {
    row.chains = [chainHint, ...(row.chains || [])].slice(0, MAX_EVM_CHAINS + 2); row.cursor = Object.assign({}, row.cursor, { [chainHint]: { ts: now(), h: [] } });
    await db.patch("wallets", "address=eq." + db.enc(address), { chains: row.chains, cursor: row.cursor });
  }
  await db.insert("tracked", [{ user_id: userId, address, label: label ? String(label).slice(0, 24) : null }], "user_id,address");
  return { ok: true, address, family: fam, chains: fam === "evm" ? row.chains : [fam] };
}
async function removeTrack(userId, addrIn) {
  const address = normAddr(addrIn);
  await db.del("tracked", `user_id=eq.${userId}&address=eq.${db.enc(address)}`);
  const left = await db.select("tracked", `address=eq.${db.enc(address)}&select=user_id&limit=1`);
  if (!left.length) await db.del("wallets", "address=eq." + db.enc(address)).catch(() => {});
}
const listTracks = (userId) => db.select("tracked", `user_id=eq.${userId}&select=address,label,created_at&order=created_at.asc`);

/** One-off activity report for /wallet: last `days` days. */
async function activity(addrIn, days = 7, chainHint, deadline) {
  const fam = familyOf(addrIn);
  if (!fam) throw Object.assign(new Error("That doesn't look like a wallet address."), { status: 400 });
  const address = normAddr(addrIn);
  const chains = fam === "evm" ? (chainHint && EVM[chainHint] ? [chainHint] : (await evmChains(address)).slice(0, 4)) : [];
  const { events } = await poll({ address, family: fam, chains: chains.length ? chains : fam === "evm" ? ["ethereum", "bsc", "base"] : [] }, { since: now() - days * 86400, deadline });
  return { address, family: fam, chains: fam === "evm" ? chains : [fam], events: events.reverse() };
}

module.exports = { devReport, createdSolana, createdEvm, createdXrpl, statusOf, familyOf, normAddr, poll, addTrack, removeTrack, listTracks, activity, tokenInfo, classify, evmEvents, solEvents, xrplEvents, terraEvents, evmChains, MAX_TRACK, NATIVE };
