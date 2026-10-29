// LI.FI proxy: GET /api/li?p=/quote?...   The site calls LI.FI through here so the fee is added on the server and cannot be removed in the browser.
// Env: LIFI_INTEGRATOR (your integrator ID from portal.li.fi), LIFI_FEE (decimal, 0.005 = 0.5%), LIFI_API_KEY (free, from the portal).
const ORIGIN = /^https:\/\/(www\.)?cryptobarlounge\.space$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const ALLOW = new Set(["/chains", "/token", "/quote", "/status"]);
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
  try { if (!p.startsWith("/") || p.length > 1500) throw 0; u = new URL("https://li.quest/v1" + p); } catch (e) { return res.status(400).json({ message: "Bad request" }); }
  const path = u.pathname.replace(/^\/v1/, "");
  if (u.host !== "li.quest" || !ALLOW.has(path)) return res.status(400).json({ message: "Not allowed" });

  if (path === "/quote") {
    u.searchParams.set("integrator", process.env.LIFI_INTEGRATOR || "cbl");
    u.searchParams.delete("fee"); // never trust a fee from the browser
    const fee = parseFloat(process.env.LIFI_FEE);
    if (fee > 0 && fee <= 0.05) u.searchParams.set("fee", String(fee));
  }
  const headers = { accept: "application/json" };
  const key = (process.env.LIFI_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (key) headers["x-lifi-api-key"] = key;
  const c = new AbortController(), t = setTimeout(() => c.abort(), 25000);
  try {
    let r = await fetch(u.toString(), { headers, signal: c.signal });
    // A bad or mismatched key must not break swaps: retry once without it (lower rate limit, fee still applies).
    if ((r.status === 401 || r.status === 403) && key) { delete headers["x-lifi-api-key"]; r = await fetch(u.toString(), { headers, signal: c.signal }); }
    const body = await r.text();
    res.setHeader("Cache-Control", path === "/chains" || path === "/token" ? "public, s-maxage=300" : "no-store");
    res.setHeader("content-type", "application/json");
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ message: "Quote service did not answer. Try again." });
  } finally { clearTimeout(t); }
};
