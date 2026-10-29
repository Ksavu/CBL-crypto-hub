// GET /api/audit?ca=<address>&chain=auto|<any key from _lib/source.js CHAINS>   (verified source from explorers)
// POST /api/audit  { code: "<solidity source>" }                           (pasted, e.g. unlaunched contracts)
const { audit } = require("./_lib/audit");
const { fetchSource, CHAIN_ID, CHAINS } = require("./_lib/source");

const ORIGIN = /^https:\/\/(www\.)?(cryptobarlounge\.space|xrplabs\.fun)$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const hits = new Map(), cache = new Map();
const EVM = /^0x[a-fA-F0-9]{40}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

function build(res, a, meta) {
  return { ok: true, kind: "audit", chain: meta.chain || null, chainName: meta.chain && CHAINS[meta.chain] ? CHAINS[meta.chain][1] : null, address: meta.address || null, ts: Date.now(),
    token: { name: meta.name || "Pasted contract", symbol: "" }, market: null, links: {}, flags: {}, deep: null,
    score: a.score, verdict: a.verdict, confidence: "medium", reasons: a.reasons,
    audit: { ...a.stats, compiler: meta.compiler || "", source: meta.from || "pasted code", ai: null }, sources: { source: meta.from || "pasted" } };
}

async function runAudit({ ca, chain, code }) {
  if (code != null) {
    const c = String(code);
    if (c.length < 30) throw fail(400, "Paste the full Solidity source code.");
    if (c.length > 200000) throw fail(400, "That code is too long. The limit is 200,000 characters.");
    return build(null, audit(c), { name: (/contract\s+(\w+)/.exec(c) || [])[1] || "Pasted contract", from: "pasted code" });
  }
  ca = String(ca || "").trim();
  if (!EVM.test(ca)) throw fail(400, "Send a contract address starting with 0x.");
  if (chain && chain !== "auto" && !CHAIN_ID[chain]) chain = "auto";
  const key = ca.toLowerCase() + "|" + (chain || "auto"), hit = cache.get(key);
  if (hit && Date.now() - hit.t < 300000) return hit.v;
  const src = await fetchSource(ca, chain);
  let out;
  if (!src) {
    out = { ok: true, kind: "audit", chain: chain && chain !== "auto" ? chain : null, address: ca, ts: Date.now(), token: { name: "Unverified contract", symbol: "" }, market: null, links: {}, flags: {}, deep: null,
      score: 15, verdict: "Very high risk", confidence: "low", sources: {},
      reasons: [{ sev: "high", title: "Source code is not verified", detail: "No verified Solidity source was found on Sourcify, Etherscan or Blockscout, so nothing can be audited. Treat the contract as a black box." }],
      audit: { lines: 0, contracts: 0, functions: 0, ownerFunctions: 0, source: "none", ai: null } };
  } else out = build(null, audit(src.source), { chain: src.chain, address: ca, name: src.name, compiler: src.compiler, from: src.from });
  cache.set(key, { t: Date.now(), v: out }); if (cache.size > 300) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN.test(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Headers", "content-type"); }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 12) return res.status(429).json({ ok: false, error: "Too many audits. Try again in a minute." });
  hits.set(ip, h);
  try {
    if (req.method === "POST") {
      const b = req.body && typeof req.body === "object" ? req.body : {};
      return res.status(200).json(await runAudit({ code: b.code }));
    }
    const u = new URL(req.url, "http://x");
    return res.status(200).json(await runAudit({ ca: u.searchParams.get("ca"), chain: (u.searchParams.get("chain") || "auto").toLowerCase() }));
  } catch (e) {
    if (!e.status) console.error("audit error", e && e.stack || e);
    return res.status(e.status || 502).json({ ok: false, error: e.status ? e.message : "Audit failed. Try again." });
  }
};
module.exports.runAudit = runAudit;
