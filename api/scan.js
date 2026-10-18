// Vercel serverless function: GET /api/scan?ca=<address>&chain=auto|ethereum|bsc|base|solana
const { analyze } = require("./_lib/score");

const EVM = { ethereum: 1, bsc: 56, base: 8453 };
const OK_CHAINS = ["ethereum", "bsc", "base", "solana"];
const ORIGIN = /^https:\/\/(www\.)?cryptobarlounge\.space$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const cache = new Map();   // best-effort, per warm instance
const hits = new Map();    // simple per-IP rate limit

async function j(url, ms = 6000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN.test(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 30) return res.status(429).json({ ok: false, error: "Too many scans. Try again in a minute." });
  hits.set(ip, h);

  const url = new URL(req.url, "http://x");
  const ca = (url.searchParams.get("ca") || "").trim();
  const sel = (url.searchParams.get("chain") || "auto").toLowerCase();
  const kind = /^0x[a-fA-F0-9]{40}$/.test(ca) ? "evm" : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) ? "sol" : "";
  if (!kind) return res.status(400).json({ ok: false, error: "Invalid contract address" });
  if (sel !== "auto" && !OK_CHAINS.includes(sel)) return res.status(400).json({ ok: false, error: "Unsupported network" });
  if (kind === "sol" && sel !== "auto" && sel !== "solana") return res.status(400).json({ ok: false, error: "That is a Solana address" });
  if (kind === "evm" && sel === "solana") return res.status(400).json({ ok: false, error: "That is an EVM address" });

  const key = ca.toLowerCase() + "|" + sel, c = cache.get(key);
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  if (c && now - c.t < 60000) return res.status(200).json(c.v);

  const low = ca.toLowerCase();
  const sources = {};
  try {
    const dx = await j("https://api.dexscreener.com/latest/dex/tokens/" + ca).catch(() => null);
    sources.dexscreener = !!dx;
    let pairs = ((dx && dx.pairs) || []).filter((p) => OK_CHAINS.includes(p.chainId) &&
      (kind === "sol" ? p.chainId === "solana" : p.baseToken.address.toLowerCase() === low || p.quoteToken.address.toLowerCase() === low));
    let chain = kind === "sol" ? "solana" : sel !== "auto" ? sel : null;
    const liq = (p) => (p.liquidity && p.liquidity.usd) || 0;
    if (!chain && pairs.length) chain = pairs.sort((a, b) => liq(b) - liq(a))[0].chainId;
    if (!chain) return res.status(404).json({ ok: false, error: "No trading pair found. Choose the network and try again." });
    pairs = pairs.filter((p) => p.chainId === chain).sort((a, b) => liq(b) - liq(a));
    const pair = pairs[0] || null;

    let gp = null, hp = null, rc = null;
    if (kind === "evm") {
      const id = EVM[chain];
      [gp, hp] = await Promise.all([
        j(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${low}`).then((r) => r.result && r.result[low]).catch(() => null),
        j(`https://api.honeypot.is/v2/IsHoneypot?address=${low}&chainID=${id}`).catch(() => null),
      ]);
    } else {
      [gp, rc] = await Promise.all([
        j(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${ca}`).then((r) => r.result && (r.result[ca] || r.result[Object.keys(r.result)[0]])).catch(() => null),
        j(`https://api.rugcheck.xyz/v1/tokens/${ca}/report/summary`).catch(() => null),
      ]);
    }
    sources.goplus = !!(gp && Object.keys(gp).length);
    sources.honeypot = !!hp;
    sources.rugcheck = !!rc;

    if (!pair && !sources.goplus && !sources.honeypot && !sources.rugcheck)
      return res.status(404).json({ ok: false, error: "No data found for this address on " + chain });

    const a = analyze({ kind: kind === "sol" ? "sol" : "evm", chain, pair, gp, hp, rc, sources });
    const tok = pair ? (pair.baseToken.address.toLowerCase() === low ? pair.baseToken : pair.quoteToken) : {};
    const out = {
      ok: true, chain, address: ca, ts: now,
      token: { name: tok.name || (gp && (gp.token_name || (gp.metadata && gp.metadata.name))) || "Unknown token",
               symbol: tok.symbol || (gp && (gp.token_symbol || (gp.metadata && gp.metadata.symbol))) || "",
               logo: pair && pair.info && pair.info.imageUrl || null },
      market: pair ? { price: pair.priceUsd, liquidity: liq(pair), fdv: pair.fdv, marketCap: pair.marketCap,
               volume24h: pair.volume && pair.volume.h24, change24h: pair.priceChange && pair.priceChange.h24,
               pairCreatedAt: pair.pairCreatedAt, dex: pair.dexId, url: pair.url } : null,
      score: a.score, verdict: a.verdict, confidence: a.confidence, reasons: a.reasons, sources,
    };
    cache.set(key, { t: now, v: out });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Scan failed. Try again." });
  }
};
