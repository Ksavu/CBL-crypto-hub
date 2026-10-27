// Terra Classic for CBL Swap + Bridge.
//   GET  /api/terra?op=quote&token=<terra1 cw20>&side=buy|sell&amt=<human>&pay=LUNC|USTC&slip=<percent>
//   POST /api/terra?op=skip-route   { from:{net,sym}, to:{net,sym}, amount }        -> Skip Go route (bridge quote)
//   POST /api/terra?op=skip-msgs    { route, addresses:[...], slip }                -> transactions to sign
//   POST /api/terra?op=skip-track   { tx_hash, chain_id }   |  GET op=skip-status&tx_hash=&chain_id=
// Fees: swaps send TERRA_FEE_BPS (default 50 = 0.5%) to TERRA_FEE_ADDRESS. Bridges add a Skip Go affiliate fee
// (SKIP_FEE_BPS, default 50) on every chain listed in SKIP_AFFILIATES, a JSON map like {"osmosis-1":"osmo1..."}.
// The bridge fee is added here on the server, so it cannot be removed in the browser.
const T = require("./_lib/terra");

const ORIGIN = /^https:\/\/(www\.)?(cryptobarlounge\.space|xrplabs\.fun)$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
const fail = (status, message) => Object.assign(new Error(message), { status });
const hits = new Map(), tokCache = new Map();
const DENOM = { LUNC: "uluna", USTC: "uusd" }, SYM = { uluna: "LUNC", uusd: "USTC" };
const SKIP = "https://api.skip.build";
// CBL Bridge network names -> Skip Go chain ids. Bitcoin, Tron, XRP and Robinhood Chain have no Skip route.
const NET = { "Terra Classic": "columbus-5", Ethereum: "1", "BNB Chain": "56", Base: "8453", Polygon: "137", Arbitrum: "42161", Optimism: "10", Avalanche: "43114", Solana: "solana" };

function cfg() {
  const bps = parseInt(clean(process.env.TERRA_FEE_BPS) || "50", 10), addr = clean(process.env.TERRA_FEE_ADDRESS).toLowerCase();
  const sbps = parseInt(clean(process.env.SKIP_FEE_BPS) || "50", 10);
  let aff = {}; try { aff = JSON.parse(clean(process.env.SKIP_AFFILIATES) || "{}") || {}; } catch (e) { aff = {}; }
  const gp = parseFloat(clean(process.env.TERRA_GAS_PRICE) || "28.325");
  return {
    feeAddr: /^terra1[02-9ac-hj-np-z]{38}$/.test(addr) ? addr : null,
    feeBps: Number.isFinite(bps) ? Math.min(Math.max(bps, 0), 300) : 50,
    skipBps: Number.isFinite(sbps) ? Math.min(Math.max(sbps, 0), 300) : 50,
    aff, gasPrice: Number.isFinite(gp) && gp > 0 ? gp : 28.325,
  };
}

// ---------- decimal helpers (BigInt, no float rounding on chain amounts)
function toRaw(s, dec) {
  s = String(s || "").trim();
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) throw fail(400, "Enter a valid amount");
  const [i, f = ""] = s.split(".");
  return BigInt((i || "0") + f.padEnd(dec, "0").slice(0, dec));
}
function toHuman(raw, dec) {
  const neg = raw < 0n; let s = (neg ? -raw : raw).toString().padStart(dec + 1, "0");
  const out = dec ? s.slice(0, -dec) + "." + s.slice(-dec) : s;
  return (neg ? "-" : "") + out.replace(/\.?0+$/, "");
}
function ratio(a, b, places = 18) { // a / b as a decimal string
  if (b === 0n) return "0";
  const q = (a * 10n ** BigInt(places)) / b;
  return toHuman(q, places) || "0";
}

