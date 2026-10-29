// Fills in Solana market data (liquidity, 24h volume, age, market cap) that DexScreener often lacks:
// brand-new tokens it hasn't indexed yet, and pump.fun tokens still on the bonding curve
// (DexScreener lists those without a liquidity figure).
// Sources, in order: DexScreener v1 → GeckoTerminal pools → pump.fun coin API. All public, no keys.
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function j(url, ms = 3500) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (CBL scanner)" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
const has = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const liqOf = (p) => p && p.liquidity && p.liquidity.usd;

async function dexV1(ca) {
  const arr = await j("https://api.dexscreener.com/tokens/v1/solana/" + ca);
  const ps = (Array.isArray(arr) ? arr : (arr && arr.pairs) || []).filter((p) => p && p.chainId === "solana");
  ps.sort((a, b) => (liqOf(b) || 0) - (liqOf(a) || 0) || (((b.volume || {}).h24 || 0) - ((a.volume || {}).h24 || 0)));
  return ps[0] || null;
}

async function gecko(ca) {
  const r = await j(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${ca}/pools?page=1`);
  const pools = (r && r.data) || [];
  if (!pools.length) return null;
  // Most liquid pool where our token is the base token (fallback: any pool).
  const mine = pools.filter((p) => ((((p.relationships || {}).base_token || {}).data || {}).id || "").endsWith("_" + ca));
  const p = (mine.length ? mine : pools).slice().sort((a, b) => (num(b.attributes.reserve_in_usd) || 0) - (num(a.attributes.reserve_in_usd) || 0))[0];
  const a = p.attributes || {};
  const isBase = ((((p.relationships || {}).base_token || {}).data || {}).id || "").endsWith("_" + ca);
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : undefined;
  const dex = ((((p.relationships || {}).dex || {}).data || {}).id) || "";
  return {
    priceUsd: num(isBase ? a.base_token_price_usd : a.quote_token_price_usd),
    liquidity: { usd: num(a.reserve_in_usd) },
    volume: { h24: num(a.volume_usd && a.volume_usd.h24) },
    priceChange: { h24: isBase ? num(a.price_change_percentage && a.price_change_percentage.h24) : undefined },
    fdv: num(a.fdv_usd), marketCap: num(a.market_cap_usd),
    pairCreatedAt: Number.isFinite(created) ? created : undefined,
    dexId: dex, url: `https://www.geckoterminal.com/solana/pools/${a.address}`,
    _poolCount: pools.length, _src: "geckoterminal",
  };
}

async function solUsd() {
  try { const r = await j("https://api.coinbase.com/v2/prices/SOL-USD/spot", 2500); return num(r && r.data && r.data.amount); } catch (e) { return undefined; }
}

/** pump.fun bonding-curve state (unofficial API; best effort). */
async function pumpfun(ca) {
  const [c, sol] = await Promise.all([j("https://frontend-api-v3.pump.fun/coins/" + ca), solUsd()]);
  if (!c || !c.mint) return null;
  const realSol = num(c.real_sol_reserves) != null ? c.real_sol_reserves / 1e9 : undefined;
  // pump.fun migrates once ~85 SOL is in the curve (about 793M of 1B tokens sold).
  const progress = num(c.virtual_token_reserves) != null ? Math.max(0, Math.min(100, (1 - (c.virtual_token_reserves / 1e6 - 279.9e6) / 793.1e6) * 100)) : undefined;
  return {
    curve: !c.complete, progress: c.complete ? 100 : progress,
    liquidity: { usd: realSol != null && sol ? realSol * sol : undefined }, curveSol: realSol,
    marketCap: num(c.usd_market_cap), fdv: num(c.usd_market_cap),
    pairCreatedAt: num(c.created_timestamp),
    name: c.name, symbol: c.symbol, image: c.image_uri,
    links: { web: c.website || null, x: c.twitter || null, tg: c.telegram || null },
  };
}

/**
 * Returns a DexScreener-shaped pair with as many market fields filled as possible.
 * `pair` is the DexScreener pair the scanner already found (may be null).
 */
async function fillSol(ca, pair, budgetMs = 4500) {
  const need = (p) => !p || !has(liqOf(p)) || !has((p.volume || {}).h24) || !p.pairCreatedAt;
  if (!need(pair)) return pair;
  const isPump = /pump$/i.test(ca) || (pair && /pump/i.test(pair.dexId || ""));
  const within = (pr) => Promise.race([pr.catch(() => null), new Promise((ok) => setTimeout(() => ok(null), budgetMs))]);
  const [v1, gt, pf] = await Promise.all([
    pair ? Promise.resolve(null) : within(dexV1(ca)),
    within(gecko(ca)),
    isPump ? within(pumpfun(ca)) : Promise.resolve(null),
  ]);
  let out = pair || v1 || null;
  const fill = (src) => {
    if (!src) return;
    if (!out) { out = Object.assign({ baseToken: { address: ca, name: src.name, symbol: src.symbol }, quoteToken: { address: SOL_MINT, symbol: "SOL" } }, src); return; }
    if (!has(liqOf(out)) && has(liqOf(src))) out.liquidity = Object.assign({}, out.liquidity, { usd: liqOf(src) });
    if (!has((out.volume || {}).h24) && has((src.volume || {}).h24)) out.volume = Object.assign({}, out.volume, { h24: src.volume.h24 });
    if (out.priceChange == null || typeof out.priceChange.h24 !== "number") { if (src.priceChange && typeof src.priceChange.h24 === "number") out.priceChange = Object.assign({}, out.priceChange, { h24: src.priceChange.h24 }); }
    if (!out.pairCreatedAt && src.pairCreatedAt) out.pairCreatedAt = src.pairCreatedAt;
    if (!has(out.marketCap) && has(src.marketCap)) out.marketCap = src.marketCap;
    if (!has(out.fdv) && has(src.fdv)) out.fdv = src.fdv;
    if (!has(num(out.priceUsd)) && has(src.priceUsd)) out.priceUsd = src.priceUsd;
    if (!out.url && src.url) out.url = src.url;
  };
  // A token still on the pump.fun curve: its curve IS the liquidity, so prefer pump.fun's numbers for that.
  if (pf && pf.curve) { if (out) { out.liquidity = Object.assign({}, out.liquidity, { usd: liqOf(pf) || liqOf(out) }); } fill(pf); }
  fill(gt);
  fill(pf);
  if (out && pf) { out.curve = pf.curve; out.curveProgress = pf.progress; out.curveSol = pf.curveSol; if (!out.url) out.url = "https://dexscreener.com/solana/" + ca; if (!out.info && pf.image) out.info = { imageUrl: pf.image, websites: pf.links.web ? [{ url: pf.links.web }] : [], socials: [pf.links.x && { type: "twitter", url: pf.links.x }, pf.links.tg && { type: "telegram", url: pf.links.tg }].filter(Boolean) }; }
  if (out && !out.dexId) out.dexId = pf && pf.curve ? "pumpfun" : (gt && gt.dexId) || "";
  return out;
}

module.exports = { fillSol, _gecko: gecko, _pumpfun: pumpfun };
