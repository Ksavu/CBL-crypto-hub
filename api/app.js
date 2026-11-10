// CBL Bartender (website) API: POST /api/app  { auth, action, ...params }
// Same custodial wallets as the Telegram bot. The user is identified ONLY by a Telegram-signed login:
//   auth.tma = Telegram Mini App initData (opened inside Telegram)   → HMAC with key "WebAppData"
//   auth.tgl = Telegram Login Widget data (opened in a browser/PWA)    → HMAC with SHA256(bot token)
// Logins older than 24h are refused; withdrawals need a login from the last 15 minutes.
// Private keys are never sent to the browser (export stays in Telegram).
const crypto = require("crypto");
const T = require("./_lib/trade");
const O = require("./_lib/orders");
const B = require("./_lib/bundle");
const { runScan } = require("./_lib/scanner");

const ORIGIN = /^https:\/\/(www\.)?cryptobarlounge\.space$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^http:\/\/localhost(:\d+)?$/;
const hits = new Map();
const MAX_AGE = 24 * 3600, FRESH = 15 * 60;

function verify(auth) {
  const bot = String(process.env.TELEGRAM_BOT_TOKEN || "").trim(); if (!bot || !auth) return null;
  const eq = (a, b) => { const x = Buffer.from(String(a), "hex"), y = Buffer.from(String(b), "hex"); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
  if (typeof auth.tma === "string" && auth.tma) {
    const p = new URLSearchParams(auth.tma), hash = p.get("hash"); p.delete("hash");
    const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(bot).digest();
    if (!eq(crypto.createHmac("sha256", secret).update(dcs).digest("hex"), hash)) return null;
    const u = JSON.parse(p.get("user") || "{}"), at = Number(p.get("auth_date"));
    return u.id ? { id: u.id, name: u.first_name || u.username || "", username: u.username || "", at } : null;
  }
  if (auth.tgl && typeof auth.tgl === "object") {
    const d = Object.assign({}, auth.tgl), hash = d.hash; delete d.hash;
    const dcs = Object.keys(d).filter((k) => d[k] != null && d[k] !== "").sort().map((k) => `${k}=${d[k]}`).join("\n");
    const secret = crypto.createHash("sha256").update(bot).digest();
    if (!eq(crypto.createHmac("sha256", secret).update(dcs).digest("hex"), hash)) return null;
    return d.id ? { id: Number(d.id), name: d.first_name || d.username || "", username: d.username || "", at: Number(d.auth_date) } : null;
  }
  return null;
}

const J = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x)));
const nat = (c) => T.CH[c].nat, fmt = (v, c) => (v == null ? null : T.fromUnits(v, T.CH[c].dec));
function codeOf(ca, chain) {
  if (chain && T.CODE[chain]) return T.CODE[chain];
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return "s";
  throw new T.UserErr("Choose the chain for this 0x token (BNB Chain, Base or Robinhood).");
}
const chainsInfo = () => Object.fromEntries(Object.entries(T.CH).map(([c, x]) => [c, { key: x.key, name: x.name, nat: x.nat, exp: x.exp }]));

