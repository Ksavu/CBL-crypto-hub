// Fallbacks for EVM tokens DexScreener doesn't know yet (new launches, tokens still on a launchpad bonding curve):
//   find(ca, chain?) -> { chain, pair } using GeckoTerminal search, then a Robinhood Chain contract check.
//   launchpadByCreator(chain, creator) -> launchpad name when the token was deployed by a known launchpad contract.
const GT_NET = { eth: "ethereum", bsc: "bsc", base: "base", arbitrum: "arbitrum", polygon_pos: "polygon", optimism: "optimism", avax: "avalanche",
  linea: "linea", blast: "blast", zksync: "zksync", scroll: "scroll", mantle: "mantle", sonic: "sonic", unichain: "unichain", cro: "cronos" };
const netToChain = (n) => GT_NET[n] || (/robinhood/i.test(n) ? "robinhood" : null);
const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
// Chains probed with eth_getCode when no tracker knows the token (newest-launch chains first).
const CODE_RPC = { robinhood: RH_RPC, bsc: "https://bsc-rpc.publicnode.com", base: "https://base-rpc.publicnode.com", ethereum: "https://ethereum-rpc.publicnode.com" };

async function jget(u, ms = 5000, opt) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, Object.assign({ signal: c.signal, headers: { accept: "application/json", "content-type": "application/json" } }, opt || {})); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
const n = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };

/** GeckoTerminal pool -> DexScreener-like pair, so the rest of the scanner can use it unchanged. */
function gtPair(p, chain, low) {
  const a = p.attributes || {}, rel = p.relationships || {}, net = rel.network && rel.network.data && rel.network.data.id;
  const bt = rel.base_token && rel.base_token.data && rel.base_token.data.id, isBase = String(bt || "").toLowerCase().endsWith(low);
  const [bn, qn] = String(a.name || "").split(" / ");
  return {
    chainId: chain, dexId: (rel.dex && rel.dex.data && rel.dex.data.id) || "geckoterminal", pairAddress: a.address, url: `https://www.geckoterminal.com/${net}/pools/${a.address}`,
    baseToken: { address: low, name: isBase ? bn : qn, symbol: isBase ? bn : qn }, quoteToken: { address: "", symbol: isBase ? qn : bn },
    priceUsd: isBase ? a.base_token_price_usd : a.quote_token_price_usd, fdv: n(a.fdv_usd), marketCap: n(a.market_cap_usd) || n(a.fdv_usd),
    liquidity: { usd: n(a.reserve_in_usd) || 0 }, volume: { h24: n(a.volume_usd && a.volume_usd.h24) || 0 },
    priceChange: { h24: n(a.price_change_percentage && a.price_change_percentage.h24) }, pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null, source: "geckoterminal",
  };
}

async function find(ca, want) {
  const low = String(ca).toLowerCase();
  const probe = Object.keys(CODE_RPC).filter((c) => !want || c === want);
  const [gt, ...codes] = await Promise.all([
    jget(`https://api.geckoterminal.com/api/v2/search/pools?query=${low}&page=1`, 6000),
    ...probe.map((c) => jget(CODE_RPC[c], 4000, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [low, "latest"] }) })),
  ]);
  const pools = ((gt && gt.data) || []).map((p) => {
    const net = p.relationships && p.relationships.network && p.relationships.network.data && p.relationships.network.data.id;
    const ids = [p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id,
      p.relationships && p.relationships.quote_token && p.relationships.quote_token.data && p.relationships.quote_token.data.id].map((x) => String(x || "").toLowerCase());
    return { p, chain: netToChain(net), match: ids.some((x) => x.endsWith("_" + low)) };
  }).filter((x) => x.chain && x.match && (!want || x.chain === want))
    .sort((a, b) => (n(b.p.attributes && b.p.attributes.reserve_in_usd) || 0) - (n(a.p.attributes && a.p.attributes.reserve_in_usd) || 0));
  if (pools.length) return { chain: pools[0].chain, pair: gtPair(pools[0].p, pools[0].chain, low) };
  // Contract exists but no pool anywhere yet (still on a launchpad curve). Vanity endings break ties.
  const has = probe.filter((c, i) => codes[i] && typeof codes[i].result === "string" && codes[i].result.length > 2);
  if (!has.length) return null;
  const hint = /4444$/.test(low) ? "bsc" : /b07$/.test(low) ? "base" : null;
  return { chain: hint && has.includes(hint) ? hint : has[0], pair: null };
}

const { launchpadByCreator, PAD_INFO, BY_CREATOR } = require("./launchpads");

module.exports = { find, launchpadByCreator, PAD_INFO, BY_CREATOR };
