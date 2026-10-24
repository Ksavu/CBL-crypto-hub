// THORChain proxy for bridges to/from native XRP (XRP Ledger).
// GET /api/thor?p=/thorchain/quote/swap?...  |  /thorchain/pools  |  /thorchain/inbound_addresses  |  /thorchain/tx/status/<hash>
// The CBL fee is added here on the server (affiliate + affiliate_bps) so it cannot be removed in the browser.
// Env: THOR_AFFILIATE (your THORName or thor1... address), THOR_AFFILIATE_BPS (default 50 = 0.5%).
const ORIGIN = /^https:\/\/(www\.)?cryptobarlounge\.space$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const NODES = ["https://gateway.liquify.com/chain/thorchain_api", "https://thornode.ninerealms.com"];
const ALLOW = [/^\/thorchain\/quote\/swap$/, /^\/thorchain\/pools$/, /^\/thorchain\/inbound_addresses$/, /^\/thorchain\/tx\/status\/[0-9A-Fa-f]{64}$/];
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
const hits = new Map();

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN.test(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ message: "Method not allowed" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x", now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 90) return res.status(429).json({ message: "Too many requests. Try again in a minute." });
  hits.set(ip, h); if (hits.size > 5000) hits.delete(hits.keys().next().value);

  const p = new URL(req.url, "http://x").searchParams.get("p") || "";
  let u;
  try { if (!p.startsWith("/") || p.length > 1500) throw 0; u = new URL("https://n" + p); } catch (e) { return res.status(400).json({ message: "Bad request" }); }
  if (!ALLOW.some((r) => r.test(u.pathname))) return res.status(400).json({ message: "Not allowed" });

  if (u.pathname === "/thorchain/quote/swap") {
    u.searchParams.delete("affiliate"); u.searchParams.delete("affiliate_bps"); // never trust a fee from the browser
    const aff = clean(process.env.THOR_AFFILIATE), bps = parseInt(clean(process.env.THOR_AFFILIATE_BPS) || "50", 10);
    if (aff && bps > 0 && bps <= 300) { u.searchParams.set("affiliate", aff); u.searchParams.set("affiliate_bps", String(bps)); }
  }
  const path = u.pathname + u.search, static_ = /pools|inbound/.test(u.pathname);
  for (const base of NODES) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
    try {
      const r = await fetch(base + path, { headers: { accept: "application/json", "x-client-id": "cbl-swap" }, signal: c.signal });
      if (r.status >= 500) continue;
      const body = await r.text();
      res.setHeader("Cache-Control", static_ ? "public, s-maxage=30" : "no-store");
      res.setHeader("content-type", "application/json");
      return res.status(r.status).send(body);
    } catch (e) { /* try next node */ } finally { clearTimeout(t); }
  }
  return res.status(502).json({ message: "THORChain did not answer. Try again." });
};
