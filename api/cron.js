// GET/POST /api/cron  (called every 5 minutes by .github/workflows/alerts.yml). Header: Authorization: Bearer <CRON_SECRET>
//   /api/cron              token watchlist alerts
//   /api/cron?job=wallets  wallet tracker alerts (buys, sells, new tokens, transfers)
//   /api/cron?job=radar    rebuild the Token Radar snapshot (trending tokens + CBL scores)
//   /api/cron?job=calls    group first calls: refresh market caps, peaks, post X alerts
const crypto = require("crypto");
const db = require("./_lib/db");
const { runScan } = require("./_lib/scanner");
const { evaluate } = require("./_lib/watch");
const { alertMsg, walletAlert, shortA, esc } = require("./_lib/format");
const WT = require("./_lib/wallets");

const safeEq = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const tg = (method, body) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);

// Poll tracked wallets, oldest check first, and DM every user who tracks a wallet that did something.
async function walletJob(t0, site) {
  const out = { wallets: 0, events: 0, sent: 0, errors: 0 }, deadline = t0 + 24000;
  try {
    const queue = await db.select("wallets", "select=*&order=checked_at.asc&limit=40");
    const work = async () => {
      while (queue.length && Date.now() < deadline - 3000) {
        const w = queue.shift();
        try {
          const { events, cursor } = await WT.poll(w, { deadline });
          out.wallets++;
          await db.patch("wallets", "address=eq." + db.enc(w.address), { cursor, checked_at: new Date().toISOString() });
          if (!events.length) continue;
          out.events += events.length;
          const subs = await db.select("tracked", `address=eq.${db.enc(w.address)}&select=user_id,label`);
          const shown = events.slice(-5), extra = events.length - shown.length;
          for (const e of shown) {
            const info = await WT.tokenInfo(e.chain, e.token.id).catch(() => null);
            for (const s of subs) {
              const m = walletAlert(w, s.label || shortA(w.address), e, info, site);
              const r = await tg("sendMessage", { chat_id: s.user_id, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup });
              if (r && r.ok) out.sent++;
            }
          }
          if (extra > 0) for (const s of subs) await tg("sendMessage", { chat_id: s.user_id, parse_mode: "HTML", text: `…and ${extra} more moves from <b>${esc(s.label || shortA(w.address))}</b>. Use <code>/wallet ${w.address}</code> for the full list.` });
        } catch (e) {
          out.errors++;
          await db.patch("wallets", "address=eq." + db.enc(w.address), { checked_at: new Date().toISOString() }).catch(() => {});
        }
      }
    };
    await Promise.all([work(), work(), work()]);
  } catch (e) { out.errors++; out.error = String(e.message).slice(0, 100); }
  return { ok: true, job: "wallets", ...out, ms: Date.now() - t0 };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEq(req.headers.authorization, "Bearer " + secret)) return res.status(401).end();
  if (!db.on() || !process.env.TELEGRAM_BOT_TOKEN) return res.status(500).json({ ok: false, error: "Not configured" });
  const t0 = Date.now(), site = (process.env.SITE_URL || "https://cryptobarlounge.space").replace(/\/$/, "");
  const job = new URL(req.url, "http://x").searchParams.get("job");
  if (job === "wallets") return res.status(200).json(await walletJob(t0, site));
  if (job === "calls") {
    const out = { sent: 0 };
    try {
      const C = require("./_lib/calls"), { xAlertMsg } = require("./_lib/format");
      const r = await C.trackJob(t0 + 24000); Object.assign(out, { checked: r.checked, updated: r.updated, alerts: r.alerts.length });
      const st = {};
      for (const a of r.alerts) {
        const s = st[a.call.chat_id] || (st[a.call.chat_id] = await C.settings(a.call.chat_id));
        if (s.x_alerts === false) continue;
        const m = xAlertMsg(a, site);
        const x = await tg("sendMessage", { chat_id: a.call.chat_id, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup,
          ...(a.call.msg_id ? { reply_parameters: { message_id: a.call.msg_id, allow_sending_without_reply: true } } : {}) });
        if (x && x.ok) out.sent++;
      }
    } catch (e) { out.error = String(e.message).slice(0, 100); }
    return res.status(200).json({ ok: true, job: "calls", ...out, ms: Date.now() - t0 });
  }
  if (job === "radar") { const r = await require("./_lib/radar").build(23000).catch((e) => ({ stats: { error: String(e.message).slice(0, 100) } })); return res.status(200).json({ ok: true, job: "radar", ...r.stats }); }
  const out = { checked: 0, alerts: 0, sent: 0, errors: 0 };
  try {
    const snaps = await db.select("snapshots", "select=*&order=checked_at.asc&limit=30");
    const queue = snaps.slice();
    const work = async () => {
      while (queue.length && Date.now() - t0 < 24000) {
        const prev = queue.shift();
        try {
          const cur = await runScan(prev.address, prev.chain, { fresh: true, noDeep: true });
          const { alerts, next } = await evaluate(prev, cur);
          out.checked++;
          if (alerts.length) {
            out.alerts += alerts.length;
            const ws = await db.select("watches", `address=eq.${db.enc(prev.address)}&select=user_id,name,symbol`);
            const m = alertMsg(cur, alerts, site);
            for (const w of ws) { const r = await tg("sendMessage", { chat_id: w.user_id, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup }); if (r && r.ok) out.sent++; }
          }
          await db.patch("snapshots", "address=eq." + db.enc(prev.address), next);
        } catch (e) {
          out.errors++;
          await db.patch("snapshots", "address=eq." + db.enc(prev.address), { checked_at: new Date().toISOString() }).catch(() => {}); // move to back of the queue
        }
      }
    };
    await Promise.all([work(), work(), work()]);
  } catch (e) { out.errors++; out.error = String(e.message).slice(0, 100); }
  return res.status(200).json({ ok: true, ...out, ms: Date.now() - t0 });
};
