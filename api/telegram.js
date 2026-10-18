// Telegram webhook: POST /api/telegram  (set with setWebhook + secret_token, see TELEGRAM_SETUP.md)
const crypto = require("crypto");
const { runScan, detect } = require("./_lib/scanner");
const { card, HELP, esc } = require("./_lib/format");
const db = require("./_lib/db");
const W = require("./_lib/watch");

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const SITE = () => (process.env.SITE_URL || "https://cryptobarlounge.space").replace(/\/$/, "");
const CHAIN = { eth: "ethereum", ethereum: "ethereum", bsc: "bsc", bnb: "bsc", base: "base", rh: "robinhood", robinhood: "robinhood", sol: "solana", solana: "solana" };
const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/, SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const seen = new Map(), users = new Map(); // per warm instance

function tg(method, body) {
  return fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null);
}
function findCA(text) {
  const m = (text || "").match(EVM_RE) || (text || "").match(SOL_RE);
  return m && detect(m[0]) ? m[0] : null;
}
function limited(uid) {
  const now = Date.now(), a = (users.get(uid) || []).filter((t) => now - t < 60000);
  a.push(now); users.set(uid, a);
  if (users.size > 2000) users.delete(users.keys().next().value);
  return a.length > 10;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function reply(msg, text, extra) {
  return tg("sendMessage", { chat_id: msg.chat.id, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, ...extra });
}

// Add a token to a user's watchlist. Alerts go to the user's DM, so the bot must be able to message them first.
async function watchFlow(user, ca, chain, say) {
  if (!db.on()) return say("Alerts are not set up yet.");
  if (limited(user.id)) return say("Slow down a little.");
  const ok = await tg("sendMessage", { chat_id: user.id, text: "👁 Setting up your alert..." });
  if (!ok || !ok.ok) return say("I can't message you privately yet. Open the bot, press Start, then try again.");
  try {
    const r = await W.addWatch(user.id, ca, chain);
    if (r.dup) return void (await tg("sendMessage", { chat_id: user.id, text: "Already on your watchlist." }));
    if (r.full) return void (await tg("sendMessage", { chat_id: user.id, text: `Your watchlist is full (${r.max}). Use /list to remove one.` }));
    const t = r.res.token;
    await tg("sendMessage", { chat_id: user.id, parse_mode: "HTML", text: `✅ Watching <b>${esc(t.name)}</b>${t.symbol ? ` (${esc(t.symbol)})` : ""}.\nI'll message you here if liquidity is pulled, the price crashes, the deployer sells, the token turns into a honeypot, the tax jumps or the risk score drops.` });
    return say("Added. Alerts will arrive in your DM.");
  } catch (e) { return say(e.status ? e.message : "Could not add it. Try again."); }
}

async function doScan(msg, ca, chain, explicit) {
  const group = msg.chat.type !== "private";
  if (limited(msg.from.id)) { if (!group || explicit) await reply(msg, "⏳ Slow down a little. Try again in a minute."); return; }
  const k = msg.chat.id + "|" + ca.toLowerCase();
  if (group && !explicit && Date.now() - (seen.get(k) || 0) < 45000) return; // avoid group spam
  seen.set(k, Date.now()); if (seen.size > 2000) seen.delete(seen.keys().next().value);
  tg("sendChatAction", { chat_id: msg.chat.id, action: "typing" });
  try {
    const deep = detect(ca) === "sol" && !!process.env.HELIUS_API_KEY;
    const r = await runScan(ca, chain, deep ? { noDeep: true } : undefined); // fast first answer
    const c = card(r, SITE(), { pending: deep });
    const sent = await reply(msg, c.text, { reply_markup: c.reply_markup });
    if (deep && sent && sent.ok) { // then fill in the slow Solana deep scan
      const full = await runScan(ca, chain).catch(() => null);
      if (full) { const c2 = card(full, SITE());
        await tg("editMessageText", { chat_id: msg.chat.id, message_id: sent.result.message_id, text: c2.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: c2.reply_markup }); }
      else await tg("editMessageText", { chat_id: msg.chat.id, message_id: sent.result.message_id, text: c.text.replace("🧬 Deep scan running… (holders, snipers, bundlers)", "🧬 Deep scan unavailable"), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: c.reply_markup });
    }
  } catch (e) {
    if (!group || explicit) await reply(msg, "⚠️ " + esc(e.status ? e.message : "Scan failed. Try again."));
  }
}

async function onMessage(msg) {
  if (!msg || !msg.chat || !msg.from || msg.from.is_bot) return;
  const text = msg.text || msg.caption || "";
  const cmd = text.match(/^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  const me = process.env.TELEGRAM_BOT_USERNAME;
  if (cmd) {
    if (cmd[2] && me && cmd[2].toLowerCase() !== me.toLowerCase().replace(/^@/, "")) return; // meant for another bot
    const name = cmd[1].toLowerCase(), args = (cmd[3] || "").trim().split(/\s+/).filter(Boolean);
    if (name === "start" || name === "help") return void (await reply(msg, HELP));
    if (name === "scan" || name === "s" || name === "check") {
      let ca = args.map(findCA).find(Boolean);
      if (!ca && msg.reply_to_message) ca = findCA(msg.reply_to_message.text || msg.reply_to_message.caption);
      if (!ca) return void (await reply(msg, "Send a contract address, for example:\n<code>/scan 0x… bsc</code>"));
      const ch = args.map((a) => CHAIN[a.toLowerCase()]).find(Boolean) || "auto";
      return void (await doScan(msg, ca, ch, true));
    }
    if (name === "watch") {
      let ca = args.map(findCA).find(Boolean);
      if (!ca && msg.reply_to_message) ca = findCA(msg.reply_to_message.text || msg.reply_to_message.caption);
      if (!ca) return void (await reply(msg, "Usage: <code>/watch &lt;address&gt;</code>"));
      const ch = args.map((a) => CHAIN[a.toLowerCase()]).find(Boolean) || "auto";
      return void (await watchFlow(msg.from, ca, ch, (m) => reply(msg, esc(m))));
    }
    if (name === "unwatch") {
      const ca = args.map(findCA).find(Boolean);
      if (!ca || !db.on()) return void (await reply(msg, "Usage: <code>/unwatch &lt;address&gt;</code>"));
      await W.removeWatch(msg.from.id, ca);
      return void (await reply(msg, "Removed from your watchlist."));
    }
    if (name === "list" || name === "watchlist") {
      if (!db.on()) return void (await reply(msg, "Alerts are not set up yet."));
      const ws = await W.listWatches(msg.from.id);
      if (!ws.length) return void (await reply(msg, "Your watchlist is empty. Use <code>/watch &lt;address&gt;</code> or tap 👁 Watch on a scan."));
      return void (await reply(msg, `<b>Your watchlist</b> (${ws.length}/${W.MAX_WATCH})\nTap to stop watching:`, { reply_markup: { inline_keyboard:
        ws.map((w) => [{ text: `❌ ${(w.symbol || w.name || w.address).slice(0, 20)} · ${w.chain}`, callback_data: "u:" + w.address }]) } }));
    }
    return;
  }
  const ca = findCA(text);
  if (ca) await doScan(msg, ca, "auto", false);
}

async function onCallback(q) {
  const data = q.data || "";
  if (data.startsWith("w:") || data.startsWith("u:")) {
    const ca = data.slice(2);
    if (!detect(ca)) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
    if (data[0] === "u") {
      if (db.on()) await W.removeWatch(q.from.id, ca).catch(() => {});
      return void (await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Removed from your watchlist." }));
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Setting up alerts..." });
    return void (await watchFlow(q.from, ca, "auto", (m) => tg("answerCallbackQuery", { callback_query_id: q.id, text: m.slice(0, 190), show_alert: true })));
  }
  if (!data.startsWith("r:") || !q.message) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
  const ca = data.slice(2);
  if (!detect(ca)) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
  if (limited(q.from.id)) return void (await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Slow down a little.", show_alert: false }));
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Rescanning..." });
  try {
    const edit = (c) => tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: c.text,
      parse_mode: "HTML", disable_web_page_preview: true, reply_markup: c.reply_markup });
    const deep = detect(ca) === "sol" && !!process.env.HELIUS_API_KEY;
    const r = await runScan(ca, "auto", deep ? { noDeep: true, fresh: true } : undefined);
    await edit(card(r, SITE(), { pending: deep }));
    if (deep) { const full = await runScan(ca, "auto", { fresh: true }).catch(() => null); if (full) await edit(card(full, SITE())); }
  } catch (e) { /* message not modified or scan failed: ignore */ }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("CBL scanner bot");
  if (!TOKEN() || !process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(500).json({ ok: false, error: "Bot not configured" });
  if (!safeEq(req.headers["x-telegram-bot-api-secret-token"], process.env.TELEGRAM_WEBHOOK_SECRET)) return res.status(401).end();
  const u = req.body || {};
  try {
    if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message) await onMessage(u.message);
  } catch (e) { /* always answer 200 so Telegram does not retry */ }
  return res.status(200).json({ ok: true });
};
