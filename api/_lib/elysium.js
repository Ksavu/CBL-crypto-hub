// Elysium: Kinetiq's Hyperliquid L2 (Arbitrum Orbit, settles to HyperEVM, gas = HYPE). Mainnet since 2026-11-09.
// Official values: https://elysium.kinetiq.xyz/docs/connecting-to-elysium
//   chain id 99901 · public RPC https://rpc.elysium.kinetiq.xyz · explorer https://elysium.kinetiq.xyz (Blockscout; /tx/, /address/, /token/)
// Not the older Vulcan Forged "Elysium" (chain ids 1338/1339, LAVA) that viem/chainlist still list under this name.
//
// Env (all optional):
//   ELYSIUM_RPC           private RPC (Alchemy/Quicknode/Chainstack). The public one is shared and rate limited.
//   ELYSIUM_EXPLORER_API  Blockscout API v2 base, e.g. https://host/api/v2, tried before the built-in one. Kinetiq doesn't
//                         document the API host; a candidate is only used if it knows mainnet WHYPE as a contract
//                         (so the testnet explorer can never be picked up). Check with /api/scan?chaindiag=elysium.
//   ELYSIUM_LOG_RANGE     max block span per eth_getLogs call on your RPC (default 2000, the public RPC's cap on testnet).
const env = (k) => String(process.env[k] || "").trim();
const ID = 99901, KEY = "elysium", NAME = "Elysium", NATIVE = "HYPE";
const PUBLIC_RPC = "https://rpc.elysium.kinetiq.xyz";
const rpc = () => env("ELYSIUM_RPC") || PUBLIC_RPC;
const EXPLORER = "https://elysium.kinetiq.xyz"; // pages moved from /explorer/... to the host root at launch (old links redirect)
const ADDR_URL = EXPLORER + "/address/", TX_URL = EXPLORER + "/tx/", TOKEN_URL = EXPLORER + "/token/";
const WHYPE = "0xba876237b0f021a6c6d852d6c26e107997cc5e81"; // wrapped HYPE (Uniswap's WETH9 for chain 99901)
const API_GUESS = []; // no public Blockscout API v2 host is known: holders come from Kinetiq's explorer API below
// Kinetiq's own explorer API (what elysium.kinetiq.xyz/token/<address> calls). Undocumented, so every use is optional
// and best effort; it rate limits (HTTP 429), so the scanner makes at most two calls per scan plus one cached list.
const KAPI = "https://elysium.kinetiq.xyz/api/explorer/mainnet";
const apis = () => [env("ELYSIUM_EXPLORER_API").replace(/\/+$/, "")].concat(API_GUESS).filter((x, i, a) => /^https:\/\//.test(x) && a.indexOf(x) === i);
const logRange = () => { const n = parseInt(env("ELYSIUM_LOG_RANGE"), 10); return n >= 100 && n <= 1000000 ? n : 2000; };

async function jget(u, ms, opt) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 4000);
  try {
    const r = await fetch(u, Object.assign({ signal: c.signal, headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; CBLScanner/1.0; +https://cryptobarlounge.space)" } }, opt || {}));
    return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
  } catch (e) { return { status: 0, error: String((e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 80), json: null }; } finally { clearTimeout(t); }
}

// A real mainnet Blockscout knows WHYPE as a contract (testnet's WHYPE lives at another address).
// 429 = the host is there but rate limiting this server's IP (Vercel IPs are shared): one short retry, then report "limited".
async function probe(api, ms) {
  let r = await jget(api + "/addresses/" + WHYPE, ms);
  if (r.status === 429) { await new Promise((z) => setTimeout(z, 700 + Math.random() * 500)); r = await jget(api + "/addresses/" + WHYPE, ms); }
  return { status: r.status, error: r.error, ok: !!(r.json && r.json.is_contract === true), limited: r.status === 429 };
}
// Which Blockscout API answers? Checked once per warm instance (a miss is retried after 5 minutes).
let live = { t: 0, api: null };
async function blockscoutApi() {
  if (live.api || Date.now() - live.t < 5 * 60e3) return live.api || live.soft || null;
  const L = apis(), R = await Promise.all(L.map((a) => probe(a, 2500)));
  const ok = L[R.findIndex((r) => r.ok)] || null;
  // Rate limited and nothing confirmed: use that host for now (single calls often get through) and check again in a minute.
  if (ok) live = { t: Date.now(), api: ok };
  else { const lim = L[R.findIndex((r) => r.limited)] || null; live = { t: Date.now() - 4 * 60e3, api: null, soft: lim }; return lim; }
  return live.api;
}
// opsis (elysiumexplore.com): free third-party indexer with a documented API (https://elysiumexplore.com/api-docs).
// Main source for holders, deployer, launchpad and verified source. ELYSIUM_INDEXER_API overrides the base URL.
const indexer = () => (env("ELYSIUM_INDEXER_API") || "https://elysiumexplore.com").replace(/\/+$/, "");
const NOT_A_PAD = /^(uniswap|bridged|ramses|aero)/i; // "pad" ids that only say where the first pool is
const PAD_NAME = { "boxa-v3": "BOXA", "boxa-v4": "BOXA", kleos: "Kleos", elyspump: "ElysPump" }; // indexer pad id -> the name used in launchpads.js
/** { name, symbol, supply (raw string), holders, creator, creationTx, top10Share (%), pad } or null. */
async function indexToken(addr) {
  const r = await jget(`${indexer()}/v1/tokens/${String(addr).toLowerCase()}`, 4000), t = r.json && r.json.token;
  if (!t || String(t.address || "").toLowerCase() !== String(addr).toLowerCase()) return null;
  const A = (x) => (/^0x[0-9a-f]{40}$/i.test(String(x || "")) ? String(x).toLowerCase() : null), pad = r.json.pad || {};
  const padId = String(pad.id || t.launchpad || ""), share = Number(r.json.top10Share);
  return { name: t.name || null, symbol: t.symbol || null, supply: /^\d+$/.test(String(t.total_supply || "")) ? String(t.total_supply) : null, holders: Number(t.holders) > 0 ? Number(t.holders) : null,
    creator: A(t.creator), creationTx: /^0x[0-9a-f]{64}$/i.test(String(t.created_tx || "")) ? t.created_tx : null, createdTs: Number(t.created_ts) || null,
    top10Share: Number.isFinite(share) && share >= 0 && share <= 100 ? share : null,
    pad: padId && !NOT_A_PAD.test(padId) ? PAD_NAME[padId] || String(pad.name || padId).slice(0, 30) : null, padId: padId || null };
}
// Holders: { holders: [{ holder, balance }], total, labels: { <address>: { name, kind: "contract" | ... } } }.
// Other common field names are accepted too, and rows that don't parse are skipped.
function normHolders(j) {
  const lab = (j && !Array.isArray(j) && j.labels) || {};
  const L = Array.isArray(j) ? j : j && (j.holders || j.items || j.data || j.result);
  if (!Array.isArray(L)) return null;
  const out = [];
  for (const x of L) {
    if (!x || typeof x !== "object") continue;
    const a = [x.address, x.holder, x.account, x.addr, x.owner, x.wallet].map((v) => (v && typeof v === "object" ? v.hash || v.address : v)).find((v) => /^0x[0-9a-f]{40}$/i.test(String(v || "")));
    const v = [x.balance, x.value, x.amount, x.raw, x.balance_raw].find((q) => /^\d+$/.test(String(q == null ? "" : q)));
    if (a && v != null) out.push({ address: { hash: String(a).toLowerCase(), is_contract: x.is_contract === true || x.kind === "contract" || !!(lab[String(a).toLowerCase()] && /contract|pool|system/.test(String(lab[String(a).toLowerCase()].kind))) }, value: String(v) });
  }
  return out.length ? { items: out, total: j && Number(j.total) > 0 ? Number(j.total) : null } : null;
}
const indexHolders = (addr) => jget(`${indexer()}/v1/tokens/${String(addr).toLowerCase()}/holders`, 4000).then((r) => normHolders(r.json));
/** Verified source through the indexer's Etherscan-style route: { name, compiler, source } or null. */
async function indexSource(addr) {
  const r = await jget(`${indexer()}/api?module=contract&action=getsourcecode&address=${addr}`, 6000), x = r.json && Array.isArray(r.json.result) ? r.json.result[0] : null;
  return x && x.SourceCode ? { name: x.ContractName || "", compiler: x.CompilerVersion || "", source: String(x.SourceCode) } : null;
}
/** Top holders, Blockscout shape: { items: [{ address: { hash, is_contract }, value }] } or null. */
const holders = (addr) => jget(`${KAPI}/lists/token-holders?address=${addr}`, 4000).then((r) => (r.json && Array.isArray(r.json.items) ? r.json : null));
/** Number of holders, or null. */
const holderCount = (addr) => jget(`${KAPI}/holder-distribution/${addr}`, 4000).then((r) => { const n = r.json && r.json.distribution && Number(r.json.distribution.holders); return n > 0 ? n : null; });
// Kinetiq's transfer test of tokens: { address, result: "blocked" | "taxed" | ..., takenBps?, hop? }. One list, cached 3 minutes.
let scans = { t: 0, miss: 0, map: null };
async function tokenScan(addr) {
  if (!scans.map || Date.now() - scans.t > 3 * 60e3) {
    if (Date.now() - scans.miss < 2 * 60e3) return scans.map ? scans.map.get(String(addr).toLowerCase()) || null : null; // refused a moment ago: don't ask again yet
    const r = await jget(KAPI + "/token-scans", 5000), L = r.json && Array.isArray(r.json.tokens) ? r.json.tokens : null;
    if (L) scans = { t: Date.now(), miss: 0, map: new Map(L.map((x) => [String(x.address || "").toLowerCase(), x])) };
    else { scans.miss = Date.now(); if (!scans.map) return null; }
  }
  return scans.map.get(String(addr).toLowerCase()) || null;
}
/** Host of the Etherscan-style API (<host>/api?module=...) on the same Blockscout, or null. */
const blockscoutHost = async () => { const a = await blockscoutApi(); return a ? a.replace(/^https:\/\//, "").replace(/\/api\/v2$/, "") : null; };

/** One-click health check after deploy: /api/scan?chaindiag=elysium */
async function diag() {
  const call = (method, params) => jget(rpc(), 5000, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
  const gtRetry = async (u) => { let r = await jget(u, 6000); if (r.status === 429) { await new Promise((z) => setTimeout(z, 1500)); r = await jget(u, 6000); } return r; };
  const KNTQ = "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0"; // a token every indexer has
  const [kh, ks, it, ih, il] = await Promise.all([jget(`${KAPI}/lists/token-holders?address=${WHYPE}`, 5000), jget(KAPI + "/token-scans", 5000),
    jget(`${indexer()}/v1/tokens/${KNTQ}`, 5000), jget(`${indexer()}/v1/tokens/${KNTQ}/holders`, 5000), jget(`${indexer()}/v1/launchpads`, 5000)]);
  const shape = (j) => { const L = Array.isArray(j) ? j : j && (j.holders || j.items || j.data || j.result || j.launchpads); return { topKeys: j && !Array.isArray(j) ? Object.keys(j).slice(0, 12) : "array", rows: Array.isArray(L) ? L.length : 0, first: Array.isArray(L) && L[0] ? JSON.stringify(L[0]).slice(0, 600) : null }; };
  const parsed = await indexToken(KNTQ).catch(() => null), nh = normHolders(ih.json);
  const [cid, head, code, ds, gt, ...bs] = await Promise.all([
    call("eth_chainId"), call("eth_blockNumber"), call("eth_getCode", [WHYPE, "latest"]),
    jget("https://api.dexscreener.com/latest/dex/tokens/" + WHYPE, 6000), gtRetry("https://api.geckoterminal.com/api/v2/networks/elysium/trending_pools?page=1"),
    ...apis().map((a) => probe(a, 4000)),
  ]);
  const chainId = cid.json && cid.json.result ? parseInt(cid.json.result, 16) : null;
  const dsPairs = ((ds.json && ds.json.pairs) || []).filter((p) => p.chainId === KEY);
  return {
    chain: KEY, expectChainId: ID,
    rpc: { url: env("ELYSIUM_RPC") ? "ELYSIUM_RPC (private)" : PUBLIC_RPC, status: cid.status, error: cid.error, chainId, ok: chainId === ID, head: head.json && head.json.result ? parseInt(head.json.result, 16) : null,
      whypeHasCode: !!(code.json && typeof code.json.result === "string" && code.json.result.length > 2) },
    dexscreener: { status: ds.status, elysiumPairs: dsPairs.length, dexIds: [...new Set(dsPairs.map((p) => p.dexId))].slice(0, 12) },
    geckoterminal: { status: gt.status, pools: ((gt.json && gt.json.data) || []).length, dexes: [...new Set(((gt.json && gt.json.data) || []).map((p) => p.relationships && p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id))].slice(0, 12) },
    indexer: { base: indexer(), token: { status: it.status, error: it.error, ok: !!parsed, parsed: parsed && { holders: parsed.holders, creator: parsed.creator, pad: parsed.pad, padId: parsed.padId, top10Share: parsed.top10Share } },
      holders: Object.assign({ status: ih.status, error: ih.error, ok: !!nh, parsedRows: nh ? nh.items.length : 0 }, shape(ih.json)),
      launchpads: Object.assign({ status: il.status, error: il.error }, shape(il.json)) },
    kinetiqExplorer: { holders: { status: kh.status, error: kh.error, ok: !!(kh.json && Array.isArray(kh.json.items)), items: kh.json && kh.json.items ? kh.json.items.length : 0 },
      tokenScans: { status: ks.status, error: ks.error, ok: !!(ks.json && Array.isArray(ks.json.tokens)), tokens: ks.json && ks.json.tokens ? ks.json.tokens.length : 0, results: ks.json && ks.json.tokens ? [...new Set(ks.json.tokens.map((x) => x.result))].slice(0, 10) : [] } },
    blockscout: apis().map((a, i) => ({ api: a, status: bs[i].status, error: bs[i].error, ok: bs[i].ok, rateLimited: bs[i].limited || undefined })),
    logRange: logRange(),
    hint: "rpc.ok must be true. indexer (elysiumexplore.com) is the main source for holders, deployer and launchpad: token.ok and holders.ok should be true. kinetiqExplorer is a backup and usually refuses server requests (429). blockscout is optional (empty unless ELYSIUM_EXPLORER_API is set): only the deployer, verified-source check, audits and the wallet tracker need it.",
  };
}

module.exports = { ID, KEY, NAME, NATIVE, PUBLIC_RPC, rpc, EXPLORER, ADDR_URL, TX_URL, TOKEN_URL, WHYPE, apis, logRange, blockscoutApi, blockscoutHost, holders, holderCount, tokenScan, indexToken, indexHolders, indexSource, diag };
