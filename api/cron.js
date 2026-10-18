// GET/POST /api/cron  (called every 5 minutes by .github/workflows/alerts.yml). Header: Authorization: Bearer <CRON_SECRET>
const crypto = require("crypto");
const db = require("./_lib/db");
const { runScan } = require("./_lib/scanner");
const { evaluate } = require("./_lib/watch");
const { alertMsg } = require("./_lib/format");

const safeEq = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const tg = (method, body) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEq(req.headers.authorization, "Bearer " + secret)) return res.status(401).end();
  if (!db.on() || !process.env.TELEGRAM_BOT_TOKEN) return res.status(500).json({ ok: false, error: "Not configured" });
  const t0 = Date.now(), site = (process.env.SITE_URL || "https://cryptobarlounge.space").replace(/\/$/, "");
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
