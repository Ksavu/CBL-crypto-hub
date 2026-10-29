// Telegram webhook: POST /api/telegram  (set with setWebhook + secret_token, see TELEGRAM_SETUP.md)
const crypto = require("crypto");
const { runScan, detect } = require("./_lib/scanner");
const { card, auditCard, HELP, esc, cb, uncb, walletReport, shortA, chainName } = require("./_lib/format");
const WT = require("./_lib/wallets");
const { runAudit } = require("./audit");
const db = require("./_lib/db");
const W = require("./_lib/watch");

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const SITE = () => (process.env.SITE_URL || "https://cryptobarlounge.space").replace(/\/$/, "");
const AUDIT_CHAIN = { poly: "polygon", matic: "polygon", polygon: "polygon", arb: "arbitrum", arbitrum: "arbitrum", op: "optimism", optimism: "optimism", avax: "avalanche", avalanche: "avalanche",
  linea: "linea", scroll: "scroll", zksync: "zksync", blast: "blast", mantle: "mantle", gnosis: "gnosis", xdai: "gnosis", celo: "celo", ftm: "fantom", fantom: "fantom", sonic: "sonic", opbnb: "opbnb",
  cronos: "cronos", mode: "mode", uni: "unichain", unichain: "unichain", bera: "berachain", berachain: "berachain", abstract: "abstract", ink: "ink", taiko: "taiko", moonbeam: "moonbeam", kaia: "kaia", hyper: "hyperevm", hyperevm: "hyperevm", zkevm: "polygonzkevm" };
const CHAIN = { eth: "ethereum", ethereum: "ethereum", bsc: "bsc", bnb: "bsc", base: "base", rh: "robinhood", robinhood: "robinhood", sol: "solana", solana: "solana", lunc: "terraclassic", terra: "terraclassic", terraclassic: "terraclassic",
  arb: "arbitrum", arbitrum: "arbitrum", poly: "polygon", matic: "polygon", polygon: "polygon", op: "optimism", optimism: "optimism", avax: "avalanche", avalanche: "avalanche",
  linea: "linea", blast: "blast", zksync: "zksync", scroll: "scroll", mantle: "mantle", sonic: "sonic", uni: "unichain", unichain: "unichain", cro: "cronos", cronos: "cronos", xrpl: "xrpl", xrp: "xrpl" };
const TERRA_RE = /\bterra1(?:[02-9ac-hj-np-z]{58}|[02-9ac-hj-np-z]{38})\b/i, XRPL_RE = /\b(?:[A-Za-z0-9]{1,20}\.)?r[1-9A-HJ-NP-Za-km-z]{24,34}\b/, EVM_RE = /\b0x[a-fA-F0-9]{40}\b/, SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const seen = new Map(), users = new Map(); // per warm instance

