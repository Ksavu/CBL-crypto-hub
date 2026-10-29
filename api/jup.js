// Solana swap proxy for the website: Jupiter Swap V2 (needs JUP_API_KEY, free at developers.jup.ag/portal).
//   GET  /api/jup?action=order&inputMint=&outputMint=&amount=&taker=   -> quote + unsigned transaction
//   POST /api/jup?action=execute  {signedTransaction, requestId, lastValidBlockHeight}  -> sends it through Jupiter
//   GET  /api/jup?action=token&mint=                                    -> token decimals
// Optional fee for you: JUP_REFERRAL_ACCOUNT + JUP_REFERRAL_FEE (50 to 255 bps). See TELEGRAM_SETUP.md.
const BASE = "https://api.jup.ag/swap/v2";
const ORIGIN = /^https:\/\/(www\.)?(cryptobarlounge\.space|xrplabs\.fun)$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const hits = new Map(), decCache = new Map();

async function jfetch(url, opt, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 9000);
  try {
    const r = await fetch(url, { ...opt, signal: c.signal });
    let d = null; try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, d };
  } finally { clearTimeout(t); }
}

async function decimals(mint) {
  if (decCache.has(mint)) return decCache.get(mint);
  const key = process.env.HELIUS_API_KEY;
  const url = key ? "https://mainnet.helius-rpc.com/?api-key=" + key : "https://api.mainnet-beta.solana.com";
  const r = await jfetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }) }, 6000);
  const dc = r.d && r.d.result && r.d.result.value && r.d.result.value.data && r.d.result.value.data.parsed && r.d.result.value.data.parsed.info && r.d.result.value.data.parsed.info.decimals;
  if (typeof dc !== "number") throw new Error("Token not found on Solana");
  decCache.set(mint, dc); if (decCache.size > 500) decCache.delete(decCache.keys().next().value);
  return dc;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN.test(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Headers", "content-type"); }
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Cache-Control", "no-store");
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x", now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 60) return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  hits.set(ip, h); if (hits.size > 5000) hits.delete(hits.keys().next().value);

  const u = new URL(req.url, "http://x"), action = u.searchParams.get("action");
  try {
    if (action === "token") {
      const m = u.searchParams.get("mint") || "";
      if (!B58.test(m)) return res.status(400).json({ error: "Invalid token address" });
      return res.status(200).json({ decimals: await decimals(m) });
    }
    const key = process.env.JUP_API_KEY;
    if (!key) return res.status(503).json({ error: "Solana swaps are not switched on yet." });
    const H = { "x-api-key": key };

    if (action === "order" && req.method === "GET") {
      const q = new URLSearchParams();
      for (const k of ["inputMint", "outputMint", "taker"]) { const v = u.searchParams.get(k) || ""; if (!B58.test(v)) return res.status(400).json({ error: "Invalid " + k }); q.set(k, v); }
      const amt = u.searchParams.get("amount") || "";
      if (!/^\d{1,30}$/.test(amt) || /^0+$/.test(amt)) return res.status(400).json({ error: "Invalid amount" });
      q.set("amount", amt);
      const ra = process.env.JUP_REFERRAL_ACCOUNT, rf = parseInt(process.env.JUP_REFERRAL_FEE, 10);
      if (ra && B58.test(ra) && rf >= 50 && rf <= 255) { q.set("referralAccount", ra); q.set("referralFee", String(rf)); }
      let r = await jfetch(BASE + "/order?" + q, { headers: H });
      if (r.d && !r.ok && q.has("referralAccount")) {
        console.error("jup order failed with referral, retrying without:", JSON.stringify(r.d).slice(0, 300));
        q.delete("referralAccount"); q.delete("referralFee");
        r = await jfetch(BASE + "/order?" + q, { headers: H });
      }
      if (!r.d) return res.status(502).json({ error: "Jupiter did not answer. Try again." });
      if (!r.ok) return res.status(502).json({ error: String(r.d.error || r.d.message || "Jupiter error").slice(0, 160) });
      const d = r.d;
      return res.status(200).json({ transaction: d.transaction || "", requestId: d.requestId, outAmount: d.outAmount, router: d.router,
        feeBps: d.feeBps, lastValidBlockHeight: d.lastValidBlockHeight, errorCode: d.errorCode, errorMessage: d.errorMessage });
    }
    if (action === "execute" && req.method === "POST") {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      if (typeof b.signedTransaction !== "string" || b.signedTransaction.length > 6000 || typeof b.requestId !== "string" || b.requestId.length > 200)
        return res.status(400).json({ error: "Bad request" });
      const body = { signedTransaction: b.signedTransaction, requestId: b.requestId };
      if (Number.isFinite(b.lastValidBlockHeight)) body.lastValidBlockHeight = b.lastValidBlockHeight;
      const r = await jfetch(BASE + "/execute", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) }, 25000);
      if (!r.d) return res.status(502).json({ error: "Jupiter did not answer. Check your wallet before trying again." });
      return res.status(200).json({ status: r.d.status, signature: r.d.signature, code: r.d.code, error: r.d.error });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(502).json({ error: e && e.message && !/abort/i.test(e.message) ? String(e.message).slice(0, 120) : "Request failed. Try again." });
  }
};