async function tokenInfo(ca) {
  const h = tokCache.get(ca); if (h) return h;
  const ti = await T.smart(ca, { token_info: {} });
  if (!ti) throw fail(404, "That is not a CW20 token on Terra Classic.");
  const v = { symbol: ti.symbol || "TOKEN", name: ti.name || ti.symbol, dec: Number(ti.decimals) || 0 };
  tokCache.set(ca, v); if (tokCache.size > 500) tokCache.delete(tokCache.keys().next().value);
  return v;
}
async function taxRate() {
  const r = await T.lcd("/terra/treasury/v1beta1/tax_rate", 4000);
  const n = r && !r.notFound ? parseFloat(r.tax_rate) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 0.1 ? n : 0; // 0 when the chain charges tax through gas instead (tax2gas)
}

async function quote(q) {
  const c = cfg(), ca = String(q.get("token") || "").trim().toLowerCase(), side = q.get("side") === "sell" ? "sell" : "buy";
  if (!T.isTerraId(ca)) throw fail(400, "Not a Terra Classic token contract.");
  const pay = DENOM[String(q.get("pay") || "LUNC").toUpperCase()] || "uluna";
  const slipPct = Math.min(Math.max(parseFloat(q.get("slip")) || 1, 0.1), 49);
  const [tok, pools, tax] = await Promise.all([tokenInfo(ca), T.findPools(ca), taxRate()]);
  const nat = pools.filter((p) => p.otherNative && SYM[p.other]);
  const pool = nat.find((p) => p.other === pay) || nat[0];
  if (!pool) throw fail(404, `No LUNC or USTC pool found for ${tok.symbol}.`);
  const denom = pool.other, feeOn = !!c.feeAddr && c.feeBps > 0, bps = BigInt(feeOn ? c.feeBps : 0);
  const slipBp = BigInt(Math.round(slipPct * 100));

  let offerRaw, swapRaw, feeRaw, retRaw, minRaw, offerInfo;
  if (side === "buy") {
    offerRaw = toRaw(q.get("amt"), 6);
    feeRaw = (offerRaw * bps) / 10000n; swapRaw = offerRaw - feeRaw;
    offerInfo = { native_token: { denom } };
  } else {
    offerRaw = toRaw(q.get("amt"), tok.dec); swapRaw = offerRaw;
    offerInfo = { token: { contract_addr: ca } };
  }
  if (swapRaw <= 0n) throw fail(400, "Amount is too small.");
  const sim = await T.smart(pool.pair, { simulation: { offer_asset: { info: offerInfo, amount: swapRaw.toString() } } });
  if (!sim || !sim.return_amount) throw fail(502, "The pool did not return a price. Try again.");
  retRaw = BigInt(sim.return_amount);
  if (retRaw <= 0n) throw fail(400, "Amount is too small for this pool.");
  minRaw = (retRaw * (10000n - slipBp)) / 10000n;
  let out = retRaw;
  if (side === "sell") { feeRaw = (minRaw * bps) / 10000n; out = retRaw - feeRaw; }
  const outDec = side === "buy" ? tok.dec : 6;
  return {
    ok: true, side, token: ca, symbol: tok.symbol, dec: tok.dec, pair: pool.pair, denom, paySym: SYM[denom],
    offerRaw: offerRaw.toString(), swapRaw: swapRaw.toString(), feeRaw: feeRaw.toString(), minRaw: minRaw.toString(),
    out: toHuman(out, outDec), min: toHuman(side === "sell" ? minRaw - feeRaw : minRaw, outDec),
    beliefPrice: ratio(swapRaw, retRaw), maxSpread: (slipPct / 100).toFixed(4),
    feeAddr: feeOn ? c.feeAddr : null, feeBps: feeOn ? c.feeBps : 0, taxRate: tax, gasPrice: c.gasPrice,
    impact: pool.tokenRaw > 0 ? Number(swapRaw) / (Number(side === "buy" ? pool.otherAmt * 1e6 : pool.tokenRaw) + Number(swapRaw)) : null,
  };
}