function tg(method, body) {
  return fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null);
}
function findCA(text) {
  const m = (text || "").match(TERRA_RE) || (text || "").match(XRPL_RE) || (text || "").match(EVM_RE) || (text || "").match(SOL_RE);
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

// Wallet tracker: alerts go to the user's DM.
const walletArg = (args) => args.find((a) => WT.familyOf(a));
async function trackFlow(user, addr, chain, label, say) {
  if (!db.on()) return say("Alerts are not set up yet.");
  if (limited(user.id)) return say("Slow down a little.");
  const ok = await tg("sendMessage", { chat_id: user.id, text: "👤 Setting up wallet tracking… (checking which chains it uses)" });
  if (!ok || !ok.ok) return say("I can't message you privately yet. Open the bot, press Start, then try again.");
  try {
    const r = await WT.addTrack(user.id, addr, label, chain);
    if (r.dup) return void (await tg("sendMessage", { chat_id: user.id, text: "You already track this wallet." }));
    if (r.full) return void (await tg("sendMessage", { chat_id: user.id, text: `You track ${r.max} wallets already. Use /wallets to remove one.` }));
    const where = r.family === "evm" ? r.chains.map(chainName).join(", ") : chainName(r.family);
    await tg("sendMessage", { chat_id: user.id, parse_mode: "HTML", disable_web_page_preview: true, text: `✅ Tracking ${label ? "<b>" + esc(label) + "</b> " : ""}<code>${esc(r.address)}</code>\nChains: ${esc(where)}\n\nI'll message you here when it buys, sells, creates a new token or sends tokens out. Checks run every few minutes.${r.family === "evm" ? "\n<i>Wrong chain? Use</i> <code>/track " + esc(r.address) + " base</code> <i>to add one.</i>" : ""}` });
    return say("Tracking. Alerts will arrive in your DM.");
  } catch (e) { if (!e.status) console.error("track error", e && e.stack || e); return say(e.status ? e.message : "Could not track it. Try again."); }
}
async function doWallet(msg, addr, chain) {
  if (limited(msg.from.id)) return void (await reply(msg, "⏳ Slow down a little. Try again in a minute."));
  tg("sendChatAction", { chat_id: msg.chat.id, action: "typing" });
  try {
    const r = await WT.activity(addr, 7, chain, Date.now() + 20000);
    const tracked = db.on() ? (await WT.listTracks(msg.from.id).catch(() => [])).some((t) => t.address === r.address) : false;
    const c = walletReport(r, SITE(), tracked);
    await reply(msg, c.text, { reply_markup: c.reply_markup });
  } catch (e) { if (!e.status) console.error("wallet error", e && e.stack || e); await reply(msg, "⚠️ " + esc(e.status ? e.message : "Could not load this wallet. Try again.")); }
}

async function doAudit(msg, ca, chain) {
  if (limited(msg.from.id)) return void (await reply(msg, "⏳ Slow down a little. Try again in a minute."));
  tg("sendChatAction", { chat_id: msg.chat.id, action: "typing" });
  try {
    const r = await runAudit({ ca, chain });
    const c = auditCard(r, SITE());
    await reply(msg, c.text, { reply_markup: c.reply_markup });
  } catch (e) { await reply(msg, esc(e.status ? e.message : "Audit failed. Try again.")); }
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
    if (!e.status) console.error("scan error", e && e.stack || e);
    if (e.status === 404 && WT.familyOf(ca) && (!group || explicit)) return void (await reply(msg, `⚠️ ${esc(e.message)}\n\nIf <code>${esc(shortA(ca))}</code> is a <b>wallet</b>, not a token, I can show its activity or track it.`,
      { reply_markup: { inline_keyboard: [[{ text: "📊 Wallet activity", callback_data: "v:" + cb(WT.normAddr(ca)) }, { text: "👤 Track wallet", callback_data: "t:" + cb(WT.normAddr(ca)) }]] } }));
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
    if (name === "audit" || name === "a") {
      let ca = args.map((a) => (/^0x[a-fA-F0-9]{40}$/.test(a) ? a : null)).find(Boolean);
      if (!ca && msg.reply_to_message) ca = ((msg.reply_to_message.text || msg.reply_to_message.caption || "").match(/0x[a-fA-F0-9]{40}/) || [])[0];
      if (!ca) return void (await reply(msg, "Send an EVM contract address, for example:\n<code>/audit 0x… bsc</code>"));
      return void (await doAudit(msg, ca, args.map((a) => AUDIT_CHAIN[a.toLowerCase()] || CHAIN[a.toLowerCase()]).find(Boolean) || "auto"));
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
    if (name === "track" || name === "follow") {
      let w = walletArg(args);
      if (!w && msg.reply_to_message) w = ((msg.reply_to_message.text || "").split(/\s+/)).find((a) => WT.familyOf(a));
      if (!w) return void (await reply(msg, "Usage: <code>/track &lt;wallet&gt; [chain] [name]</code>\nExample: <code>/track 0xAbC… base Dev of PEPE</code>"));
      const ch = args.map((a) => CHAIN[a.toLowerCase()]).find(Boolean);
      const label = args.filter((a) => a !== w && !CHAIN[a.toLowerCase()]).join(" ").slice(0, 24) || null;
      return void (await trackFlow(msg.from, w, ch, label, (m) => reply(msg, esc(m))));
    }
    if (name === "untrack" || name === "unfollow") {
      const w = walletArg(args);
      if (!w || !db.on()) return void (await reply(msg, "Usage: <code>/untrack &lt;wallet&gt;</code>"));
      await WT.removeTrack(msg.from.id, w);
      return void (await reply(msg, "Stopped tracking that wallet."));
    }
    if (name === "wallets" || name === "tracked") {
      if (!db.on()) return void (await reply(msg, "Alerts are not set up yet."));
      const ws = await WT.listTracks(msg.from.id);
      if (!ws.length) return void (await reply(msg, "You don't track any wallets yet. Use <code>/track &lt;wallet&gt;</code> or tap 👤 Track dev on a scan."));
      return void (await reply(msg, `<b>Tracked wallets</b> (${ws.length}/${WT.MAX_TRACK})\nTap to stop tracking:`, { reply_markup: { inline_keyboard:
        ws.map((w) => [{ text: `❌ ${w.label ? w.label + " · " : ""}${shortA(w.address)} · ${WT.familyOf(w.address)}`, callback_data: "x:" + cb(w.address) }]) } }));
    }
    if (name === "wallet" || name === "w" || name === "dev") {
      const w = walletArg(args) || (msg.reply_to_message && (msg.reply_to_message.text || "").split(/\s+/).find((a) => WT.familyOf(a)));
      if (!w) return void (await reply(msg, "Usage: <code>/wallet &lt;wallet&gt; [chain]</code>"));
      return void (await doWallet(msg, w, args.map((a) => CHAIN[a.toLowerCase()]).find(Boolean)));
    }
    if (name === "list" || name === "watchlist") {
      if (!db.on()) return void (await reply(msg, "Alerts are not set up yet."));
      const ws = await W.listWatches(msg.from.id);
      if (!ws.length) return void (await reply(msg, "Your watchlist is empty. Use <code>/watch &lt;address&gt;</code> or tap 👁 Watch on a scan."));
      return void (await reply(msg, `<b>Your watchlist</b> (${ws.length}/${W.MAX_WATCH})\nTap to stop watching:`, { reply_markup: { inline_keyboard:
        ws.map((w) => [{ text: `❌ ${(w.symbol || w.name || w.address).slice(0, 20)} · ${w.chain}`, callback_data: "u:" + cb(w.address) }]) } }));
    }
    return;
  }
  const ca = findCA(text);
  if (ca) await doScan(msg, ca, "auto", false);
}

async function onCallback(q) {
  const data = q.data || "";
  if (/^[txvs]:/.test(data)) {
    const [raw, chain] = data.slice(2).split("|"), a = uncb(raw), k = data[0];
    if (k === "x") {
      if (db.on()) await WT.removeTrack(q.from.id, a).catch(() => {});
      return void (await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Stopped tracking that wallet." }));
    }
    if (k === "t") {
      if (!WT.familyOf(a)) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Setting up wallet tracking..." });
      return void (await trackFlow(q.from, a, chain || undefined, null, (m) => tg("sendMessage", { chat_id: q.from.id, text: m })));
    }
    if (!q.message) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
    const m = { chat: q.message.chat, from: q.from, message_id: q.message.message_id };
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: k === "v" ? "Loading wallet..." : "Scanning..." });
    if (k === "v") return void (await doWallet(m, a, chain));
    if (detect(a)) return void (await doScan(m, a, "auto", true));
    return;
  }
  if (data.startsWith("w:") || data.startsWith("u:")) {
    const ca = uncb(data.slice(2));
    if (!detect(ca)) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
    if (data[0] === "u") {
      if (db.on()) await W.removeWatch(q.from.id, ca).catch(() => {});
      return void (await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Removed from your watchlist." }));
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Setting up alerts..." });
    return void (await watchFlow(q.from, ca, "auto", (m) => tg("answerCallbackQuery", { callback_query_id: q.id, text: m.slice(0, 190), show_alert: true })));
  }
  if (data.startsWith("a:") && q.message) {
    const ca = uncb(data.slice(2));
    if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
    if (limited(q.from.id)) return void (await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Slow down a little." }));
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Auditing contract..." });
    return void (await doAudit({ chat: q.message.chat, from: q.from, message_id: q.message.message_id }, ca, "auto"));
  }
  if (!data.startsWith("r:") || !q.message) return void (await tg("answerCallbackQuery", { callback_query_id: q.id }));
  const ca = uncb(data.slice(2));
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
