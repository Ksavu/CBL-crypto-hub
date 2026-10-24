// CBL Launch registry.
//   GET  /api/launch            -> newest launches
//   POST /api/launch {issuer, lp, currency, creator, feeTx, meta} -> verify on the XRP Ledger, then list
// Nothing is trusted from the browser: the server checks that the issuer and the pool wallet are
// blackholed, that the XRP/token AMM pool exists and its LP tokens sit in the blackholed wallet,
// and that the CBL launch fee was paid from that wallet.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, LAUNCH_FEE_XRP (default 5), LAUNCH_FEE_ACCOUNT (default XRPL_FEE_ACCOUNT)
const db = require("./_lib/db");

const ORIGIN = /^https:\/\/(www\.)?cryptobarlounge\.space$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const RPCS = ["https://xrplcluster.com", "https://s1.ripple.com:51234", "https://s2.ripple.com:51234"];
const BLACKHOLE = new Set(["rrrrrrrrrrrrrrrrrrrrrhoLvTp", "rrrrrrrrrrrrrrrrrrrrBZbvji", "rrrrrrrrrrrrrrrrrNAMEtxvNvQ", "rrrrrrrrrrrrrrrrrrrn5RM1rHd"]);
const ADDR = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, CUR = /^([A-Z0-9]{3}|[0-9A-F]{40})$/, HASH = /^[0-9A-F]{64}$/;
const lsfDefaultRipple = 0x00800000, lsfDisableMaster = 0x00100000;
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
const hits = new Map();
const fail = (status, message) => Object.assign(new Error(message), { status });

async function rpc(method, params) {
  for (const base of RPCS) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 7000);
    try {
      const r = await fetch(base, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.result) return j.result;
    } catch (e) { /* next */ } finally { clearTimeout(t); }
  }
  throw fail(502, "XRP Ledger did not answer. Try again.");
}

async function blackholed(addr) {
  const r = await rpc("account_info", { account: addr, ledger_index: "validated", signer_lists: true });
  const a = r.account_data;
  if (!a) return { ok: false };
  const signers = (r.signer_lists || a.signer_lists || []).length > 0;
  return { ok: !!(a.Flags & lsfDisableMaster) && !signers && (!a.RegularKey || BLACKHOLE.has(a.RegularKey)), acct: a };
}

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
function link(u) { u = str(u, 200); if (!u) return null; try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch (e) { return null; } }
function logo(u) { u = String(u || ""); return /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 80000 ? u : null; }
const memoText = (tx) => (tx.Memos || []).map((m) => { try { return Buffer.from((m.Memo && m.Memo.MemoData) || "", "hex").toString("utf8"); } catch (e) { return ""; } }).join(" ");

