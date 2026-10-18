// Shared scan engine used by /api/scan (website) and /api/telegram (bot).
const { analyze } = require("./score");
const { deepSol } = require("./deep");

const EVM = { ethereum: 1, bsc: 56, base: 8453 };
const OK_CHAINS = ["ethereum", "bsc", "base", "solana"];
const cache = new Map(); // best-effort, per warm instance

async function j(url, ms = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function cleanUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href.slice(0, 300) : null; } catch (e) { return null; }
}
function extractLinks(pair) {
  const info = (pair && pair.info) || {}, L = {};
  for (const w of info.websites || []) { const u = cleanUrl(w && w.url); if (u && !L.web) L.web = u; }
  for (const s of info.socials || []) {
    const u = cleanUrl(s && s.url), t = String((s && s.type) || "").toLowerCase();
    if (!u) continue;
    if ((t === "twitter" || t === "x") && !L.x) L.x = u;
    else if (t === "telegram" && !L.tg) L.tg = u;
    else if (t === "discord" && !L.dc) L.dc = u;
  }
  return L;
}
const fail = (status, message) => Object.assign(new Error(message), { status });

function detect(ca) {
  return /^0x[a-fA-F0-9]{40}$/.test(ca) ? "evm" : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) ? "sol" : "";
}

async function runScan(caIn, selIn) {
  const ca = String(caIn || "").trim(), sel = String(selIn || "auto").toLowerCase();
  const kind = detect(ca);
  if (!kind) throw fail(400, "Invalid contract address");
  if (sel !== "auto" && !OK_CHAINS.includes(sel)) throw fail(400, "Unsupported network");
  if (kind === "sol" && sel !== "auto" && sel !== "solana") throw fail(400, "That is a Solana address");
  if (kind === "evm" && sel === "solana") throw fail(400, "That is an EVM address");

  const now = Date.now(), key = ca.toLowerCase() + "|" + sel, hit = cache.get(key);
  if (hit && now - hit.t < 60000) return hit.v;

  const low = ca.toLowerCase(), sources = {};
  const dx = await j("https://api.dexscreener.com/latest/dex/tokens/" + ca).catch(() => null);
  sources.dexscreener = !!dx;
  const liq = (p) => (p.liquidity && p.liquidity.usd) || 0;
  let pairs = ((dx && dx.pairs) || []).filter((p) => OK_CHAINS.includes(p.chainId) &&
    (kind === "sol" ? p.chainId === "solana" : p.baseToken.address.toLowerCase() === low || p.quoteToken.address.toLowerCase() === low));
  let chain = kind === "sol" ? "solana" : sel !== "auto" ? sel : null;
  if (!chain && pairs.length) chain = pairs.sort((a, b) => liq(b) - liq(a))[0].chainId;
  if (!chain) throw fail(404, "No trading pair found. Choose the network and try again.");
  pairs = pairs.filter((p) => p.chainId === chain).sort((a, b) => liq(b) - liq(a));
  const pair = pairs[0] || null;

  let gp = null, hp = null, rc = null, deep = null;
  if (kind === "evm") {
    const id = EVM[chain];
    [gp, hp] = await Promise.all([
      j(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${low}`).then((r) => r.result && r.result[low]).catch(() => null),
      j(`https://api.honeypot.is/v2/IsHoneypot?address=${low}&chainID=${id}`).catch(() => null),
    ]);
  } else {
    [gp, rc, deep] = await Promise.all([
      j(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${ca}`).then((r) => r.result && (r.result[ca] || r.result[Object.keys(r.result)[0]])).catch(() => null),
      j(`https://api.rugcheck.xyz/v1/tokens/${ca}/report/summary`).catch(() => null),
      deepSol(ca).catch(() => null),
    ]);
  }
  sources.goplus = !!(gp && Object.keys(gp).length);
  sources.honeypot = !!hp;
  sources.rugcheck = !!rc;
  sources.helius = !!deep;
  if (!pair && !sources.goplus && !sources.honeypot && !sources.rugcheck) throw fail(404, "No data found for this address on " + chain);

  const links = extractLinks(pair);
  const a = analyze({ kind: kind === "sol" ? "sol" : "evm", chain, pair, gp, hp, rc, sources, links, deep });
  const tok = pair ? (pair.baseToken.address.toLowerCase() === low ? pair.baseToken : pair.quoteToken) : {};
  const out = {
    ok: true, chain, address: ca, ts: now,
    token: { name: tok.name || (gp && (gp.token_name || (gp.metadata && gp.metadata.name))) || "Unknown token",
             symbol: tok.symbol || (gp && (gp.token_symbol || (gp.metadata && gp.metadata.symbol))) || "",
             logo: (pair && pair.info && pair.info.imageUrl) || null },
    market: pair ? { price: pair.priceUsd, liquidity: liq(pair), fdv: pair.fdv, marketCap: pair.marketCap,
             volume24h: pair.volume && pair.volume.h24, change24h: pair.priceChange && pair.priceChange.h24,
             pairCreatedAt: pair.pairCreatedAt, dex: pair.dexId, url: pair.url } : null,
    links, deep: deep ? { deployer: deep.deployer || null, deployerPct: deep.deployerPct, traced: deep.traced, debug: deep.debug || null, holders: deep.holderCount, top10: deep.top10Wallets, bundlers: deep.bundlers || null, snipers: deep.snipers || null, notes: deep.notes } : null,
    score: a.score, verdict: a.verdict, confidence: a.confidence, reasons: a.reasons, sources,
  };
  cache.set(key, { t: now, v: out });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = { runScan, detect, OK_CHAINS };