async function home(uid) {
  const row = await T.getRow(uid); if (!row) return { wallet: null, fee: T.feeBps() / 100, chains: chainsInfo() };
  const [b, pos, ords, subs] = await Promise.all([T.balances(row), T.positions(uid).catch(() => ({ list: [] })), O.list(uid).catch(() => []), B.balances(uid).catch(() => [])]);
  const st = T.settings(row);
  return {
    wallet: { sol: row.sol_pub, evm: row.evm_addr, balances: Object.fromEntries(Object.keys(T.CH).map((c) => [c, fmt(b[c], c)])), subs: subs.map((w) => ({ idx: w.idx, pub: w.pub, bal: fmt(w.bal, "s") })) },
    positions: posOut(pos.list, st), orders: ords.map(ordOut), settings: setOut(st), fee: T.feeBps() / 100, chains: chainsInfo(),
  };
}
function posOut(list, st) {
  return (list || []).filter((p) => p.raw > 0n && (p.valueUsd == null || p.valueUsd >= (Number(st.minPos) || 0))).map((p) => ({
    chain: p.chain, c: T.CODE[p.chain], token: p.token, sym: p.sym, url: p.url, amount: Number(p.raw) / 10 ** p.dec, valueUsd: p.valueUsd, valueNat: p.valueNat,
    priceUsd: p.priceUsd, spentNat: p.spentNat, gotNat: p.gotNat, pnlNat: p.pnlNat, pnlPct: p.pnlPct })).sort((a, b) => st.sort === "az" ? String(a.sym || a.token).localeCompare(String(b.sym || b.token)) : st.sort === "low" ? (a.valueUsd || 0) - (b.valueUsd || 0) : (b.valueUsd || 0) - (a.valueUsd || 0));
}
const ordOut = (o) => ({ id: o.id, chain: o.chain, c: T.CODE[o.chain], token: o.token, kind: o.kind, pct: o.params.pct, sell: o.params.sell, amount: o.params.amount || null, ref: o.params.ref, trig: o.params.trig });
const setOut = (s) => ({ slipBuy: s.slipBuy, slipSell: s.slipSell, maxImpact: s.maxImpact, minPos: s.minPos, sort: s.sort, presets: s.presets, sellP: s.sellP, mev: s.mev, prio: s.prio, sellConfirm: s.sellConfirm, autoTp: s.autoTp, autoSl: s.autoSl, bundle: s.bundle, bundleTip: s.bundleTip });

