// Vercel serverless function: GET /api/scan?ca=<address>&chain=auto|ethereum|bsc|base|solana
//                              GET /api/scan?wallet=<address>[&chain=base]  -> developer report (tokens created + recent trades)
const { runScan } = require("./_lib/scanner");
const WT = require("./_lib/wallets");

const ORIGIN = /^https:\/\/(www\.)?(cryptobarlounge\.space|xrplabs\.fun)$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
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
  if (url.searchParams.get("radar")) {
    try {
      const [r, cv] = await Promise.all([require("./_lib/radar").read(), require("./_lib/curves").read().catch(() => ({ rows: [] }))]);
      r.curve = cv.rows || []; r.curveT = cv.t || null;
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=240");
      return res.status(200).json(r);
    } catch (e) { console.error("radar error", e && e.stack || e); return res.status(502).json({ ok: false, error: "Radar unavailable. Try again." }); }
  }
  if (url.searchParams.get("wallet")) {
    h.n += 2; // wallet reports cost more upstream calls
    try {
      const ch = url.searchParams.get("chain"), r = await WT.devReport(url.searchParams.get("wallet"), ch && ch !== "auto" ? ch : undefined, Date.now() + 22000);
      res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
      return res.status(200).json({ ok: true, ...r, ts: Date.now() });
    } catch (e) {
      if (!e.status) console.error("wallet report error", e && e.stack || e);
      return res.status(e.status || 502).json({ ok: false, error: e.status ? e.message : "Could not load this wallet. Try again." });
    }
  }
  try {
    const out = await runScan(url.searchParams.get("ca"), url.searchParams.get("chain"), url.searchParams.get("deep") === "0" ? { noDeep: true } : undefined);
    return res.status(200).json(out);
  } catch (e) {
    const status = e.status || 502;
    if (!e.status) console.error("scan error", e && e.stack || e);
    return res.status(status).json({ ok: false, error: e.status ? e.message : "Scan failed. Try again.", detail: e.status ? undefined : String((e && e.stack) || e).split("\n").slice(0, 3).join(" | ").slice(0, 300) });
  }
};