async function verify(b, cfg) {
  const issuer = str(b.issuer, 40), lp = str(b.lp, 40), currency = str(b.currency, 40).toUpperCase(), creator = str(b.creator, 40);
  if (![issuer, lp, creator].every((a) => ADDR.test(a)) || !CUR.test(currency) || currency === "XRP") throw fail(400, "Bad launch data");

  const [iss, pool] = await Promise.all([blackholed(issuer), blackholed(lp)]);
  if (!iss.ok) throw fail(400, "Issuer is not blackholed yet");
  if (!(iss.acct.Flags & lsfDefaultRipple)) throw fail(400, "Issuer has trading disabled");
  if (!pool.ok) throw fail(400, "Pool wallet is not blackholed yet");

  let amm;
  try { amm = (await rpc("amm_info", { asset: { currency: "XRP" }, asset2: { currency, issuer }, ledger_index: "validated" })).amm; } catch (e) { amm = null; }
  if (!amm || !amm.lp_token) throw fail(400, "No XRP pool found for this token");
  const lines = await rpc("account_lines", { account: lp, peer: amm.account, ledger_index: "validated" });
  const held = ((lines.lines || []).find((l) => l.currency === amm.lp_token.currency) || {}).balance;
  if (!(Number(held) >= Number(amm.lp_token.value) * 0.99)) throw fail(400, "LP tokens are not locked in the pool wallet");

  // Funding must have come from the creator (so the listing credits the right wallet).
  const atx = await rpc("account_tx", { account: lp, ledger_index_min: -1, ledger_index_max: -1, limit: 30, forward: true });
  const txs = (atx.transactions || []).map((t) => ({ tx: t.tx_json || t.tx || t, meta: t.meta || t.metaData, hash: t.hash || (t.tx && t.tx.hash) }));
  const funded = txs.some((t) => t.tx.TransactionType === "Payment" && t.tx.Account === creator && t.tx.Destination === lp && t.meta && t.meta.TransactionResult === "tesSUCCESS");
  if (!funded) throw fail(400, "Launch was not funded by this creator");

  let feeTx = null;
  if (cfg.fee > 0 && cfg.account) {
    const f = txs.find((t) => t.tx.TransactionType === "Payment" && t.tx.Account === lp && t.tx.Destination === cfg.account &&
      t.meta && t.meta.TransactionResult === "tesSUCCESS" && typeof (t.meta.delivered_amount || t.meta.DeliveredAmount || t.tx.Amount) === "string" &&
      Number(t.meta.delivered_amount || t.meta.DeliveredAmount || t.tx.Amount) >= Math.round(cfg.fee * 1e6) && memoText(t.tx).includes("CBL-LAUNCH:" + issuer));
    if (!f) throw fail(402, "CBL launch fee not found");
    feeTx = String(f.hash || "").toUpperCase();
    if (!HASH.test(feeTx)) feeTx = null;
  }
  const gb = await rpc("gateway_balances", { account: issuer, ledger_index: "validated" }).catch(() => ({}));
  const supply = gb.obligations && gb.obligations[currency];
  return { issuer, lp, currency, creator, amm: amm.account, supply: supply || null, feeTx };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN.test(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    if (!db.on()) return res.status(200).json({ ok: true, launches: [] });
    try {
      const rows = await db.select("launches", "select=issuer,currency,ticker,name,description,logo,web,x,tg,dev_pct,supply,created_at&order=created_at.desc&limit=60");
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
      return res.status(200).json({ ok: true, launches: rows || [] });
    } catch (e) { return res.status(200).json({ ok: true, launches: [] }); }
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (!db.on()) return res.status(503).json({ ok: false, error: "Listing is not set up yet" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x", now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 10) return res.status(429).json({ ok: false, error: "Too many requests. Try again in a minute." });
  hits.set(ip, h);

  const b = req.body && typeof req.body === "object" ? req.body : {};
  const m = b.meta && typeof b.meta === "object" ? b.meta : {};
  const fee = parseFloat(clean(process.env.LAUNCH_FEE_XRP) || "5");
  const cfg = { fee: Number.isFinite(fee) ? fee : 5, account: clean(process.env.LAUNCH_FEE_ACCOUNT) || clean(process.env.XRPL_FEE_ACCOUNT) };
  try {
    const v = await verify(b, cfg);
    const name = str(m.name, 40), ticker = str(m.ticker, 20).toUpperCase();
    if (!name || !/^[A-Z0-9]{1,20}$/.test(ticker)) throw fail(400, "Bad token name or ticker");
    await db.upsert("launches", [{
      issuer: v.issuer, currency: v.currency, ticker, name, description: str(m.desc, 280) || null,
      logo: logo(m.logo), web: link(m.web), x: link(m.x), tg: link(m.tg),
      dev_pct: Math.min(Math.max(Number(m.devPct) || 0, 0), 10), supply: v.supply,
      creator: v.creator, lp: v.lp, amm: v.amm, fee_tx: v.feeTx,
    }], "issuer");
    return res.status(200).json({ ok: true });
  } catch (e) {
    if (!e.status) console.error("launch error", e && e.stack || e);
    return res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Listing failed. Try again." });
  }
};
module.exports._verify = verify;
