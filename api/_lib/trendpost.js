// CBL Trending: a live top-10 post in your Telegram channel, refreshed by the cron (every 5 min).
//   The same message is edited in place; every TRENDING_NEW_HOURS (default 3) a fresh post is sent and pinned.
//   Paid spots ("boosts") are added by admins with /boost and always sit on top, marked 🔥.
// Env: TRENDING_CHANNEL (@yourchannel or -100… id; the bot must be admin there with post/edit/pin rights)
//      ADMIN_IDS (comma-separated Telegram user ids allowed to /boost), TRENDING_CONTACT (@handle for "Get trending")
const db = require("./db");
const { esc } = require("./format");

const STATE = "trendpost", BOOSTS = "trendboosts", MAX_BOOSTS = 3;
const CODE = { solana: "s", bsc: "b", base: "e", robinhood: "r" };
const CH = { solana: "SOL", bsc: "BNB", base: "BASE", robinhood: "HOOD", ethereum: "ETH" };
const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const env = (k) => String(process.env[k] || "").trim();
const bot = () => env("TELEGRAM_BOT_USERNAME").replace(/^@/, "");
const admins = () => env("ADMIN_IDS").split(",").map((x) => x.trim()).filter(Boolean);
const isAdmin = (uid) => admins().includes(String(uid));

async function getKey(id) { try { return ((await db.select("radar_cache", `id=eq.${id}&select=data`))[0] || {}).data || null; } catch (e) { return null; } }
const setKey = (id, data) => db.upsert("radar_cache", [{ id, data }], "id").catch(() => {});

async function boosts() { const b = (await getKey(BOOSTS)) || { list: [] }; b.list = (b.list || []).filter((x) => x.until > Date.now()); return b.list; }
async function addBoost(ca, hours, chain, sym) {
  const list = (await boosts()).filter((x) => x.ca.toLowerCase() !== ca.toLowerCase());
  if (list.length >= MAX_BOOSTS) throw new Error(`All ${MAX_BOOSTS} boost spots are taken. Remove one with /unboost first.`);
  const b = { ca, chain: chain || null, sym: sym || null, until: Date.now() + hours * 3600e3 };
  list.push(b); await setKey(BOOSTS, { list }); return b;
}
async function removeBoost(ca) { const list = (await boosts()).filter((x) => x.ca.toLowerCase() !== ca.toLowerCase()); await setKey(BOOSTS, { list }); return list; }

// Live numbers for a boosted token that isn't in the radar list.
async function dsRow(b) {
  try {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
    const j = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + b.ca, { signal: c.signal }).then((r) => r.json()).finally(() => clearTimeout(t));
    const p = (j.pairs || []).filter((x) => !b.chain || x.chainId === b.chain).sort((x, y) => ((y.liquidity && y.liquidity.usd) || 0) - ((x.liquidity && x.liquidity.usd) || 0))[0];
    if (!p) return null;
    return { ca: b.ca, chain: p.chainId, sym: (p.baseToken && p.baseToken.symbol) || b.sym, mcap: p.marketCap || p.fdv || 0, ch1h: p.priceChange ? p.priceChange.h1 : null };
  } catch (e) { return null; }
}
const usd = (n) => (!n ? "—" : n >= 1e9 ? "$" + (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K" : "$" + Math.round(n));
const pc = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(1)) + "%");

function line(r, i, site, boosted) {
  const sc = r.s ? `${r.s.score >= 80 ? "🟢" : r.s.score >= 60 ? "🟡" : r.s.score >= 40 ? "🟠" : "🔴"}${r.s.score}` : "⚪";
  const buy = CODE[r.chain] && bot() ? ` · <a href="https://t.me/${bot()}?start=tr_${CODE[r.chain]}_${r.ca}">Buy</a>` : "";
  const name = `<a href="${site}/?ca=${encodeURIComponent(r.ca)}#scanner">$${esc(r.sym || "?")}</a>`;
  return `${boosted ? "🔥" : NUM[i] || i + 1 + "."} <b>${name}</b> · ${CH[r.chain] || r.chain} · ${sc}\n      MC ${usd(r.mcap)} · 1h ${pc(r.ch1h)}${buy}`;
}

async function build(site) {
  const R = require("./radar");
  const { rows } = await R.read({ refresh: false, budget: 15000 });
  const ok = (r) => !(r.s && (r.s.honeypot || r.s.score < 50)) && (r.liq || 0) >= 5000;
  const bl = await boosts(), bset = new Set(bl.map((b) => b.ca.toLowerCase()));
  const boosted = await Promise.all(bl.map(async (b) => rows.find((r) => r.ca.toLowerCase() === b.ca.toLowerCase()) || (await dsRow(b)) || { ca: b.ca, chain: b.chain || "solana", sym: b.sym }));
  const top = rows.filter((r) => ok(r) && !bset.has(r.ca.toLowerCase())).sort((a, b) => b.trend - a.trend).slice(0, 10);
  const t = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const L = [`🍸 <b>CBL TRENDING</b> · live · ${t} UTC`, ""];
  boosted.forEach((r, i) => L.push(line(r, i, site, true)));
  if (boosted.length) L.push("");
  top.forEach((r, i) => L.push(line(r, i, site, false)));
  if (!top.length) L.push("Loading the trending list… back in a few minutes.");
  L.push("", "<i>Ranked by volume, buys and momentum. Scores = CBL safety checks, not advice. DYOR.</i>");
  const kb = [[{ text: "🍸 Trade with CBL Bartender", url: bot() ? `https://t.me/${bot()}?start=trade` : site + "/bartender" }],
    [{ text: "📡 Token Radar", url: site + "/radar" }, { text: "🔥 Get trending", url: env("TRENDING_CONTACT") ? "https://t.me/" + env("TRENDING_CONTACT").replace(/^@/, "") : site }]];
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}

/** Cron job. tg = Telegram API caller. */
async function job(site, tg) {
  const chat = env("TRENDING_CHANNEL");
  if (!chat) return { skipped: "TRENDING_CHANNEL not set" };
  const m = await build(site), st = (await getKey(STATE)) || {};
  const every = (Number(env("TRENDING_NEW_HOURS")) || 3) * 3600e3;
  if (st.msg && st.chat === chat && Date.now() - (st.t || 0) < every) {
    const r = await tg("editMessageText", { chat_id: chat, message_id: st.msg, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup });
    if (r && (r.ok || /not modified/i.test(r.description || ""))) return { edited: st.msg };
  }
  const r = await tg("sendMessage", { chat_id: chat, text: m.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup });
  if (!r || !r.ok) return { error: (r && r.description) || "send failed (is the bot admin in the channel?)" };
  await tg("pinChatMessage", { chat_id: chat, message_id: r.result.message_id, disable_notification: true });
  await setKey(STATE, { chat, msg: r.result.message_id, t: Date.now() });
  return { posted: r.result.message_id };
}

module.exports = { job, build, boosts, addBoost, removeBoost, isAdmin };
