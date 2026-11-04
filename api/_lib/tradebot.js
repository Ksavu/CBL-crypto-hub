// Telegram UI for the CBL trading bot (BonkBot-style). Wired from api/telegram.js.
//   Commands (DM only): /trade /positions /withdraw /export /settings, plus /buy <ca> <amount> and /sell <ca> <percent>
//   Callback data starts with "T" (64-byte Telegram limit: chain code + one char + address fits).
const T = require("./trade");
const { esc, shortA } = require("./format");

const CA_RE = /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/;
const SELL = { 1: 25, 2: 50, 4: 100 };
const NOTE = "🔐 This is a custodial wallet: CBL keeps its keys encrypted on the server so the bot can trade for you. Only deposit what you're willing to risk, and export your keys any time with /export.";
const nat = (c) => T.CH[c].nat;

function chainOf(ca, hint) {
  if (hint && T.CODE[hint]) return T.CODE[hint];
  if (/^0x[a-fA-F0-9]{40}$/.test(ca)) return null; // EVM: chain needed
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) ? "s" : null;
}
const fmt = (v, c) => T.fromUnits(v, T.CH[c].dec);
const n2 = (x, d = 4) => (x == null ? "n/a" : Math.abs(x) >= 1 ? x.toFixed(Math.min(2, d)) : x.toPrecision(3));
const usd = (x) => (x == null ? "" : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + (x / 1e3).toFixed(1) + "K" : "$" + x.toFixed(2));
const big = (raw, dec) => { const x = Number(raw) / 10 ** dec; return x >= 1e9 ? (x / 1e9).toFixed(2) + "B" : x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "K" : x.toPrecision(4); };

/** Buttons added to a token scan card. In groups: a deep link to trade in DM. */
function tradeRows(r, isPrivate, botUser) {
  const c = T.CODE[r.chain]; if (!c || !T.on()) return [];
  const ca = r.address;
  if (!isPrivate) return botUser ? [[{ text: "🤖 Trade it with CBL Bot", url: `https://t.me/${botUser.replace(/^@/, "")}?start=tr_${c}_${ca}` }]] : [];
  const p = T.CH[c].presets;
  return [
    [...p.map((a, i) => ({ text: `🟢 ${a} ${nat(c)}`, callback_data: `Tb${c}${i}:${ca}` })), { text: "🟢 X", callback_data: `Tb${c}x:${ca}` }],
    [{ text: "🔴 25%", callback_data: `Tx${c}1:${ca}` }, { text: "🔴 50%", callback_data: `Tx${c}2:${ca}` }, { text: "🔴 100%", callback_data: `Tx${c}4:${ca}` }, { text: "📊 Position", callback_data: `Tv${c}:${ca}` }],
  ];
}

function introMsg() {
  return { text: `<b>🤖 CBL Trading</b>\nBuy and sell any token on <b>Solana, BNB Chain, Base and Robinhood Chain</b> right here — including pump.fun, Four.meme and Pons bonding-curve tokens.\n\n• One tap buy/sell from any scan\n• Positions with profit/loss\n• Fee: <b>${T.feeBps() / 100}%</b> per trade\n\n${NOTE}\n\nTap below to create your wallets (one Solana + one EVM wallet for BNB/Base/Robinhood).`,
    reply_markup: { inline_keyboard: [[{ text: "✅ Create my wallets", callback_data: "Tc" }]] } };
}

