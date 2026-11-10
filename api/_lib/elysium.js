// Elysium: Kinetiq's Hyperliquid L2 (Arbitrum Orbit, settles to HyperEVM, gas = HYPE). Mainnet since 2026-11-09.
// Official values: https://elysium.kinetiq.xyz/docs/connecting-to-elysium
//   chain id 99901 · public RPC https://rpc.elysium.kinetiq.xyz · explorer https://elysium.kinetiq.xyz/explorer
// Not the older Vulcan Forged "Elysium" (chain ids 1338/1339, LAVA) that viem/chainlist still list under this name.
//
// Env (all optional):
//   ELYSIUM_RPC           private RPC (Alchemy/Quicknode/Chainstack). The public one is shared and rate limited.
//   ELYSIUM_EXPLORER_API  Blockscout API v2 base, e.g. https://host/api/v2. Kinetiq documents the explorer page but
//                         not its API host, so the default below is Conduit's usual naming and may need this override.
//                         Check what answers with /api/scan?chaindiag=elysium.
//   ELYSIUM_LOG_RANGE     max block span per eth_getLogs call on your RPC (default 2000, the public RPC's cap on testnet).
const env = (k) => String(process.env[k] || "").trim();
const ID = 99901, KEY = "elysium", NAME = "Elysium", NATIVE = "HYPE";
const PUBLIC_RPC = "https://rpc.elysium.kinetiq.xyz";
const rpc = () => env("ELYSIUM_RPC") || PUBLIC_RPC;
const EXPLORER = "https://elysium.kinetiq.xyz/explorer";
const ADDR_URL = EXPLORER + "/address/", TX_URL = EXPLORER + "/transaction/"; // Kinetiq's explorer serves /transaction/<hash>, not /tx/
const WHYPE = "0xba876237b0f021a6c6d852d6c26e107997cc5e81"; // wrapped HYPE (Uniswap's WETH9 for chain 99901)
const API_GUESS = ["https://explorer-elysium-mainnet.t.conduit.xyz/api/v2"];
const apis = () => [env("ELYSIUM_EXPLORER_API").replace(/\/+$/, "")].concat(API_GUESS).filter((x, i, a) => /^https:\/\//.test(x) && a.indexOf(x) === i);
const logRange = () => { const n = parseInt(env("ELYSIUM_LOG_RANGE"), 10); return n >= 100 && n <= 1000000 ? n : 2000; };

async function jget(u, ms, opt) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 4000);
  try {
    const r = await fetch(u, Object.assign({ signal: c.signal, headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; CBLScanner/1.0; +https://cryptobarlounge.space)" } }, opt || {}));
    return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
  } catch (e) { return { status: 0, error: String((e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 80), json: null }; } finally { clearTimeout(t); }
}

// Which Blockscout API answers? Checked once per warm instance (a miss is retried after 5 minutes).
let live = { t: 0, api: null };
async function blockscoutApi() {
  if (live.api || Date.now() - live.t < 5 * 60e3) return live.api;
  const L = apis(), hits = await Promise.all(L.map((a) => jget(a + "/stats", 2500).then((r) => !!(r.json && typeof r.json === "object" && ("total_blocks" in r.json || "total_addresses" in r.json)))));
  live = { t: Date.now(), api: L[hits.indexOf(true)] || null };
  return live.api;
}
/** Host of the Etherscan-style API (<host>/api?module=...) on the same Blockscout, or null. */
const blockscoutHost = async () => { const a = await blockscoutApi(); return a ? a.replace(/^https:\/\//, "").replace(/\/api\/v2$/, "") : null; };

/** One-click health check after deploy: /api/scan?chaindiag=elysium */
async function diag() {
  const call = (method, params) => jget(rpc(), 5000, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
  const [cid, head, code, ds, gt, ...bs] = await Promise.all([
    call("eth_chainId"), call("eth_blockNumber"), call("eth_getCode", [WHYPE, "latest"]),
    jget("https://api.dexscreener.com/latest/dex/tokens/" + WHYPE, 6000), jget("https://api.geckoterminal.com/api/v2/networks/elysium/trending_pools?page=1", 6000),
    ...apis().map((a) => jget(a + "/stats", 4000)),
  ]);
  const chainId = cid.json && cid.json.result ? parseInt(cid.json.result, 16) : null;
  const dsPairs = ((ds.json && ds.json.pairs) || []).filter((p) => p.chainId === KEY);
  return {
    chain: KEY, expectChainId: ID,
    rpc: { url: env("ELYSIUM_RPC") ? "ELYSIUM_RPC (private)" : PUBLIC_RPC, status: cid.status, error: cid.error, chainId, ok: chainId === ID, head: head.json && head.json.result ? parseInt(head.json.result, 16) : null,
      whypeHasCode: !!(code.json && typeof code.json.result === "string" && code.json.result.length > 2) },
    dexscreener: { status: ds.status, elysiumPairs: dsPairs.length, dexIds: [...new Set(dsPairs.map((p) => p.dexId))].slice(0, 12) },
    geckoterminal: { status: gt.status, pools: ((gt.json && gt.json.data) || []).length, dexes: [...new Set(((gt.json && gt.json.data) || []).map((p) => p.relationships && p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id))].slice(0, 12) },
    blockscout: apis().map((a, i) => ({ api: a, status: bs[i].status, error: bs[i].error, ok: !!(bs[i].json && ("total_blocks" in bs[i].json || "total_addresses" in bs[i].json)) })),
    logRange: logRange(),
    hint: "rpc.ok must be true. If no blockscout entry is ok, set ELYSIUM_EXPLORER_API to the explorer's /api/v2 base: scans still work without it (market + on-chain basics), but holders, deployer and the wallet tracker need it.",
  };
}

module.exports = { ID, KEY, NAME, NATIVE, PUBLIC_RPC, rpc, EXPLORER, ADDR_URL, TX_URL, WHYPE, apis, logRange, blockscoutApi, blockscoutHost, diag };