// ---------- Skip Go (bridge)
async function skip(path, body, ms = 20000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms), id = clean(process.env.SKIP_CLIENT_ID);
  const u = SKIP + path + (id ? (path.includes("?") ? "&" : "?") + "client_id=" + encodeURIComponent(id) : "");
  try {
    const r = await fetch(u, { method: body ? "POST" : "GET", signal: c.signal, headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(r.status >= 500 ? 502 : 400, skipMsg(d.message || "Skip Go request failed"));
    return d;
  } catch (e) { if (e.status) throw e; throw fail(502, "Skip Go did not answer. Try again."); } finally { clearTimeout(t); }
}
function skipMsg(m) {
  m = String(m);
  if (/no route|not found|unsupported|no.*path/i.test(m)) return "No bridge route for this pair right now. Try LUNC or USTC to/from USDC, or another network.";
  if (/too small|insufficient|minimum/i.test(m)) return "Amount is too small for this bridge. Try a larger amount.";
  return m.slice(0, 180);
}
const assetCache = new Map();
async function asset(net, sym) {
  const chain = NET[net];
  if (!chain) throw fail(400, `${net} can't be bridged with Terra Classic. Use Ethereum, BNB Chain, Base, Polygon, Arbitrum, Optimism, Avalanche or Solana.`);
  sym = String(sym || "").toUpperCase();
  if (chain === "columbus-5") {
    if (!DENOM[sym]) throw fail(400, "On Terra Classic you can bridge LUNC or USTC.");
    return { chain, denom: DENOM[sym], dec: 6, sym };
  }
  let list = assetCache.get(chain);
  if (!list || Date.now() - list.t > 3600e3) {
    const d = await skip(`/v2/fungible/assets?chain_ids=${encodeURIComponent(chain)}&include_evm_assets=true&include_svm_assets=true&native_only=false`);
    const m = d.chain_to_assets_map && d.chain_to_assets_map[chain];
    list = { t: Date.now(), v: (m && m.assets) || [] }; assetCache.set(chain, list);
  }
  const hit = list.v.filter((a) => String(a.symbol || "").toUpperCase() === sym)
    .sort((a, b) => score(a) - score(b))[0];
  if (!hit) throw fail(400, `${sym} on ${net} is not available on Skip Go.`);
  return { chain, denom: hit.denom, dec: Number(hit.decimals) || 0, sym };
}
const score = (a) => (/^ibc\//.test(a.denom) ? 2 : 0) + (/axl|wormhole|\.e$/i.test(a.denom + (a.name || "")) ? 1 : 0);

function swapChains(ops) {
  const out = new Set();
  const walk = (o) => { if (!o || typeof o !== "object") return; if (o.swap_venue && o.swap_venue.chain_id) out.add(String(o.swap_venue.chain_id)); Object.values(o).forEach(walk); };
  (ops || []).forEach((op) => { if (op.swap) walk(op.swap); if (op.evm_swap) out.add(String(op.evm_swap.from_chain_id || op.evm_swap.chain_id || "")); });
  out.delete(""); return [...out];
}
function feeFor(route, c) {
  const chains = swapChains(route.operations);
  if (!chains.length || !c.skipBps || !chains.every((id) => c.aff[id])) return null;
  const m = {}; chains.forEach((id) => { m[id] = { affiliates: [{ address: c.aff[id], basis_points_fee: String(c.skipBps) }] }; });
  return m;
}
async function skipRoute(b) {
  const c = cfg(), from = await asset(b.from && b.from.net, b.from && b.from.sym), to = await asset(b.to && b.to.net, b.to && b.to.sym);
  if (from.chain === to.chain) throw fail(400, "Pick two different networks.");
  if (from.chain !== "columbus-5" && to.chain !== "columbus-5") throw fail(400, "Skip Go is only used here for Terra Classic bridges.");
  const amount_in = toRaw(b.amount, from.dec);
  if (amount_in <= 0n) throw fail(400, "Enter an amount");
  const req = (bps) => skip("/v2/fungible/route", {
    source_asset_denom: from.denom, source_asset_chain_id: from.chain, dest_asset_denom: to.denom, dest_asset_chain_id: to.chain,
    amount_in: amount_in.toString(), cumulative_affiliate_fee_bps: String(bps), allow_multi_tx: false, allow_unsafe: false,
    smart_relay: true, go_fast: true, experimental_features: ["cctp", "hyperlane", "stargate", "eureka"],
  });
  let route = await req(c.skipBps), fee = feeFor(route, c);
  if (!fee && c.skipBps) route = await req(0); // fee only where we have an affiliate address on the swap chain
  return { ok: true, route, from, to, feeBps: fee ? c.skipBps : 0, out: toHuman(BigInt(route.estimated_amount_out || route.amount_out || "0"), to.dec) };
}
async function skipMsgs(b) {
  const c = cfg(), r = b.route;
  if (!r || !Array.isArray(r.operations) || !Array.isArray(b.addresses)) throw fail(400, "Bad request");
  if (b.addresses.length !== (r.required_chain_addresses || []).length) throw fail(400, "Missing an address for one of the chains in this route.");
  const aff = feeFor(r, c), slip = Math.min(Math.max(parseFloat(b.slip) || 1, 0.1), 10);
  const d = await skip("/v2/fungible/msgs", {
    source_asset_denom: r.source_asset_denom, source_asset_chain_id: r.source_asset_chain_id, dest_asset_denom: r.dest_asset_denom, dest_asset_chain_id: r.dest_asset_chain_id,
    amount_in: r.amount_in, amount_out: r.amount_out, address_list: b.addresses, operations: r.operations,
    estimated_amount_out: r.estimated_amount_out, slippage_tolerance_percent: String(slip), timeout_seconds: "1800",
    ...(aff ? { chain_ids_to_affiliates: aff } : {}),
  });
  return { ok: true, txs: d.txs || [], msgs: d.msgs || [] };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN.test(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") return res.status(204).end();
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x", now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 60) return res.status(429).json({ ok: false, error: "Too many requests. Try again in a minute." });
  hits.set(ip, h); if (hits.size > 5000) hits.delete(hits.keys().next().value);
  res.setHeader("Cache-Control", "no-store");
  const q = new URL(req.url, "http://x").searchParams, op = q.get("op");
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  try {
    if (op === "cfg") { const c = cfg(); return res.status(200).json({ ok: true, feeOn: !!c.feeAddr && c.feeBps > 0, gasPrice: c.gasPrice, taxRate: await taxRate() }); }
    if (op === "quote") return res.status(200).json(await quote(q));
    if (req.method !== "POST" && op !== "skip-status") return res.status(405).json({ ok: false, error: "Method not allowed" });
    if (op === "skip-route") return res.status(200).json(await skipRoute(body));
    if (op === "skip-msgs") return res.status(200).json(await skipMsgs(body));
    const hash = String(body.tx_hash || q.get("tx_hash") || ""), chain = String(body.chain_id || q.get("chain_id") || "");
    if (!/^(0x)?[0-9A-Za-z]{40,100}$/.test(hash) || !/^[\w.-]{1,40}$/.test(chain)) return res.status(400).json({ ok: false, error: "Bad request" });
    if (op === "skip-track") return res.status(200).json(await skip("/v2/tx/track", { tx_hash: hash, chain_id: chain }));
    if (op === "skip-status") return res.status(200).json(await skip(`/v2/tx/status?tx_hash=${encodeURIComponent(hash)}&chain_id=${encodeURIComponent(chain)}`));
    return res.status(400).json({ ok: false, error: "Unknown op" });
  } catch (e) {
    if (!e.status) console.error("terra api", e && e.stack || e);
    return res.status(e.status || 502).json({ ok: false, error: e.status ? e.message : "Request failed. Try again." });
  }
};
module.exports._t = { toRaw, toHuman, ratio, swapChains, feeFor, quote, skipRoute, skipMsgs, asset };