async function menuMsg(row) {
  const b = await T.balances(row), st = T.settings(row);
  const line = (c) => `${b[c] == null ? "?" : fmt(b[c], c)} ${nat(c)}`;
  return { text: `<b>💼 CBL Trading</b>\n\n◎ <b>Solana</b> · ${line("s")}\n<code>${row.sol_pub}</code>\n\n⬡ <b>EVM</b> (same address on all three)\n<code>${row.evm_addr}</code>\nBNB Chain · ${line("b")}\nBase · ${line("e")}\nRobinhood · ${line("r")}\n\nPaste any token address to trade it. Slippage ${st.slip}% · fee ${T.feeBps() / 100}%.`,
    reply_markup: { inline_keyboard: [
      [{ text: "📊 Positions", callback_data: "Tp" }, { text: "🔄 Refresh", callback_data: "Tm" }],
      [{ text: "📥 Deposit", callback_data: "Td" }, { text: "📤 Withdraw", callback_data: "TW" }],
      [{ text: "⚙️ Settings", callback_data: "Ts" }, { text: "🔑 Export keys", callback_data: "Tk" }],
    ] } };
}

async function positionsMsg(uid) {
  const { list } = await T.positions(uid);
  if (!list.length) return { text: "<b>📊 Positions</b>\n\nNo positions yet. Paste a token address and tap 🟢 Buy.", reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "Tm" }]] } };
  const L = ["<b>📊 Positions</b>", ""], kb = [];
  for (const p of list.slice(0, 12)) {
    const c = T.CODE[p.chain], s = p.sym || shortA(p.token), pnl = p.pnlNat == null ? "" : ` · ${p.pnlNat >= 0 ? "🟢 +" : "🔴 "}${n2(p.pnlNat)} ${nat(c)}${p.pnlPct != null ? ` (${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(0)}%)` : ""}`;
    L.push(`${p.url ? `<a href="${p.url}">${esc(s)}</a>` : `<b>${esc(s)}</b>`} · ${T.CH[c].name}\n  ${p.raw > 0n ? big(p.raw, p.dec) : "sold"}${p.valueUsd ? ` ≈ ${usd(p.valueUsd)}` : ""}${pnl}`);
    kb.push([{ text: `${s.slice(0, 12)} · ${T.CH[c].name}`, callback_data: `Tv${c}:${p.token}` }]);
  }
  L.push("", "<i>PnL counts trades made through this bot.</i>");
  kb.push([{ text: "🔄 Refresh", callback_data: "Tp" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}

async function panelMsg(uid, c, ca, head) {
  const row = await T.getRow(uid), [p, bal] = await Promise.all([T.tokenView(uid, c, ca).catch(() => null), T.nativeBal(row, c).catch(() => null)]);
  const cv = c === "b" || c === "r" ? await T.curveOf(c, ca) : null;
  const L = [];
  if (head) L.push(head, "");
  L.push(`🪙 <b>${esc((p && p.sym) || shortA(ca))}</b> · ${T.CH[c].name}${cv ? ` · 🎢 ${cv.pad} curve` : ""}`, `<code>${ca}</code>`);
  if (p && p.priceUsd) L.push(`Price: $${p.priceUsd.toPrecision(4)}`);
  L.push(`Wallet: ${bal == null ? "?" : fmt(bal, c)} ${nat(c)}`);
  if (p && p.raw > 0n) L.push(`Holding: ${big(p.raw, p.dec)}${p.valueUsd ? ` ≈ ${usd(p.valueUsd)} (${n2(p.valueNat)} ${nat(c)})` : ""}`);
  if (p && p.pnlNat != null) L.push(`PnL: ${p.pnlNat >= 0 ? "🟢 +" : "🔴 "}${n2(p.pnlNat)} ${nat(c)}${p.pnlPct != null ? ` (${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%)` : ""}`);
  L.push(`Slippage ${T.settings(row).slip}% · fee ${T.feeBps() / 100}%`);
  const kb = tradeRows({ chain: T.CH[c].key, address: ca }, true);
  kb[1][3] = { text: "🔄 Refresh", callback_data: `Tv${c}:${ca}` };
  kb.push([{ text: "📊 Positions", callback_data: "Tp" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}

function errText(e) {
  if (e instanceof T.UserErr) return "⚠️ " + esc(e.message);
  const m = String((e && (e.shortMessage || e.message)) || e);
  if (/insufficient funds/i.test(m)) return "⚠️ Not enough balance for this trade plus gas.";
  console.error("trade error", m);
  return "⚠️ The trade didn't go through: " + esc(m.slice(0, 160));
}

function make(tg) {
  const send = (chat, m, extra) => tg("sendMessage", Object.assign({ chat_id: chat, text: m.text || m, parse_mode: "HTML", disable_web_page_preview: true }, m.reply_markup ? { reply_markup: m.reply_markup } : {}, extra || {}));
  const edit = (chat, mid, m) => tg("editMessageText", { chat_id: chat, message_id: mid, text: m.text || m, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup });
  const notReady = () => (!T.on() ? "Trading isn't switched on yet." : null);

  async function doBuy(chat, uid, c, ca, amount, mid) {
    const st = mid ? (await edit(chat, mid, `⏳ Buying with ${esc(amount)} ${nat(c)}…`), { result: { message_id: mid } }) : await send(chat, `⏳ Buying with ${esc(amount)} ${nat(c)}…`);
    const id = st && st.result && st.result.message_id;
    try {
      const r = await T.buy(uid, c, ca, amount);
      const head = `✅ <b>Bought</b> ${r.out > 0n ? big(r.out, r.dec) + " tokens " : ""}for ${esc(amount)} ${nat(c)} via ${esc(r.route)}${r.fee > 0n ? ` (fee ${fmt(r.fee, c)})` : ""}\n<a href="${T.CH[c].exp}${r.hash}">View transaction</a>`;
      await edit(chat, id, await panelMsg(uid, c, ca, head));
    } catch (e) { await edit(chat, id, { text: errText(e), reply_markup: { inline_keyboard: [[{ text: "📊 Token panel", callback_data: `Tv${c}:${ca}` }, { text: "⬅️ Menu", callback_data: "Tm" }]] } }); }
  }
  async function doSell(chat, uid, c, ca, pct, mid) {
    const st = mid ? (await edit(chat, mid, `⏳ Selling ${pct}%…`), { result: { message_id: mid } }) : await send(chat, `⏳ Selling ${pct}%…`);
    const id = st && st.result && st.result.message_id;
    try {
      const r = await T.sell(uid, c, ca, pct);
      const head = `✅ <b>Sold</b> ${pct}% (${big(r.sold, r.dec)}) for ~${fmt(r.out, c)} ${nat(c)} via ${esc(r.route)}${r.fee > 0n ? ` (fee ${fmt(r.fee, c)})` : ""}\n<a href="${T.CH[c].exp}${r.hash}">View transaction</a>`;
      await edit(chat, id, await panelMsg(uid, c, ca, head));
    } catch (e) { await edit(chat, id, { text: errText(e), reply_markup: { inline_keyboard: [[{ text: "📊 Token panel", callback_data: `Tv${c}:${ca}` }, { text: "⬅️ Menu", callback_data: "Tm" }]] } }); }
  }
  async function openMenu(chat, uid, mid) {
    const row = await T.getRow(uid), m = row ? await menuMsg(row) : introMsg();
    return mid ? edit(chat, mid, m) : send(chat, m);
  }
  const dmOnly = (msg) => msg.chat.type !== "private";
  async function sendKeys(chat, row, first) {
    const V = require("./vault");
    await send(chat, `🔑 <b>${first ? "Save your private keys now" : "Your private keys"}</b>\nTap to reveal. Store them somewhere safe (password manager or offline), then <b>delete this message</b>. Anyone with these keys controls your funds.\n\n◎ Solana (import into Phantom/Solflare):\n<tg-spoiler><code>${V.solExport(V.solSeed(row))}</code></tg-spoiler>\n\n⬡ EVM (MetaMask/Rabby, same on BNB/Base/Robinhood):\n<tg-spoiler><code>${V.evmPk(row)}</code></tg-spoiler>${first ? "\n\nYou can show them again any time with /export." : ""}`, { protect_content: true });
  }

  /** Commands. Returns true when handled. */
  async function command(name, args, msg, botUser) {
    const map = { trade: 1, menu: 1, positions: 1, pos: 1, withdraw: 1, export: 1, settings: 1, buy: 1, sell: 1 };
    if (!map[name]) return false;
    if (dmOnly(msg)) { await send(msg.chat.id, botUser ? `Trading works in a private chat: <a href="https://t.me/${botUser.replace(/^@/, "")}?start=trade">open CBL Bot</a>` : "Trading works in a private chat with me."); return true; }
    const nr = notReady(); if (nr) { await send(msg.chat.id, nr); return true; }
    const uid = msg.from.id, chat = msg.chat.id;
    if (name === "trade" || name === "menu") { await openMenu(chat, uid); return true; }
    const row = await T.getRow(uid); if (!row) { await send(chat, introMsg()); return true; }
    if (name === "positions" || name === "pos") { await send(chat, await positionsMsg(uid)); return true; }
    if (name === "settings") { await send(chat, settingsMsg(row)); return true; }
    if (name === "export") { await send(chat, exportAsk()); return true; }
    if (name === "withdraw") { await send(chat, withdrawPick()); return true; }
    const ca = (args.find((a) => CA_RE.test(a)) || "").match(CA_RE), chainArg = args.map((a) => ({ sol: "solana", solana: "solana", bsc: "bsc", bnb: "bsc", base: "base", rh: "robinhood", robinhood: "robinhood" })[a.toLowerCase()]).find(Boolean);
    const num = args.find((a) => /^\d*\.?\d+%?$/.test(a));
    if (!ca || !num) { await send(chat, name === "buy" ? "Usage: <code>/buy &lt;token&gt; &lt;amount&gt; [chain]</code>\nExample: <code>/buy 0xabc… 0.05 bsc</code>" : "Usage: <code>/sell &lt;token&gt; &lt;percent&gt; [chain]</code>\nExample: <code>/sell 7GCi…pump 50</code>"); return true; }
    const c = chainOf(ca[0], chainArg); if (!c) { await send(chat, "Add the chain for EVM tokens: <code>bsc</code>, <code>base</code> or <code>robinhood</code>."); return true; }
    if (name === "buy") await doBuy(chat, uid, c, ca[0], num.replace("%", ""));
    else await doSell(chat, uid, c, ca[0], Number(num.replace("%", "")));
    return true;
  }

  /** /start tr_<c>_<ca> and /start trade deep links. */
  async function start(arg, msg) {
    if (arg === "trade") { const nr = notReady(); if (nr) await send(msg.chat.id, nr); else await openMenu(msg.chat.id, msg.from.id); return true; }
    const m = /^tr_([sber])_(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(arg || "");
    if (!m) return false;
    const nr = notReady(); if (nr) { await send(msg.chat.id, nr); return true; }
    if (!(await T.getRow(msg.from.id))) { await send(msg.chat.id, introMsg()); return true; }
    await send(msg.chat.id, await panelMsg(msg.from.id, m[1], m[2]));
    return true;
  }

  function settingsMsg(row) {
    const s = T.settings(row).slip, opt = [1, 5, 10, 20, 30];
    return { text: `<b>⚙️ Settings</b>\n\nSlippage: <b>${s}%</b>\nHigher slippage fills faster on volatile tokens but can cost more. Solana trades use Jupiter's automatic slippage.`,
      reply_markup: { inline_keyboard: [opt.map((o) => ({ text: (o === s ? "✅ " : "") + o + "%", callback_data: "Tl" + o })), [{ text: "⬅️ Menu", callback_data: "Tm" }]] } };
  }
  const exportAsk = () => ({ text: "🔑 <b>Export private keys</b>\n\nAnyone with these keys controls your funds. Never share them, and delete the message after saving them.\n\nShow keys now?", reply_markup: { inline_keyboard: [[{ text: "Yes, show my keys", callback_data: "Tkk" }, { text: "Cancel", callback_data: "Tm" }]] } });
  const withdrawPick = () => ({ text: "<b>📤 Withdraw</b>\nWhich coin?", reply_markup: { inline_keyboard: [[{ text: "SOL", callback_data: "Tws" }, { text: "BNB", callback_data: "Twb" }], [{ text: "ETH · Base", callback_data: "Twe" }, { text: "ETH · Robinhood", callback_data: "Twr" }], [{ text: "⬅️ Menu", callback_data: "Tm" }]] } });

  /** Callback queries starting with "T". Returns true when handled. */
  async function callback(q) {
    const d = q.data || ""; if (d[0] !== "T") return false;
    const ack = (text, alert) => tg("answerCallbackQuery", Object.assign({ callback_query_id: q.id }, text ? { text, show_alert: !!alert } : {}));
    if (!q.message || q.message.chat.type !== "private") { await ack("Open the bot in a private chat to trade.", true); return true; }
    const nr = notReady(); if (nr) { await ack(nr, true); return true; }
    const uid = q.from.id, chat = q.message.chat.id, mid = q.message.message_id, k = d[1];
    if (k === "c") {
      await ack("Creating your wallets…");
      const r = await T.ensure(uid); await openMenu(chat, uid, mid);
      if (r.created) await sendKeys(chat, r.row, true); // show the keys once right away, like BonkBot
      return true;
    }
    const row = await T.getRow(uid); if (!row) { await ack(); await send(chat, introMsg()); return true; }
    if (k === "m") { await ack(); await openMenu(chat, uid, mid); return true; }
    if (k === "p") { await ack("Loading positions…"); await edit(chat, mid, await positionsMsg(uid)); return true; }
    if (k === "d") { await ack(); await send(chat, `<b>📥 Deposit</b>\n\nSend <b>SOL</b> to:\n<code>${row.sol_pub}</code>\n\nSend <b>BNB</b> (BNB Chain) or <b>ETH</b> (Base / Robinhood Chain) to:\n<code>${row.evm_addr}</code>\n\nTap an address to copy it. Only send on these networks.`); return true; }
    if (k === "s") { await ack(); await edit(chat, mid, settingsMsg(row)); return true; }
    if (k === "l") { const v = Number(d.slice(2)); if ([1, 5, 10, 20, 30].includes(v)) await T.saveSettings(uid, Object.assign(T.settings(row), { slip: v })); await ack("Slippage " + v + "%"); await edit(chat, mid, settingsMsg(await T.getRow(uid))); return true; }
    if (d === "Tk") { await ack(); await edit(chat, mid, exportAsk()); return true; }
    if (d === "Tkk") { await ack(); await sendKeys(chat, row); return true; }
    if (d === "TW") { await ack(); await edit(chat, mid, withdrawPick()); return true; }
    if (k === "w" && T.CH[d[2]]) { await ack(); await send(chat, `📤 <b>Withdraw ${nat(d[2])} on ${T.CH[d[2]].name}</b>\nReply to this message with the amount (or <code>all</code>) and the destination address:\n<code>0.5 ADDRESS</code>\n#withdraw:${d[2]}`, { reply_markup: { force_reply: true, input_field_placeholder: "amount address" } }); return true; }
    if (k === "y") {
      const p = T.settings(row).pend;
      if (!p || p.exp < Date.now()) { await ack("This withdrawal expired. Start again.", true); return true; }
      await T.saveSettings(uid, Object.assign(T.settings(row), { pend: null }));
      await ack("Sending…"); await edit(chat, mid, "⏳ Sending…");
      try { const r = await T.withdraw(uid, p.c, p.amount, p.to); await edit(chat, mid, `✅ Sent ${fmt(r.amt, p.c)} ${nat(p.c)} to <code>${esc(p.to)}</code>\n<a href="${T.CH[p.c].exp}${r.hash}">View transaction</a>`); }
      catch (e) { await edit(chat, mid, errText(e)); }
      return true;
    }
    if (k === "n") { await T.saveSettings(uid, Object.assign(T.settings(row), { pend: null })); await ack("Cancelled"); await edit(chat, mid, "Withdrawal cancelled."); return true; }
    // token actions: Tv<c>:<ca>  Tb<c><i|x>:<ca>  Tx<c><1|2|4|x>:<ca>
    const m = /^T([vbx])([sber])([0-9x]?):(.+)$/.exec(d);
    if (!m) { await ack(); return true; }
    const [, act, c, opt, ca] = m;
    if (act === "v") { await ack(); const fromCard = !/Wallet:/.test(q.message.text || ""); const pm = await panelMsg(uid, c, ca); if (fromCard) await send(chat, pm); else await edit(chat, mid, pm); return true; }
    const isPanel = /Wallet:/.test(q.message.text || "");
    if (act === "b") {
      if (opt === "x") { await ack(); await send(chat, `✏️ How much <b>${nat(c)}</b> to spend?\nToken: <code>${ca}</code> · ${T.CH[c].name}\nReply with a number, e.g. <code>0.2</code>\n#buy:${c}`, { reply_markup: { force_reply: true, input_field_placeholder: "0.2" } }); return true; }
      const amt = T.CH[c].presets[Number(opt)]; if (amt == null) { await ack(); return true; }
      await ack("Buying…"); await doBuy(chat, uid, c, ca, String(amt), isPanel ? mid : null); return true;
    }
    if (act === "x") {
      if (opt === "x") { await ack(); await send(chat, `✏️ What % of your tokens to sell?\nToken: <code>${ca}</code> · ${T.CH[c].name}\nReply with a number from 1 to 100\n#sell:${c}`, { reply_markup: { force_reply: true, input_field_placeholder: "50" } }); return true; }
      const pct = SELL[opt]; if (!pct) { await ack(); return true; }
      await ack("Selling…"); await doSell(chat, uid, c, ca, pct, isPanel ? mid : null); return true;
    }
    await ack(); return true;
  }

  /** Replies to the bot's ✏️ prompts. Returns true when handled. */
  async function replyPrompt(msg) {
    const r = msg.reply_to_message; if (!r || !r.from || !r.from.is_bot || msg.chat.type !== "private") return false;
    const tag = /#(buy|sell|withdraw):([sber])\s*$/.exec(r.text || ""); if (!tag) return false;
    const nr = notReady(); if (nr) { await send(msg.chat.id, nr); return true; }
    const [, kind, c] = tag, uid = msg.from.id, chat = msg.chat.id, txt = (msg.text || "").trim();
    if (kind === "withdraw") {
      const [amt, to] = txt.split(/\s+/);
      if (!amt || !to || !(/^all$/i.test(amt) || /^\d*\.?\d+$/.test(amt))) { await send(chat, "Reply with the amount and address, e.g. <code>0.5 ADDRESS</code> or <code>all ADDRESS</code>."); return true; }
      const row = await T.getRow(uid); if (!row) return true;
      await T.saveSettings(uid, Object.assign(T.settings(row), { pend: { c, amount: amt, to, exp: Date.now() + 5 * 60000 } }));
      await send(chat, { text: `Confirm withdrawal:\n<b>${esc(amt)} ${nat(c)}</b> on ${T.CH[c].name}\nto <code>${esc(to)}</code>\n\nDouble-check the address — this can't be undone.`, reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: "Ty" }, { text: "❌ Cancel", callback_data: "Tn" }]] } });
      return true;
    }
    const ca = ((r.text || "").match(CA_RE) || [])[0]; if (!ca) return true;
    if (!/^\d*\.?\d+%?$/.test(txt)) { await send(chat, "Please reply with just a number."); return true; }
    if (kind === "buy") await doBuy(chat, uid, c, ca, txt);
    else await doSell(chat, uid, c, ca, Number(txt.replace("%", "")));
    return true;
  }

  return { command, callback, replyPrompt, start };
}

module.exports = { make, tradeRows };
