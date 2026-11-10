// Daily CBL recap in the Trending channel: best calls, biggest gainers and the rugs our scanner flagged, last 24h.
// Posted once a day at RECAP_HOUR_UTC (default 8) by the trending cron; admins can preview with /recap or force /recap now.
// Channel: RECAP_CHANNEL, else TRENDING_CHANNEL.
const db = require("./db");
const { esc } = require("./format");

const env = (k) => String(process.env[k] || "").trim();
const bot = () => env("TELEGRAM_BOT_USERNAME").replace(/^@/, "");
const CH = { solana: "SOL", bsc: "BNB", base: "BASE", robinhood: "HOOD", ethereum: "ETH" };
const usd = (n) => (!n ? "—" : n >= 1e9 ? "$" + (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K" : "$" + Math.round(n));
const xs = (x) => (x >= 10 ? Math.round(x) : x.toFixed(1)) + "x";

async function build(site) {
  const C = require("./calls"), R = require("./radar"), since = new Date(Date.now() - 864e5).toISOString();
  const calls = (await db.select("calls", `created_at=gte.${since}&select=sym,address,chain,mcap,peak_mcap,username&order=created_at.desc&limit=3000`).catch(() => [])) || [];
  const best = new Map(); // one line per token: its best x among groups
  for (const c of calls) { const x = C.xOf(c, c.peak_mcap); if (!x) continue; const k = c.chain + ":" + c.address; if (!best.has(k) || x > best.get(k).x) best.set(k, Object.assign({}, c, { x })); }
  const topCalls = [...best.values()].filter((c) => c.x >= 1.5).sort((a, b) => b.x - a.x).slice(0, 5);
  const hits = [...best.values()].filter((c) => c.x >= 2).length;

  const { rows } = await R.read({ refresh: false, budget: 15000 }).catch(() => ({ rows: [] }));
  const gainers = rows.filter((r) => (r.liq || 0) >= 20000 && r.ch24 > 0 && !(r.s && (r.s.honeypot || r.s.score < 50))).sort((a, b) => b.ch24 - a.ch24).slice(0, 5);
  const rugs = rows.filter((r) => r.s && r.s.score < 40 && r.ch24 != null && r.ch24 <= -70).sort((a, b) => a.ch24 - b.ch24).slice(0, 5);

  const link = (r) => `<a href="${site}/?ca=${encodeURIComponent(r.ca || r.address)}#scanner">$${esc(r.sym || "?")}</a>`;
  const day = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  const L = [`☀️ <b>CBL DAILY RECAP</b> · ${day}`, ""];
  L.push(`🏆 <b>Best calls (24h)</b>${calls.length ? ` · ${calls.length} calls, ${hits} hit 2x+` : ""}`);
  if (topCalls.length) topCalls.forEach((c, i) => L.push(`${["🥇", "🥈", "🥉", "4.", "5."][i]} ${link(c)} · ${CH[c.chain] || c.chain} · <b>${xs(c.x)}</b> (${usd(c.mcap)} → ${usd(c.peak_mcap)})${c.username ? " · @" + esc(c.username) : ""}`));
  else L.push("No 1.5x+ calls in the last 24h. Call tokens in your group with the bot to get on this list.");
  L.push("", "🚀 <b>Top gainers (24h)</b>");
  if (gainers.length) gainers.forEach((r) => L.push(`• ${link(r)} · ${CH[r.chain] || r.chain} · <b>+${Math.round(r.ch24)}%</b> · MC ${usd(r.mcap)} · 🛡 ${r.s ? r.s.score : "?"}`));
  else L.push("Quiet day.");
  if (rugs.length) {
    L.push("", "🚨 <b>Flagged by our scanner, then dumped</b>");
    rugs.forEach((r) => L.push(`• ${link(r)} · ${CH[r.chain] || r.chain} · score <b>${r.s.score}/100</b> → <b>${Math.round(r.ch24)}%</b>`));
  }
  L.push("", "<i>Scan before you ape: paste any contract in the bot. Not financial advice.</i>");
  const kb = [[{ text: "🔍 Scan a token", url: bot() ? `https://t.me/${bot()}` : site }, { text: "🍸 Trade", url: bot() ? `https://t.me/${bot()}?start=trade` : site + "/bartender" }]];
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}

/** Called by the trending cron every 5 min; posts once a day at the set hour (or when forced). */
async function job(site, tg, force) {
  const chat = env("RECAP_CHANNEL") || env("TRENDING_CHANNEL"); if (!chat) return { recap: "no channel" };
  const hour = Number.isFinite(Number(env("RECAP_HOUR_UTC"))) && env("RECAP_HOUR_UTC") !== "" ? Number(env("RECAP_HOUR_UTC")) : 8, today = new Date().toISOString().slice(0, 10);
  const st = (((await db.select("radar_cache", "id=eq.recap&select=data").catch(() => [])) || [])[0] || {}).data || {};
  if (!force && (new Date().getUTCHours() !== hour || st.day === today)) return { recap: "not now" };
  const m = await build(site);
  const r = await tg("sendMessage", { chat_id: chat, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup });
  if (r && r.ok) await db.upsert("radar_cache", [{ id: "recap", data: { day: today, msg: r.result.message_id } }], "id").catch(() => {});
  return { recap: r && r.ok ? "posted" : (r && r.description) || "failed" };
}

module.exports = { build, job };
