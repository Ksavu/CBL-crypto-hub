// Vercel serverless function: GET /api/scan?ca=<address>&chain=auto|ethereum|bsc|base|solana
const { runScan } = require("./_lib/scanner");

const ORIGIN = /^https:\/\/(www\.)?cryptobarlounge\.space$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const hits = new Map(); // simple per-IP rate limit

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
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  try {
    const out = await runScan(url.searchParams.get("ca"), url.searchParams.get("chain"));
    return res.status(200).json(out);
  } catch (e) {
    const status = e.status || 502;
    return res.status(status).json({ ok: false, error: e.status ? e.message : "Scan failed. Try again." });
  }
};
