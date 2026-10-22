// Fetch verified Solidity source for a contract: Sourcify (free), Etherscan V2 (needs ETHERSCAN_API_KEY), Blockscout.
// key: [chainId, display name, explorer address URL]. Popular chains are tried first when the network is "auto".
const CHAINS = {
  ethereum: [1, "Ethereum", "https://etherscan.io/address/"], bsc: [56, "BNB Chain", "https://bscscan.com/address/"], base: [8453, "Base", "https://basescan.org/address/"],
  polygon: [137, "Polygon", "https://polygonscan.com/address/"], arbitrum: [42161, "Arbitrum", "https://arbiscan.io/address/"], optimism: [10, "Optimism", "https://optimistic.etherscan.io/address/"],
  avalanche: [43114, "Avalanche", "https://snowtrace.io/address/"],
  robinhood: [4663, "Robinhood Chain", "https://robinhoodchain.blockscout.com/address/"],
  linea: [59144, "Linea", "https://lineascan.build/address/"], scroll: [534352, "Scroll", "https://scrollscan.com/address/"], zksync: [324, "zkSync Era", "https://explorer.zksync.io/address/"],
  blast: [81457, "Blast", "https://blastscan.io/address/"], mantle: [5000, "Mantle", "https://mantlescan.xyz/address/"], gnosis: [100, "Gnosis", "https://gnosisscan.io/address/"],
  celo: [42220, "Celo", "https://celoscan.io/address/"], fantom: [250, "Fantom", "https://ftmscan.com/address/"], sonic: [146, "Sonic", "https://sonicscan.org/address/"],
  opbnb: [204, "opBNB", "https://opbnb.bscscan.com/address/"], cronos: [25, "Cronos", "https://cronoscan.com/address/"], mode: [34443, "Mode", "https://modescan.io/address/"],
  unichain: [130, "Unichain", "https://uniscan.xyz/address/"], berachain: [80094, "Berachain", "https://berascan.com/address/"], abstract: [2741, "Abstract", "https://abscan.org/address/"],
  ink: [57073, "Ink", "https://explorer.inkonchain.com/address/"], taiko: [167000, "Taiko", "https://taikoscan.io/address/"], moonbeam: [1284, "Moonbeam", "https://moonscan.io/address/"],
  kaia: [8217, "Kaia", "https://kaiascan.io/account/"], hyperevm: [999, "HyperEVM", "https://hyperevmscan.io/address/"], polygonzkevm: [1101, "Polygon zkEVM", "https://zkevm.polygonscan.com/address/"],
};
const CHAIN_ID = Object.fromEntries(Object.entries(CHAINS).map(([k, v]) => [k, v[0]]));
const POPULAR = ["ethereum", "bsc", "base", "polygon", "arbitrum", "optimism", "avalanche", "robinhood"];
const BLOCKSCOUT = { robinhood: "https://robinhoodchain.blockscout.com/api/v2" };
const MAX = 400000;

async function jget(u, ms = 6000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; CBL-audit)" } }); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
const join = (files) => files.map((f) => `// ===== ${f.path} =====\n${f.content}`).join("\n\n");

async function sourcify(chain, addr) {
  const j = await jget(`https://sourcify.dev/server/v2/contract/${CHAIN_ID[chain]}/${addr}?fields=sources,compilation`);
  if (!j || !j.sources) return null;
  const files = Object.entries(j.sources).map(([path, v]) => ({ path, content: v.content || "" })).filter((f) => /\.sol$/.test(f.path));
  if (!files.length) return null;
  const main = j.compilation || {};
  return { name: main.name || "", compiler: main.compilerVersion || "", source: join(files), from: "Sourcify" };
}
async function etherscan(chain, addr) {
  const key = process.env.ETHERSCAN_API_KEY; if (!key) return null;
  const j = await jget(`https://api.etherscan.io/v2/api?chainid=${CHAIN_ID[chain]}&module=contract&action=getsourcecode&address=${addr}&apikey=${key}`);
  const r = j && Array.isArray(j.result) ? j.result[0] : null;
  if (!r || !r.SourceCode) return null;
  let files = [];
  let sc = String(r.SourceCode).trim();
  try {
    if (sc.startsWith("{{")) sc = sc.slice(1, -1);
    if (sc.startsWith("{")) { const o = JSON.parse(sc); const src = o.sources || o; files = Object.entries(src).map(([path, v]) => ({ path, content: (v && v.content) || "" })); }
  } catch (e) { files = []; }
  if (!files.length) files = [{ path: (r.ContractName || "Contract") + ".sol", content: sc }];
  return { name: r.ContractName || "", compiler: r.CompilerVersion || "", source: join(files), from: "Etherscan" };
}
async function blockscout(chain, addr) {
  if (!BLOCKSCOUT[chain]) return null;
  const j = await jget(`${BLOCKSCOUT[chain]}/smart-contracts/${addr}`);
  if (!j || !j.source_code) return null;
  const files = [{ path: j.file_path || "Main.sol", content: j.source_code }].concat((j.additional_sources || []).map((a) => ({ path: a.file_path, content: a.source_code })));
  return { name: j.name || "", compiler: j.compiler_version || "", source: join(files), from: "Blockscout" };
}

// chain: "auto" or a key of CHAIN_ID. Returns { chain, name, compiler, source, from } or null.
async function fetchSource(addr, chain) {
  const one = async (c) => {
    const r = (await sourcify(c, addr)) || (await etherscan(c, addr)) || (await blockscout(c, addr));
    if (!r) throw new Error("none");
    return { chain: c, ...r, source: r.source.slice(0, MAX) };
  };
  if (chain && chain !== "auto" && CHAIN_ID[chain]) { try { return await one(chain); } catch (e) { return null; } }
  for (const group of [POPULAR, Object.keys(CHAIN_ID).filter((c) => !POPULAR.includes(c))]) { // popular chains first, then the rest
    try { return await Promise.any(group.map(one)); } catch (e) { /* try next group */ }
  }
  return null;
}
module.exports = { fetchSource, CHAINS, CHAIN_ID, MAX };