/** Only these settings can be changed from the web, each validated. */
function cleanSettings(cur, inp) {
  const s = Object.assign({}, cur), n = (x, lo, hi) => { const v = Number(x); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
  if (n(inp.slipBuy, 0.1, 50) != null) s.slipBuy = n(inp.slipBuy, 0.1, 50);
  if (n(inp.slipSell, 0.1, 50) != null) s.slipSell = n(inp.slipSell, 0.1, 50);
  if (n(inp.maxImpact, 0, 100) != null) s.maxImpact = n(inp.maxImpact, 0, 100);
  if (n(inp.minPos, 0, 1e6) != null) s.minPos = n(inp.minPos, 0, 1e6);
  if (["val", "low", "az"].includes(inp.sort)) s.sort = inp.sort;
  if (["normal", "fast", "turbo"].includes(inp.prio)) s.prio = inp.prio;
  ["mev", "sellConfirm", "bundle", "autoBuy"].forEach((k) => { if (typeof inp[k] === "boolean") s[k] = inp[k]; });
  if (n(inp.bundleTip, 0.00001, 0.1) != null) s.bundleTip = n(inp.bundleTip, 0.00001, 0.1);
  if (inp.presets && typeof inp.presets === "object") for (const c of Object.keys(T.CH)) { const a = inp.presets[c]; if (Array.isArray(a) && a.length === 3 && a.every((x) => n(x, 1e-9, 1e6) != null)) s.presets = Object.assign({}, s.presets, { [c]: a.map(Number) }); }
  if (Array.isArray(inp.sellP) && inp.sellP.length === 3 && inp.sellP.every((x) => n(x, 1, 100) != null)) s.sellP = inp.sellP.map((x) => Math.round(x));
  for (const k of ["autoTp", "autoSl"]) { const a = inp[k]; if (a && typeof a === "object") { const pct = n(a.pct, 0.1, k === "autoSl" ? 99 : 100000), sell = n(a.sell, 1, 100); s[k] = Object.assign({}, s[k], typeof a.on === "boolean" ? { on: a.on } : {}, pct != null ? { pct } : {}, sell != null ? { sell: Math.round(sell) } : {}); } }
  return s;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGIN.test(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Headers", "content-type"); return res.status(204).end(); }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } } body = body || {};
  if (body.action === "config") return res.status(200).json({ ok: true, bot: String(process.env.TELEGRAM_BOT_USERNAME || "CBLScannerBot").replace(/^@/, ""), on: T.on(), fee: T.feeBps() / 100 });
  if (!T.on()) return res.status(503).json({ ok: false, error: "Trading isn't switched on yet." });

  const u = verify(body.auth);
  if (!u) return res.status(401).json({ ok: false, error: "Please sign in with Telegram.", login: true });
  const age = Math.floor(Date.now() / 1000) - (u.at || 0);
  if (age > MAX_AGE) return res.status(401).json({ ok: false, error: "Your sign-in expired. Please sign in again.", login: true });
  const now = Date.now(), h = hits.get(u.id) || { n: 0, t: now }; if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 60) return res.status(429).json({ ok: false, error: "Too many requests. Wait a minute." }); hits.set(u.id, h);

  const uid = u.id, a = body.action, p = body.params || {};
  try {
    let out;
    if (a === "home") out = await home(uid);
    else if (a === "create") { const r = await T.ensure(uid); out = Object.assign(await home(uid), { created: r.created }); }
    else {
      const row = await T.getRow(uid); if (!row) return res.status(200).json({ ok: false, error: "Create your wallet first.", needWallet: true });
      const st = T.settings(row);
      if (a === "token") {
        const c = codeOf(p.ca, p.chain), scan = await runScan(p.ca, T.CH[c].key).catch(() => null);
        const [view, bal, ords, cv] = await Promise.all([T.tokenView(uid, c, p.ca).catch(() => null), T.nativeBal(row, c).catch(() => null), O.list(uid, T.CH[c].key, p.ca).catch(() => []), c === "b" || c === "r" ? T.curveOf(c, p.ca) : null]);
        out = { c, chain: T.CH[c].key, ca: p.ca, scan: scan && { token: scan.token, market: scan.market, score: scan.score, verdict: scan.verdict, flags: scan.flags, reasons: (scan.reasons || []).slice(0, 6), launchpad: scan.launchpad, onCurve: scan.onCurve },
          curve: cv && cv.pad, wallet: fmt(bal, c), holding: view && posOut([view], Object.assign({}, st, { minPos: 0 }))[0] || null, orders: ords.map(ordOut), settings: setOut(st) };
      } else if (a === "buy") {
        const c = codeOf(p.ca, p.chain), amt = String(p.amount);
        let r;
        if (c === "s" && st.bundle) r = Object.assign(await B.buy(uid, p.ca, amt), { bundle: true });
        else r = await T.buy(uid, c, p.ca, amt);
        const auto = await O.autoOnBuy(uid, c, p.ca, st).catch(() => []);
        out = { ok: true, c, tx: r.hash || (r.sigs && r.sigs[0]), txs: r.sigs || [r.hash], route: r.route, out: r.out && T.fromUnits(r.out, r.dec), fee: fmt(r.fee || 0n, c), bundle: !!r.bundle, wallets: r.n, auto: auto.map((o) => ({ kind: o.kind, pct: o.pct, sell: o.sell })) };
      } else if (a === "sell") {
        const c = codeOf(p.ca, p.chain), pct = Number(p.pct);
        const r = c === "s" && st.bundle ? Object.assign(await B.sell(uid, p.ca, pct), { bundle: true }) : await T.sell(uid, c, p.ca, pct);
        out = { ok: true, c, tx: r.hash || (r.sigs && r.sigs[0]), txs: r.sigs || [r.hash], route: r.route, received: fmt(r.out, c), fee: fmt(r.fee || 0n, c), bundle: !!r.bundle };
      } else if (a === "positions") { out = { positions: posOut((await T.positions(uid)).list, st) }; }
      else if (a === "addOrder" && p.kind === "lb") { const c = codeOf(p.ca, p.chain); out = await O.addLimit(uid, c, p.ca, Number(p.pct), String(p.amount || "")); out.orders = (await O.list(uid, T.CH[c].key, p.ca)).map(ordOut); }
      else if (a === "addOrder") { const c = codeOf(p.ca, p.chain); out = await O.add(uid, c, p.ca, p.kind === "sl" ? "stop_loss" : "take_profit", p.pct, p.sell); out.orders = (await O.list(uid, T.CH[c].key, p.ca)).map(ordOut); }
      else if (a === "cancelOrder") { await O.cancel(uid, p.id); out = { orders: (await O.list(uid)).map(ordOut) }; }
      else if (a === "settings") { const s = cleanSettings(st, p || {}); await T.saveSettings(uid, Object.assign(st, s, { pend: st.pend || null })); out = { settings: setOut(T.settings(await T.getRow(uid))) }; }
      else if (a === "addWallet") { await B.addWallet(uid); out = await home(uid); }
      else if (a === "spread") { const r = await B.spread(uid, String(p.each)); out = { sent: fmt(r.amt, "s"), n: r.n }; }
      else if (a === "collect") { const r = await B.collect(uid); out = { total: fmt(r.total, "s") }; }
      else if (a === "refs") { // referrals: link + earnings per coin
        const R = require("./_lib/refs"), st2 = await R.stats(uid), bot = String(process.env.TELEGRAM_BOT_USERNAME || "CBLScannerBot").replace(/^@/, "");
        out = { link: `https://t.me/${bot}?start=ref_${uid}`, share: st2.share, invited: st2.invited, trades: st2.trades,
          coins: Object.keys(T.CH).map((c) => ({ c, nat: nat(c), name: T.CH[c].name, earned: fmt(st2.earned[c], c), avail: fmt(st2.avail[c], c), min: R.MIN[c], can: st2.avail[c] >= T.toUnits(R.MIN[c], T.CH[c].dec) })) };
      }
      else if (a === "refClaim") {
        const admins = String(process.env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
        const notify = async (text) => { for (const id of admins) await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: id, text, parse_mode: "HTML" }) }).catch(() => {}); };
        const r = await require("./_lib/refs").claim(uid, p.c, notify);
        out = { amount: fmt(r.amt, r.c), nat: nat(r.c), tx: r.tx || null, queued: r.queued || null };
      }
      else if (a === "copyList") {
        const C = require("./_lib/copy"), db = require("./_lib/db");
        const rows = await C.list(uid), log = (await db.select("bot_copy_log", `tg_id=eq.${uid}&select=side,token,ok,note,created_at&order=id.desc&limit=10`).catch(() => [])) || [];
        out = { max: C.MAX_TARGETS, list: rows.map((r) => ({ id: r.id, chain: r.chain, c: T.CODE[r.chain], nat: nat(T.CODE[r.chain]), target: r.target, label: r.label, amount: r.amount, sells: r.sells, safe: r.safe, max_day: r.max_day, active: r.active })),
          log: log.map((x) => ({ side: x.side, token: x.token, ok: x.ok, note: x.ok === false ? String(x.note || "").slice(0, 80) : null, at: x.created_at })) };
      }
      else if (a === "copyAdd") { await require("./_lib/copy").add(uid, String(p.target || ""), String(p.amount || ""), p.chain || null, p.label || null); out = { added: true }; }
      else if (a === "copyUpdate") {
        const q = {}; ["active", "sells", "safe"].forEach((k) => { if (typeof p[k] === "boolean") q[k] = p[k]; });
        if (p.amount != null) { const v = String(p.amount).trim(); if (!/^\d*\.?\d+$/.test(v) || !(Number(v) > 0)) throw new T.UserErr("Enter an amount like 0.1"); q.amount = v; }
        if (p.max_day != null) { const n = Math.round(Number(p.max_day)); if (!(n >= 1 && n <= 200)) throw new T.UserErr("Max per day: 1–200"); q.max_day = n; }
        if (!Object.keys(q).length) throw new T.UserErr("Nothing to change.");
        await require("./_lib/copy").update(uid, Number(p.id), q); out = { updated: true };
      }
      else if (a === "copyRemove") { await require("./_lib/copy").remove(uid, Number(p.id)); out = { removed: true }; }
      else if (a === "withdraw") {
        if (age > FRESH) return res.status(401).json({ ok: false, error: "For withdrawals, please sign in again (security check).", login: true, fresh: true });
        const c = T.CH[p.c] ? p.c : null; if (!c) throw new T.UserErr("Choose a coin.");
        const r = await T.withdraw(uid, c, String(p.amount), String(p.to || "").trim());
        out = { tx: r.hash, amount: fmt(r.amt, c), nat: nat(c) };
      } else return res.status(400).json({ ok: false, error: "Unknown action" });
    }
    return res.status(200).json(J(Object.assign({ ok: true, user: { name: u.name, username: u.username } }, out)));
  } catch (e) {
    const user = e instanceof T.UserErr;
    if (!user) console.error("app error", a, e && (e.stack || e.message));
    const m = String((e && (e.shortMessage || e.message)) || e);
    return res.status(200).json({ ok: false, error: user ? m : /insufficient funds/i.test(m) ? "Not enough balance for this trade plus gas." : "Something went wrong: " + m.slice(0, 140) });
  }
};
module.exports.verify = verify;
