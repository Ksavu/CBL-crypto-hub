// Telegram UI for the CBL trading bot (BonkBot-style). Wired from api/telegram.js.
//   Commands (DM only): /trade /positions /withdraw /export /settings, plus /buy <ca> <amount> and /sell <ca> <percent>
//   Paste a token address, a ticker ($PEPE) or a pump.fun / DEX Screener / Birdeye / GMGN link to trade it.
//   Callback data starts with "T" (Telegram limit 64 bytes: action + chain code + index + address fits).
const db = require("./db");
const T = require("./trade");
const O = require("./orders");
const B = require("./bundle");
const { esc, shortA } = require("./format");

const CA_RE = /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/;
const NOTE = "🔐 This is a custodial wallet: CBL keeps its keys encrypted on the server so the bot can trade for you. Only deposit what you're willing to risk.";
const nat = (c) => T.CH[c].nat;
const DS_CHAIN = { solana: "s", bsc: "b", base: "e", robinhood: "r" };

function chainOf(ca, hint) {
  if (hint && T.CODE[hint]) return T.CODE[hint];
  if (/^0x[a-fA-F0-9]{40}$/.test(ca)) return null; // EVM: chain needed
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) ? "s" : null;
}
const fmt = (v, c) => T.fromUnits(v, T.CH[c].dec);
const n2 = (x, d = 4) => (x == null ? "n/a" : Math.abs(x) >= 1 ? x.toFixed(Math.min(2, d)) : x.toPrecision(3));
const usd = (x) => (x == null ? "" : x >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? "$" + (x / 1e3).toFixed(1) + "K" : "$" + x.toFixed(2));
const big = (raw, dec) => { const x = Number(raw) / 10 ** dec; return x >= 1e9 ? (x / 1e9).toFixed(2) + "B" : x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "K" : x.toPrecision(4); };
const pnlTxt = (p, c) => (p.pnlNat == null ? "" : `${p.pnlNat >= 0 ? "🟢 +" : "🔴 "}${n2(p.pnlNat)} ${nat(c)}${p.pnlPct != null ? ` (${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(0)}%)` : ""}`);
const SORT = { val: "Most valuable", low: "Least valuable", az: "A → Z" };
const PRIO = { normal: "Normal", fast: "Fast", turbo: "Turbo" };

const bun = (c, st) => c === "s" && st && st.bundle; // Solana bundle mode (W1–W5 together)
/** Buttons added to a token scan card / token panel. In groups: a deep link to trade in DM. */
function tradeRows(r, isPrivate, botUser, st) {
  const c = T.CODE[r.chain]; if (!c || !T.on()) return [];
  const ca = r.address; st = st || T.settings(null);
  if (!isPrivate) return botUser ? [[{ text: "🍸 Order it from the Bartender", url: `https://t.me/${botUser.replace(/^@/, "")}?start=tr_${c}_${ca}` }]] : [];
  return [
    [...st.presets[c].map((a, i) => ({ text: `${bun(c, st) ? "📦" : "🟢"} ${a} ${nat(c)}`, callback_data: `Tb${c}${i}:${ca}` })), { text: `${bun(c, st) ? "📦" : "🟢"} X`, callback_data: `Tb${c}x:${ca}` }],
    [...st.sellP.map((p, i) => ({ text: `🔴 ${p}%`, callback_data: `Tx${c}${i}:${ca}` })), { text: "🔴 X%", callback_data: `Tx${c}x:${ca}` }],
    [{ text: "📊 Position", callback_data: `Tv${c}:${ca}` }],
  ];
}

function introMsg() {
  return { text: `<b>🍸 Welcome to CBL Bartender</b>\nTell the Bartender your order: buy and sell any token on <b>Solana, BNB Chain, Base and Robinhood Chain</b> right here, including pump.fun, Four.meme and Pons bonding-curve tokens.\n\n• Paste a token address, ticker or link to trade\n• One-tap buy/sell from any scan\n• Positions with profit/loss\n• Fee: <b>${T.feeBps() / 100}%</b> per trade\n\n${NOTE}\n\nTap below to create your wallets (one Solana + one EVM wallet for BNB/Base/Robinhood).`,
    reply_markup: { inline_keyboard: [[{ text: "✅ Create my wallets", callback_data: "Tc" }]] } };
}

function sortList(list, st) {
  const L = list.filter((p) => p.raw > 0n && (p.valueUsd == null || p.valueUsd >= (Number(st.minPos) || 0)));
  if (st.sort === "az") L.sort((a, b) => String(a.sym || a.token).localeCompare(String(b.sym || b.token)));
  else if (st.sort === "low") L.sort((a, b) => (a.valueUsd || 0) - (b.valueUsd || 0));
  else L.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  return L;
}

const HOME_KB = [
  [{ text: "🟢 Buy", callback_data: "TB" }, { text: "📈 Stocks", callback_data: "TX" }, { text: "🔮 Predict", callback_data: "TQ" }],
  [{ text: "📥 Fund", callback_data: "Td" }, { text: "👛 Wallet", callback_data: "TA" }, { text: "⚙️ Settings", callback_data: "Ts" }],
  [{ text: "📊 Positions", callback_data: "Tp" }, { text: "🎯 Orders (TP/SL/limit)", callback_data: "To" }],
  [{ text: "🍸 Open CBL Bartender App", url: (process.env.SITE_URL || "https://cryptobarlounge.space").replace(/\/$/, "") + "/bartender" }],
  [{ text: "👥 Copy trade", callback_data: "TC" }, { text: "🔔 Alerts", callback_data: "TL" }, { text: "⭐ Points", callback_data: "TP" }],
  [{ text: "🤝 Referrals", callback_data: "TR" }, { text: "❓ Help", callback_data: "TH" }, { text: "🔄 Refresh", callback_data: "Tm" }],
];
async function menuMsg(row) {
  const st = T.settings(row);
  const [b, pos] = await Promise.all([T.balances(row), T.positions(row.tg_id).catch(() => ({ list: [] }))]);
  const line = (c) => `${b[c] == null ? "?" : fmt(b[c], c)} ${nat(c)}`;
  const empty = Object.values(b).every((v) => v == null || v === 0n);
  const L = ["<b>🍸 CBL Bartender</b> · what are you having?", ""];
  if (empty) L.push("You have no funds yet. To start trading, deposit to your wallets:", "");
  L.push(`◎ <b>Solana</b> · ${line("s")}`, `<code>${row.sol_pub}</code> (tap to copy)`, "",
    `⬡ <b>EVM</b> · BNB ${line("b").replace(" BNB", "")} · Base ${line("e")} · Robinhood ${line("r")}`, `<code>${row.evm_addr}</code> (tap to copy)`);
  const top = sortList(pos.list || [], st).slice(0, 5);
  if (top.length) {
    L.push("", "<b>Positions</b>");
    top.forEach((p) => { const c = T.CODE[p.chain]; L.push(`• ${esc(p.sym || shortA(p.token))} · ${T.CH[c].name}${p.valueUsd ? ` · ${usd(p.valueUsd)}` : ""}${p.pnlNat != null ? " · " + pnlTxt(p, c) : ""}`); });
  }
  L.push("", empty ? "Once done, tap 🔄 Refresh and your balance will appear here." : "", "To buy a token: send a token address, a ticker (e.g. <code>$PEPE</code>) or a link from pump.fun, DEX Screener, Birdeye or GMGN.");
  return { text: L.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n"), reply_markup: { inline_keyboard: HOME_KB } };
}

async function walletMsg(row) {
  const st = T.settings(row), [b, sw] = await Promise.all([T.balances(row), B.balances(row.tg_id).catch(() => [])]), line = (c) => `${b[c] == null ? "?" : fmt(b[c], c)} ${nat(c)}`;
  const solLines = sw.length > 1 ? sw.map((w) => `W${w.idx} <code>${w.pub}</code>\n   ${w.bal == null ? "?" : fmt(w.bal, "s")} SOL`).join("\n") : `<code>${row.sol_pub}</code>\nBalance: ${line("s")}`;
  return { text: `<b>👛 Wallet</b>\n\n◎ <b>Solana</b>${sw.length > 1 ? ` · ${sw.length} wallets` : ""}\n${solLines}\n\n📦 <b>Bundles</b>: ${st.bundle ? "🟢 On" : "🔴 Off"} — buy/sell from all your Solana wallets in one Jito bundle (same block, all or nothing). Tip ${st.bundleTip} SOL.\n\n⬡ <b>EVM</b> (same address on BNB Chain, Base, Robinhood)\n<code>${row.evm_addr}</code>\nBNB Chain: ${line("b")}\nBase: ${line("e")}\nRobinhood: ${line("r")}\n\n${NOTE}`,
    reply_markup: { inline_keyboard: [
      [{ text: `➕ Add Solana wallet (${sw.length || 1}/${B.MAX})`, callback_data: "Tg" }, { text: `📦 Bundles: ${st.bundle ? "On" : "Off"}`, callback_data: "Te" }],
      [{ text: "💸 Spread SOL", callback_data: "Tf" }, { text: "🧲 Collect SOL to W1", callback_data: "Ti" }, { text: `✏️ Tip ${st.bundleTip}`, callback_data: "Th" }],
      [{ text: "📥 Deposit", callback_data: "Td" }, { text: "📤 Withdraw", callback_data: "TW" }], [{ text: "🔑 Export private keys", callback_data: "Tk" }], [{ text: "⬅️ Back", callback_data: "Tm" }, { text: "🔄 Refresh", callback_data: "TA" }]] } };
}

const HELP = `<b>❓ How the CBL Bartender works</b>

<b>Buy:</b> send a token address, a ticker like <code>$PEPE</code>, or a link from pump.fun, DEX Screener, Birdeye or GMGN. Tap a 🟢 buy button, or 🟢 X for a custom amount.
<b>Sell:</b> open the token (📊 Positions or paste it again) and tap 🔴 25% / 50% / 100% or 🔴 X%.
<b>Chains:</b> Solana (SOL), BNB Chain (BNB), Base and Robinhood Chain (ETH). EVM uses one address for all three.
<b>Curves:</b> pump.fun, Four.meme and Pons tokens can be traded before they graduate.
<b>Fee:</b> ${"{fee}"}% per trade, taken from the trade amount (buys) or proceeds (sells).
<b>Take profit / stop loss:</b> on a token tap 🎯 Take profit or 🛑 Stop loss (e.g. <code>100 50</code> = at +100% sell half). Or turn on Auto TP/SL in Settings for every buy. Checked every 5 minutes.
<b>Settings:</b> button amounts, slippage, max price impact, auto-buy, MEV protection (BNB Chain), transaction speed, sell protection, auto TP/SL.
<b>Bundles:</b> 👛 Wallet → ➕ add up to 5 Solana wallets, 💸 spread SOL to them, turn 📦 Bundles on. Every Solana buy/sell then runs from all wallets in one Jito bundle (same block, all or nothing).
<b>Keys:</b> 👛 Wallet → 🔑 Export. Keep them private — anyone with them controls your funds.

<b>Predict:</b> 🔮 Predict (or /predict) lists prediction markets from Polymarket and Kalshi: trending, by category, or search. Browsing only for now.

Commands: /trade · /positions · /predict · /buy &lt;token&gt; &lt;amount&gt; · /sell &lt;token&gt; &lt;%&gt; · /withdraw · /export · /settings`;

async function positionsMsg(uid) {
  const { row, list } = await T.positions(uid), st = T.settings(row), shown = sortList(list, st), hidden = list.filter((p) => p.raw > 0n).length - shown.length;
  if (!shown.length) return { text: `<b>📊 Positions</b>\n\nNo positions yet${hidden > 0 ? ` (${hidden} below your $${st.minPos} minimum)` : ""}. Send a token address and tap 🟢 Buy.`, reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "Tm" }]] } };
  const L = [`<b>📊 Positions</b> · sorted by ${SORT[st.sort] || SORT.val}`, ""], kb = [];
  for (const p of shown.slice(0, 12)) {
    const c = T.CODE[p.chain], s = p.sym || shortA(p.token);
    L.push(`${p.url ? `<a href="${p.url}">${esc(s)}</a>` : `<b>${esc(s)}</b>`} · ${T.CH[c].name}\n  ${big(p.raw, p.dec)}${p.valueUsd ? ` ≈ ${usd(p.valueUsd)}` : ""}${p.pnlNat != null ? " · " + pnlTxt(p, c) : ""}`);
    kb.push([{ text: `${s.slice(0, 12)} · ${T.CH[c].name}`, callback_data: `Tv${c}:${p.token}` }]);
  }
  if (hidden > 0) L.push("", `<i>${hidden} small position(s) under $${st.minPos} hidden (Settings → Minimum position value).</i>`);
  L.push("", "<i>PnL counts trades made through this bot.</i>");
  kb.push([{ text: "🔄 Refresh", callback_data: "Tp" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}

async function panelMsg(uid, c, ca, head) {
  const row = await T.getRow(uid), st = T.settings(row), [p, bal] = await Promise.all([T.tokenView(uid, c, ca).catch(() => null), T.nativeBal(row, c).catch(() => null)]);
  const cv = c === "b" || c === "r" ? await T.curveOf(c, ca) : null;
  const L = [];
  if (head) L.push(head, "");
  L.push(`🪙 <b>${esc((p && p.sym) || shortA(ca))}</b> · ${T.CH[c].name}${cv ? ` · 🎢 ${cv.pad} curve` : ""}`, `<code>${ca}</code>`);
  if (p && p.priceUsd) L.push(`Price: $${p.priceUsd.toPrecision(4)}`);
  L.push(`Wallet: ${bal == null ? "?" : fmt(bal, c)} ${nat(c)}`);
  if (p && p.raw > 0n) L.push(`Holding: ${big(p.raw, p.dec)}${p.valueUsd ? ` ≈ ${usd(p.valueUsd)} (${n2(p.valueNat)} ${nat(c)})` : ""}`);
  if (p && p.pnlNat != null) L.push(`PnL: ${pnlTxt(p, c)}`);
  L.push(`Slippage buy ${st.slipBuy}% / sell ${st.slipSell}% · fee ${T.feeBps() / 100}%`);
  const kb = tradeRows({ chain: T.CH[c].key, address: ca }, true, null, st);
  const ords = await O.list(uid, T.CH[c].key, ca).catch(() => []);
  if (ords.length) L.push("Orders: " + ords.map((o) => (o.kind === "take_profit" ? `🎯 +${o.params.pct}% (sell ${o.params.sell}%)` : `🛑 -${o.params.pct}% (sell ${o.params.sell}%)`)).join(" · "));
  kb[2] = [{ text: "🎯 Take profit", callback_data: `Tt${c}:${ca}` }, { text: "🛑 Stop loss", callback_data: `Tj${c}:${ca}` }, { text: `📋 Orders${ords.length ? " (" + ords.length + ")" : ""}`, callback_data: `To${c}:${ca}` }];
  kb.push([{ text: "🔄 Refresh", callback_data: `Tv${c}:${ca}` }, { text: "📊 Positions", callback_data: "Tp" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}

async function ordersMsg(uid, c, ca) {
  const rows = await O.list(uid, c ? T.CH[c].key : null, ca);
  const L = [`<b>🎯 Orders</b> (take profit · stop loss · limit buy)${ca ? " · " + esc(shortA(ca)) : ""}`, ""], kb = [];
  if (!rows.length) L.push(ca ? "No orders for this token yet." : "No active orders. Open a token (📊 Positions) and tap 🎯 Take profit or 🛑 Stop loss.");
  rows.forEach((o, i) => {
    const cc = T.CODE[o.chain], tp = o.kind === "take_profit";
    if (o.kind === "limit_buy") { L.push(`${i + 1}. 🟢 Limit buy ${o.params.amount} ${nat(cc)} at -${o.params.pct}%
   ${esc(shortA(o.token))} · ${T.CH[cc].name} · triggers at ${o.params.trig.toPrecision(4)} ${nat(cc)} (set at ${o.params.ref.toPrecision(4)})`); kb.push([{ text: `❌ Cancel ${i + 1}`, callback_data: `Tr${o.id}` }]); return; }
    L.push(`${i + 1}. ${tp ? "🎯 Take profit" : "🛑 Stop loss"} ${tp ? "+" : "-"}${o.params.pct}% → sell ${o.params.sell}%
   ${esc(shortA(o.token))} · ${T.CH[cc].name} · triggers at ${o.params.trig.toPrecision(4)} ${nat(cc)} (entry ${o.params.ref.toPrecision(4)})`);
    kb.push([{ text: `❌ Cancel ${i + 1}`, callback_data: `Tr${o.id}` }]);
  });
  L.push("", "<i>Prices are checked every 5 minutes. On fast-moving tokens the sell can fill above or below the target.</i>");
  if (ca) kb.push([{ text: "🎯 Add take profit", callback_data: `Tt${c}:${ca}` }, { text: "🛑 Add stop loss", callback_data: `Tj${c}:${ca}` }], [{ text: "🟢 Add limit buy", callback_data: `Tl${c}:${ca}` }, { text: "⬅️ Token", callback_data: `Tv${c}:${ca}` }]);
  kb.push([{ text: "⬅️ Menu", callback_data: "Tm" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}

function settingsMsg(row) {
  const s = T.settings(row), onoff = (v) => (v ? "🟢 On" : "🔴 Off");
  const pres = Object.keys(T.CH).map((c) => `${nat(c)}${c === "e" ? " (Base)" : c === "r" ? " (RH)" : ""} ${s.presets[c].join(" / ")}`).join(" · ");
  const auto = Object.keys(T.CH).map((c) => `${s.autoAmt[c]} ${nat(c)}${c === "e" ? " (Base)" : c === "r" ? " (RH)" : ""}`).join(" · ");
  return { text: `<b>⚙️ Settings</b>

<b>GENERAL</b>
Minimum position value: <b>$${s.minPos}</b> — smaller tokens are hidden from your positions.
Sort tokens by: <b>${SORT[s.sort] || SORT.val}</b>

<b>AUTO BUY</b>: ${onoff(s.autoBuy)} — buy immediately when you paste a token address.
Amounts: ${auto}

<b>BUTTONS</b>
Buy: ${pres}
Sell: ${s.sellP.join("% / ")}%

<b>SLIPPAGE</b>: buy <b>${s.slipBuy}%</b> · sell <b>${s.slipSell}%</b> · max price impact <b>${s.maxImpact}%</b>
<i>Max price impact protects you in very illiquid pools. Solana uses Jupiter's automatic slippage.</i>

<b>MEV PROTECT</b> (BNB Chain): ${onoff(s.mev)} — sends through a private mempool so bots can't front-run you. Base and Robinhood have no public mempool; Solana trades go through Jupiter's protected sending.
<b>TRANSACTION SPEED</b> (EVM gas): <b>${PRIO[s.prio] || "Fast"}</b>
<b>SELL PROTECTION</b>: ${onoff(s.sellConfirm)} — 100% sells ask for confirmation.

<b>AUTO TAKE PROFIT</b>: ${onoff(s.autoTp.on)} — after every buy, sell ${s.autoTp.sell}% at +${s.autoTp.pct}%.
<b>AUTO STOP LOSS</b>: ${onoff(s.autoSl.on)} — after every buy, sell ${s.autoSl.sell}% at -${s.autoSl.pct}%.`,
    reply_markup: { inline_keyboard: [
      [{ text: `💲 Min value $${s.minPos}`, callback_data: "TSm" }, { text: `↕️ Sort: ${SORT[s.sort] || SORT.val}`, callback_data: "TSo" }],
      [{ text: `⚡ Auto buy: ${s.autoBuy ? "On" : "Off"}`, callback_data: "TSa" }, { text: "✏️ Auto buy amounts", callback_data: "TSA" }],
      [{ text: "✏️ Buy buttons", callback_data: "TSb" }, { text: "✏️ Sell buttons", callback_data: "TSs" }],
      [{ text: `Buy slip ${s.slipBuy}%`, callback_data: "TSB" }, { text: `Sell slip ${s.slipSell}%`, callback_data: "TSS" }, { text: `Max impact ${s.maxImpact}%`, callback_data: "TSi" }],
      [{ text: `🛡 MEV protect: ${s.mev ? "On" : "Off"}`, callback_data: "TSv" }, { text: `🚀 Speed: ${PRIO[s.prio] || "Fast"}`, callback_data: "TSp" }],
      [{ text: `🔒 Sell protection: ${s.sellConfirm ? "On" : "Off"}`, callback_data: "TSc" }],
      [{ text: `🎯 Auto TP: ${s.autoTp.on ? "On" : "Off"}`, callback_data: "TSt" }, { text: `✏️ +${s.autoTp.pct}% / sell ${s.autoTp.sell}%`, callback_data: "TSu" }],
      [{ text: `🛑 Auto SL: ${s.autoSl.on ? "On" : "Off"}`, callback_data: "TSl" }, { text: `✏️ -${s.autoSl.pct}% / sell ${s.autoSl.sell}%`, callback_data: "TSL" }],
      [{ text: "⬅️ Menu", callback_data: "Tm" }],
    ] } };
}
const chainPick = (prefix, title) => ({ text: title, reply_markup: { inline_keyboard: [[{ text: "SOL", callback_data: prefix + "s" }, { text: "BNB", callback_data: prefix + "b" }], [{ text: "ETH · Base", callback_data: prefix + "e" }, { text: "ETH · Robinhood", callback_data: prefix + "r" }], [{ text: "⬅️ Settings", callback_data: "Ts" }]] } });

function errText(e) {
  if (e instanceof T.UserErr) return "⚠️ " + esc(e.message);
  const m = String((e && (e.shortMessage || e.message)) || e);
  if (/insufficient funds/i.test(m)) return "⚠️ Not enough balance for this trade plus gas.";
  console.error("trade error", m);
  return "⚠️ The trade didn't go through: " + esc(m.slice(0, 160));
}

async function jget(u) { try { const r = await fetch(u, { headers: { accept: "application/json" } }); return r.ok ? await r.json() : null; } catch (e) { return null; } }
/** Token from a link (pump.fun, DEX Screener, Birdeye, GMGN, Photon…). Returns { ca, chain } or null. */
async function fromLink(text) {
  const u = (text.match(/https?:\/\/\S+/) || [])[0]; if (!u) return null;
  let url; try { url = new URL(u); } catch (e) { return null; }
  const host = url.hostname.replace(/^www\./, ""), parts = url.pathname.split("/").filter(Boolean), addr = parts.find((x) => CA_RE.test(x) && x.match(CA_RE)[0] === x);
  if (!addr) return null;
  const evm = /^0x/.test(addr);
  const hintRaw = (url.searchParams.get("chain") || parts.find((x) => /^(solana|sol|bsc|bnb|base|robinhood)$/i.test(x)) || "").toLowerCase();
  const hint = { sol: "solana", bnb: "bsc" }[hintRaw] || hintRaw || (evm ? null : "solana");
  if (/dexscreener\.com$/.test(host) || /photon/.test(host)) { // these links are usually pair addresses: resolve the token
    const ch = hint || parts[0];
    const j = await jget(`https://api.dexscreener.com/latest/dex/pairs/${ch}/${addr}`);
    const p = j && (j.pair || (j.pairs && j.pairs[0]));
    if (p && p.baseToken) return { ca: p.baseToken.address, chain: p.chainId };
    return { ca: addr, chain: ch };
  }
  return { ca: addr, chain: hint };
}
/** Ticker search on our 4 chains, best liquidity first. */
async function searchTicker(q) {
  const j = await jget(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  const seen = new Set(), out = [];
  for (const p of ((j && j.pairs) || []).filter((p) => DS_CHAIN[p.chainId] && p.baseToken && p.baseToken.symbol && p.baseToken.symbol.toLowerCase() === q.toLowerCase())
    .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))) {
    const k = p.chainId + "|" + p.baseToken.address.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    out.push({ c: DS_CHAIN[p.chainId], ca: p.baseToken.address, sym: p.baseToken.symbol, name: p.baseToken.name, liq: (p.liquidity && p.liquidity.usd) || 0, mc: p.marketCap || p.fdv });
    if (out.length >= 6) break;
  }
  return out;
}

function make(tg) {
  const send = (chat, m, extra) => tg("sendMessage", Object.assign({ chat_id: chat, text: m.text || m, parse_mode: "HTML", disable_web_page_preview: true }, m.reply_markup ? { reply_markup: m.reply_markup } : {}, extra || {}));
  const edit = (chat, mid, m) => tg("editMessageText", { chat_id: chat, message_id: mid, text: m.text || m, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup });
  const notReady = () => (!T.on() ? "The Bartender isn't serving yet (trading not switched on)." : null);
  const prompt = (chat, text, tag, ph) => send(chat, `${text}\n#${tag}`, { reply_markup: { force_reply: true, input_field_placeholder: ph || "" } });
  const backBtn = (c, ca) => ({ inline_keyboard: [[{ text: "📊 Token panel", callback_data: `Tv${c}:${ca}` }, { text: "⬅️ Menu", callback_data: "Tm" }]] });

  async function doBuy(chat, uid, c, ca, amount, mid) {
    const st = mid ? (await edit(chat, mid, `⏳ Buying with ${esc(amount)} ${nat(c)}…`), { result: { message_id: mid } }) : await send(chat, `⏳ Buying with ${esc(amount)} ${nat(c)}…`);
    const id = st && st.result && st.result.message_id;
    try {
      const st0 = T.settings(await T.getRow(uid));
      if (bun(c, st0)) {
        const r = await B.buy(uid, ca, amount);
        const auto = await O.autoOnBuy(uid, c, ca, st0).catch(() => []);
        const head = `✅ <b>📦 Bundle bought</b> ${big(r.out, r.dec)} tokens with ${r.n} wallets (${fmt(r.per, c)} SOL each)${r.fee > 0n ? ` · fee ${fmt(r.fee, c)}` : ""}\nAll in one block: ${r.sigs.map((x, i) => `<a href="${T.CH[c].exp}${x}">W${i + 1}</a>`).join(" · ")}` + auto.map((o) => `\n${o.kind === "TP" ? "🎯 Auto take profit" : "🛑 Auto stop loss"}: sell ${o.sell}% at ${o.kind === "TP" ? "+" : "-"}${o.pct}%`).join("");
        return void (await edit(chat, id, await panelMsg(uid, c, ca, head)));
      }
      const r = await T.buy(uid, c, ca, amount);
      const row2 = await T.getRow(uid), auto = await O.autoOnBuy(uid, c, ca, T.settings(row2)).catch(() => []);
      const autoTxt = auto.map((o) => `\n${o.kind === "TP" ? "🎯 Auto take profit" : "🛑 Auto stop loss"}: sell ${o.sell}% at ${o.kind === "TP" ? "+" : "-"}${o.pct}%`).join("");
      const head0 = `✅ <b>Bought</b> ${r.out > 0n ? big(r.out, r.dec) + " tokens " : ""}for ${esc(amount)} ${nat(c)} via ${esc(r.route)}${r.fee > 0n ? ` (fee ${fmt(r.fee, c)})` : ""}\n<a href="${T.CH[c].exp}${r.hash}">View transaction</a>`, head = head0 + autoTxt;
      await edit(chat, id, await panelMsg(uid, c, ca, head));
    } catch (e) { await edit(chat, id, { text: errText(e), reply_markup: backBtn(c, ca) }); }
  }
  async function doSell(chat, uid, c, ca, pct, mid) {
    const st = mid ? (await edit(chat, mid, `⏳ Selling ${pct}%…`), { result: { message_id: mid } }) : await send(chat, `⏳ Selling ${pct}%…`);
    const id = st && st.result && st.result.message_id;
    try {
      if (bun(c, T.settings(await T.getRow(uid)))) {
        const r = await B.sell(uid, ca, pct);
        return void (await edit(chat, id, await panelMsg(uid, c, ca, `✅ <b>📦 Bundle sold</b> ${pct}% from ${r.n} wallet(s) for ~${fmt(r.out, c)} SOL${r.fee > 0n ? ` (fee ${fmt(r.fee, c)})` : ""}\n${r.sigs.map((x, i) => `<a href="${T.CH[c].exp}${x}">tx ${i + 1}</a>`).join(" · ")}`)));
      }
      const r = await T.sell(uid, c, ca, pct);
      const head = `✅ <b>Sold</b> ${pct}% (${big(r.sold, r.dec)}) for ~${fmt(r.out, c)} ${nat(c)} via ${esc(r.route)}${r.fee > 0n ? ` (fee ${fmt(r.fee, c)})` : ""}\n<a href="${T.CH[c].exp}${r.hash}">View transaction</a>`;
      await edit(chat, id, await panelMsg(uid, c, ca, head));
    } catch (e) { await edit(chat, id, { text: errText(e), reply_markup: backBtn(c, ca) }); }
  }
  async function openMenu(chat, uid, mid) {
    const row = await T.getRow(uid), m = row ? await menuMsg(row) : introMsg();
    return mid ? edit(chat, mid, m) : send(chat, m);
  }
  async function sendKeys(chat, row, first) {
    const V = require("./vault");
    await send(chat, `🔑 <b>${first ? "Save your private keys now" : "Your private keys"}</b>\nTap to reveal. Store them somewhere safe (password manager or offline), then <b>delete this message</b>. Anyone with these keys controls your funds.\n\n◎ Solana (import into Phantom/Solflare):\n<tg-spoiler><code>${V.solExport(V.solSeed(row))}</code></tg-spoiler>\n\n⬡ EVM (MetaMask/Rabby, same on BNB/Base/Robinhood):\n<tg-spoiler><code>${V.evmPk(row)}</code></tg-spoiler>${await B.exportKeys(row.tg_id).then((l) => l.map((w) => `\n\n◎ Solana W${w.idx} <code>${w.pub}</code>:\n<tg-spoiler><code>${w.key}</code></tg-spoiler>`).join("")).catch(() => "")}${first ? "\n\nYou can show them again any time: 👛 Wallet → 🔑 Export." : ""}`, { protect_content: true });
  }
  const depositMsg = (row) => `<b>📥 Fund your wallet</b>\n\nSend <b>SOL</b> (Solana network) to:\n<code>${row.sol_pub}</code>\n\nSend <b>BNB</b> (BNB Chain) or <b>ETH</b> (Base / Robinhood Chain) to:\n<code>${row.evm_addr}</code>\n\nTap an address to copy it. Buy crypto on any exchange (Binance, Bybit, OKX…) and withdraw to these addresses on the matching network. Then tap 🔄 Refresh.`;
  const exportAsk = () => ({ text: "🔑 <b>Export private keys</b>\n\nAnyone with these keys controls your funds. Never share them, and delete the message after saving them.\n\nShow keys now?", reply_markup: { inline_keyboard: [[{ text: "Yes, show my keys", callback_data: "Tkk" }, { text: "Cancel", callback_data: "TA" }]] } });
  const withdrawPick = () => ({ text: "<b>📤 Withdraw</b>\nWhich coin?", reply_markup: { inline_keyboard: [[{ text: "SOL", callback_data: "Tws" }, { text: "BNB", callback_data: "Twb" }], [{ text: "ETH · Base", callback_data: "Twe" }, { text: "ETH · Robinhood", callback_data: "Twr" }], [{ text: "⬅️ Wallet", callback_data: "TA" }]] } });
  const dmOnly = (msg) => msg.chat.type !== "private";

  /** Commands. Returns true when handled. */
  async function command(name, args, msg, botUser) {
    const map = { trade: 1, menu: 1, home: 1, positions: 1, pos: 1, withdraw: 1, export: 1, settings: 1, buy: 1, sell: 1, predict: 1, predictions: 1 };
    if (!map[name]) return false;
    if (dmOnly(msg)) { await send(msg.chat.id, botUser ? `🍸 The Bartender only takes orders in private: <a href="https://t.me/${botUser.replace(/^@/, "")}?start=trade">open CBL Bartender</a>` : "🍸 The Bartender only takes orders in a private chat with me."); return true; }
    const nr = notReady(); if (nr) { await send(msg.chat.id, nr); return true; }
    const uid = msg.from.id, chat = msg.chat.id;
    if (name === "trade" || name === "menu" || name === "home") { await openMenu(chat, uid); return true; }
    const row = await T.getRow(uid); if (!row) { await send(chat, introMsg()); return true; }
    if (name === "positions" || name === "pos") { await send(chat, await positionsMsg(uid)); return true; }
    if (name === "predict" || name === "predictions") { // /predict = trending, /predict <words> = search
      const P = require("./predict");
      try { await send(chat, args.length ? await P.searchMsg(args.join(" ")) : await P.listMsg("t", "a")); } catch (e) { await send(chat, errText(e)); }
      return true;
    }
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
  async function refMsg(uid) {
    const R = require("./refs"), s = await R.stats(uid), bot = String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
    const link = `https://t.me/${bot}?start=ref_${uid}`, coins = ["s", "b", "e", "r"];
    const L = [`🤝 <b>Referrals</b>`, ``, `Invite friends and earn <b>${s.share}%</b> of their trading fees, forever. Earnings build up here; tap Claim to send them to your Bartender wallet.`, ``,
      `🔗 Your link:\n<code>${link}</code>`, ``, `👥 Invited: <b>${s.invited}</b> · their trades: <b>${s.trades}</b>`, ``, `<b>Earnings</b> (available / total)`];
    coins.forEach((c) => { if (s.earned[c] > 0n) L.push(`• ${T.CH[c].name}: <b>${fmt(s.avail[c], c)}</b> / ${fmt(s.earned[c], c)} ${T.CH[c].nat}`); });
    if (!coins.some((c) => s.earned[c] > 0n)) L.push("• Nothing yet. Share your link to start earning.");
    const claimBtns = coins.filter((c) => s.avail[c] >= T.toUnits(R.MIN[c], T.CH[c].dec)).map((c) => ({ text: `💰 Claim ${fmt(s.avail[c], c)} ${T.CH[c].nat}${c === "e" ? " (Base)" : c === "r" ? " (Robinhood)" : ""}`, callback_data: "TRc" + c }));
    const kb = claimBtns.map((b) => [b]);
    kb.push([{ text: "📤 Share link", url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("🍸 Trade any token in Telegram with CBL Bartender (Solana, BNB, Base, Robinhood):")}` }]);
    kb.push([{ text: "🔄 Refresh", callback_data: "TR" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
    L.push("", `<i>Min claim: ${coins.map((c) => R.MIN[c] + " " + (c === "e" ? "ETH(Base)" : c === "r" ? "ETH(RH)" : T.CH[c].nat)).join(" · ")}</i>`);
    return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
  }
  async function copyMsg(uid) {
    const C = require("./copy"), rows = await C.list(uid);
    const L = ["👥 <b>Copy trading</b>", "", "Follow a wallet. When it buys, you buy the same token with your fixed amount. When it sells, you sell the same share. Solana copies are instant, BNB / Base / Robinhood within 5 minutes.", ""];
    const kb = [];
    if (!rows.length) L.push("You don't follow anyone yet.");
    rows.forEach((r, i) => {
      const c = T.CODE[r.chain];
      L.push(`${i + 1}. ${r.active ? "🟢" : "⏸"} <b>${esc(r.label || shortA(r.target))}</b> · ${T.CH[c].name}\n   <code>${r.target}</code>\n   ${r.amount} ${nat(c)} per buy · sells ${r.sells ? "✅" : "❌"} · 🛡 safe mode ${r.safe ? "on" : "off"} · max ${r.max_day}/day`);
      kb.push([{ text: `${i + 1}: ${r.active ? "⏸ Pause" : "▶️ Resume"}`, callback_data: `TCp${r.id}` }, { text: "✏️ Amount", callback_data: `TCa${r.id}` }, { text: "🗑", callback_data: `TCd${r.id}` }],
        [{ text: `${i + 1}: Sells ${r.sells ? "✅" : "❌"}`, callback_data: `TCs${r.id}` }, { text: `🛡 Safe ${r.safe ? "✅" : "❌"}`, callback_data: `TCg${r.id}` }]);
    });
    const log = (await db.select("bot_copy_log", `tg_id=eq.${uid}&select=side,token,ok,note,created_at&order=id.desc&limit=5`).catch(() => [])) || [];
    if (log.length) { L.push("", "<b>Last copies</b>"); log.forEach((x) => L.push(`${x.ok ? "✅" : x.ok === false ? "⚠️" : "⏳"} ${x.side} ${esc(shortA(x.token))}${x.ok === false && x.note ? " · " + esc(String(x.note).slice(0, 60)) : ""}`)); }
    L.push("", "<i>🛡 Safe mode skips tokens with a CBL score under 50 or honeypots. Your Auto TP/SL settings apply to copied buys. Copying is risky: wallets you follow can dump on you.</i>");
    if (rows.length < C.MAX_TARGETS) kb.push([{ text: "➕ Follow a wallet", callback_data: "TCn" }]);
    kb.push([{ text: "🔄 Refresh", callback_data: "TC" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
    return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
  }
  async function alertsMsg(uid) {
    const l = await O.alerts(uid);
    const L = ["🔔 <b>Price alerts</b>", "", "Get a DM when a token hits your target. Send:", "<code>/alert &lt;address&gt; 2x</code> · <code>+50%</code> · <code>-30%</code> · <code>mc 1m</code> · <code>$0.01</code>", ""];
    const kb = [];
    if (!l.length) L.push("No alerts yet.");
    l.forEach((o, i) => { L.push(`${i + 1}. ${esc(o.params.sym || shortA(o.token))} · ${esc(o.params.label)} ${o.params.dir === "up" ? "📈" : "📉"}`); kb.push([{ text: `❌ Remove ${i + 1}`, callback_data: `TLd${o.id}` }]); });
    kb.push([{ text: "🔄 Refresh", callback_data: "TL" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
    return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
  }
  const notifyAdmins = async (text) => { for (const a of String(process.env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean)) await send(a, text).catch(() => {}); };

  async function start(arg, msg) {
    const rf = /^ref_(\d{3,15})$/.exec(arg || "");
    if (rf) {
      const ok = await require("./refs").attach(msg.from.id, rf[1]).catch(() => false);
      const nr = notReady(); if (nr) { await send(msg.chat.id, nr); return true; }
      if (await T.getRow(msg.from.id)) await openMenu(msg.chat.id, msg.from.id); else await send(msg.chat.id, Object.assign({}, introMsg(), ok ? { text: "🤝 You were invited by a friend.\n\n" + introMsg().text } : {}));
      return true;
    }
    if (arg === "trade") { const nr = notReady(); if (nr) await send(msg.chat.id, nr); else await openMenu(msg.chat.id, msg.from.id); return true; }
    const m = /^tr_([sber])_(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(arg || "");
    if (!m) return false;
    const nr = notReady(); if (nr) { await send(msg.chat.id, nr); return true; }
    if (!(await T.getRow(msg.from.id))) { await send(msg.chat.id, introMsg()); return true; }
    await send(msg.chat.id, await panelMsg(msg.from.id, m[1], m[2]));
    return true;
  }

  /** DM text that isn't a command: links and $tickers. Returns { ca, chain } to scan, true if handled here, or null. */
  async function textInput(msg) {
    if (msg.chat.type !== "private") return null;
    const text = (msg.text || "").trim();
    if (/https?:\/\//.test(text)) { const r = await fromLink(text); if (r) return r; }
    const t = /^\$([A-Za-z0-9]{2,15})$/.exec(text) || (/^[A-Z][A-Z0-9]{1,9}$/.test(text) && !/^(HI|OK|GM|GN|YES|NO|HELP|MENU|START)$/.test(text) ? [text, text] : null);
    if (!t) return null;
    const found = await searchTicker(t[1]);
    if (!found.length) { await send(msg.chat.id, `No token named <b>${esc(t[1].toUpperCase())}</b> found on Solana, BNB Chain, Base or Robinhood. Send its contract address instead.`); return true; }
    await send(msg.chat.id, { text: `🔎 <b>${esc(t[1].toUpperCase())}</b> — pick the right one (highest liquidity first):\n\n` + found.map((f, i) => `${i + 1}. <b>${esc(f.sym)}</b> · ${T.CH[f.c].name} · liq ${usd(f.liq)}${f.mc ? ` · MC ${usd(f.mc)}` : ""}\n<code>${f.ca}</code>`).join("\n\n"),
      reply_markup: { inline_keyboard: found.map((f, i) => [{ text: `${i + 1}. ${f.sym} · ${T.CH[f.c].name} · ${usd(f.liq)}`, callback_data: `TV${f.c}:${f.ca}` }]) } });
    return true;
  }

  /** Auto buy after a token is pasted in DM (Settings → Auto buy). */
  async function autoBuy(msg, r) {
    if (msg.chat.type !== "private" || !T.on() || !r || !r.address) return;
    const c = T.CODE[r.chain]; if (!c) return;
    const row = await T.getRow(msg.from.id); if (!row) return;
    const st = T.settings(row); if (!st.autoBuy) return;
    await doBuy(msg.chat.id, msg.from.id, c, r.address, String(st.autoAmt[c]));
  }

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
      if (r.created) await sendKeys(chat, r.row, true); // show the keys once right away
      return true;
    }
    const row = await T.getRow(uid); if (!row) { await ack(); await send(chat, introMsg()); return true; }
    const st = T.settings(row), save = async (patch) => { await T.saveSettings(uid, Object.assign(st, patch)); };
    if (k === "m") { await ack(); await openMenu(chat, uid, mid); return true; }
    if (k === "p") { await ack("Loading positions…"); await edit(chat, mid, await positionsMsg(uid)); return true; }
    if (k === "d") { await ack(); await send(chat, depositMsg(row)); return true; }
    if (k === "A") { await ack(); await edit(chat, mid, await walletMsg(row)); return true; }
    if (k === "C") {
      const C = require("./copy"), sub = d[2], id = d.slice(3);
      try {
        if (sub === "n") { await ack(); await prompt(chat, "👥 <b>Follow a wallet</b>\nReply with the wallet, the amount per buy and an optional name:\n<code>WALLET 0.1 whale</code> (Solana)\n<code>0xWALLET 0.01 base whale</code> (0x wallets: add bnb, base or robinhood)", "copy", "WALLET 0.1 name"); return true; }
        if (sub === "a") { await ack(); await prompt(chat, `✏️ New amount per copied buy for copy #${id}? Reply with a number, e.g. <code>0.2</code>`, "copyamt", "0.2"); return true; }
        const rows = await C.list(uid), r = rows.find((x) => String(x.id) === id);
        if (sub && r) {
          if (sub === "p") await C.update(uid, id, { active: !r.active });
          if (sub === "s") await C.update(uid, id, { sells: !r.sells });
          if (sub === "g") await C.update(uid, id, { safe: !r.safe });
          if (sub === "d") await C.remove(uid, id);
        }
        await ack(); await edit(chat, mid, await copyMsg(uid));
      } catch (e) { await ack(); await send(chat, errText(e)); }
      return true;
    }
    if (k === "Q") { // Predict: TQ home · TQl<filter><category> list · TQe:<eventId> event · TQs search prompt
      const P = require("./predict"), sub = d[2];
      if (sub === "s") { await ack(); await prompt(chat, P.SEARCH_PROMPT, "pred", "bitcoin"); return true; }
      await ack("Loading markets…");
      try {
        const r = await edit(chat, mid, sub === "e" ? await P.eventMsg(d.slice(4)) : await P.listMsg(sub === "l" ? d[3] : "t", sub === "l" ? d[4] : "a"));
        if (r && r.ok === false && !/not modified/i.test(r.description || "")) { console.error("predict edit failed", d, r.description); await send(chat, "⚠️ Couldn't show this market. Try again in a moment."); }
      }
      catch (e) { await edit(chat, mid, { text: errText(e), reply_markup: { inline_keyboard: [[{ text: "🔮 Predict", callback_data: "TQ" }, { text: "⬅️ Menu", callback_data: "Tm" }]] } }); }
      return true;
    }
    if (k === "X") { // xStocks list → tap opens the normal token screen (buy / sell / TP-SL)
      await ack();
      const ST = require("./stocks"), [l, mk] = [await ST.list().catch(() => []), ST.market()];
      const L = ["📈 <b>Stocks · xStocks on Solana</b>", "", `${mk.label}. ${mk.note}`, ""];
      if (!l.length) L.push("Couldn't load the stock list right now. Try 🔄 in a minute.");
      const kb = [], top = l.slice(0, 16);
      for (let i = 0; i < top.length; i += 2) kb.push(top.slice(i, i + 2).map((t) => ({ text: `${t.sym} ${t.price ? "$" + (t.price >= 100 ? t.price.toFixed(0) : t.price.toFixed(2)) : ""}${t.ch24 != null ? " " + (t.ch24 >= 0 ? "+" : "") + t.ch24.toFixed(1) + "%" : ""}`, callback_data: `Tvs:${t.mint}` })));
      L.push("Tap a stock to buy with SOL. Same 1% fee, sell any time (24/7).", "<i>xStocks are tokens by Backed that track the share price. Not the share itself, no voting rights. Not available to US persons.</i>");
      kb.push([{ text: "🔄 Refresh", callback_data: "TX" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
      await edit(chat, mid, { text: L.join("\n"), reply_markup: { inline_keyboard: kb } });
      return true;
    }
    if (k === "P") { await ack(); const m = await require("./points").pointsMsg(uid); m.reply_markup.inline_keyboard.push([{ text: "⬅️ Menu", callback_data: "Tm" }]); await edit(chat, mid, m); return true; }
    if (k === "L") {
      if (d[2] === "d") await db.patch("bot_orders", `tg_id=eq.${uid}&kind=eq.alert&id=eq.${Number(d.slice(3))}`, { active: false }).catch(() => {});
      await ack(); await edit(chat, mid, await alertsMsg(uid)); return true;
    }
    if (k === "R") {
      if (d[2] === "c") {
        await ack("Claiming…");
        try {
          const r = await require("./refs").claim(uid, d[3], notifyAdmins);
          await send(chat, r.tx ? `✅ Claimed <b>${fmt(r.amt, r.c)} ${T.CH[r.c].nat}</b> to your Bartender wallet.\n<a href="${T.CH[r.c].exp}${r.tx}">View transaction</a>`
            : `🕒 Claim of <b>${fmt(r.amt, r.c)} ${T.CH[r.c].nat}</b> received (#${r.queued}). It will be paid to your Bartender wallet shortly.`);
        } catch (e) { await send(chat, errText(e)); }
        await edit(chat, mid, await refMsg(uid)).catch(() => {});
        return true;
      }
      await ack(); await edit(chat, mid, await refMsg(uid)); return true;
    }
    if (k === "H") { await ack(); await send(chat, { text: HELP.replace("{fee}", T.feeBps() / 100), reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "Tm" }]] } }); return true; }
    if (k === "B") { await ack(); await prompt(chat, "🟢 <b>Buy a token</b>\nReply with a token address, a ticker (e.g. <code>$PEPE</code>) or a pump.fun / DEX Screener / Birdeye link.", "find", "token address, $TICKER or link"); return true; }
    if (k === "s") { await ack(); await edit(chat, mid, settingsMsg(row)); return true; }
    if (k === "S") {
      const o = d[2], refresh = async (t) => { await ack(t); await edit(chat, mid, settingsMsg(await T.getRow(uid))); };
      if (o === "m") { await ack(); await prompt(chat, "💲 Minimum position value in USD (smaller tokens are hidden), e.g. <code>1</code>", "set:minpos", "1"); return true; }
      if (o === "o") { const order = ["val", "low", "az"]; await save({ sort: order[(order.indexOf(st.sort) + 1) % 3] }); return void (await refresh("Sort changed")) || true; }
      if (o === "a") { await save({ autoBuy: !st.autoBuy }); return void (await refresh(st.autoBuy ? "Auto buy on" : "Auto buy off")) || true; }
      if (o === "v") { await save({ mev: !st.mev }); return void (await refresh(st.mev ? "MEV protect on" : "MEV protect off")) || true; }
      if (o === "c") { await save({ sellConfirm: !st.sellConfirm }); return void (await refresh(st.sellConfirm ? "Sell protection on" : "Sell protection off")) || true; }
      if (o === "p") { const order = ["normal", "fast", "turbo"]; await save({ prio: order[(order.indexOf(st.prio) + 1) % 3] }); return void (await refresh("Speed: " + PRIO[st.prio])) || true; }
      if (o === "t") { await save({ autoTp: Object.assign(st.autoTp, { on: !st.autoTp.on }) }); return void (await refresh(st.autoTp.on ? "Auto take profit on" : "Auto take profit off")) || true; }
      if (o === "l") { await save({ autoSl: Object.assign(st.autoSl, { on: !st.autoSl.on }) }); return void (await refresh(st.autoSl.on ? "Auto stop loss on" : "Auto stop loss off")) || true; }
      if (o === "u") { await ack(); await prompt(chat, "Auto take profit: reply with the gain % and how much to sell, e.g. <code>100 50</code> = at +100% sell 50%", "set:autotp", "100 50"); return true; }
      if (o === "L") { await ack(); await prompt(chat, "Auto stop loss: reply with the loss % and how much to sell, e.g. <code>30 100</code> = at -30% sell everything", "set:autosl", "30 100"); return true; }
      if (o === "B") { await ack(); await prompt(chat, "Buy slippage in %, e.g. <code>10</code>", "set:slipb", "10"); return true; }
      if (o === "S") { await ack(); await prompt(chat, "Sell slippage in %, e.g. <code>10</code>", "set:slips", "10"); return true; }
      if (o === "i") { await ack(); await prompt(chat, "Max price impact in % (trades with a bigger impact are blocked), e.g. <code>25</code>. Send <code>0</code> to turn it off.", "set:impact", "25"); return true; }
      if (o === "s") { await ack(); await prompt(chat, "Sell buttons: reply with three percentages, e.g. <code>25 50 100</code>", "set:sellp", "25 50 100"); return true; }
      if (o === "b") { await ack(); await edit(chat, mid, chainPick("TSx", "✏️ Buy buttons — which coin?")); return true; }
      if (o === "A") { await ack(); await edit(chat, mid, chainPick("TSy", "✏️ Auto buy amount — which coin?")); return true; }
      if (o === "x" && T.CH[d[3]]) { await ack(); await prompt(chat, `Buy buttons for <b>${nat(d[3])} (${T.CH[d[3]].name})</b>: reply with three amounts, e.g. <code>${st.presets[d[3]].join(" ")}</code>`, "set:buyp:" + d[3], st.presets[d[3]].join(" ")); return true; }
      if (o === "y" && T.CH[d[3]]) { await ack(); await prompt(chat, `Auto buy amount in <b>${nat(d[3])} (${T.CH[d[3]].name})</b>, e.g. <code>${st.autoAmt[d[3]]}</code>`, "set:auto:" + d[3], String(st.autoAmt[d[3]])); return true; }
      await ack(); return true;
    }
    if (d === "Tk") { await ack(); await edit(chat, mid, exportAsk()); return true; }
    if (d === "Tkk") { await ack(); await sendKeys(chat, row); return true; }
    if (d === "TW") { await ack(); await edit(chat, mid, withdrawPick()); return true; }
    if (k === "w" && T.CH[d[2]]) { await ack(); await prompt(chat, `📤 <b>Withdraw ${nat(d[2])} on ${T.CH[d[2]].name}</b>\nReply with the amount (or <code>all</code>) and the destination address:\n<code>0.5 ADDRESS</code>`, "withdraw:" + d[2], "amount address"); return true; }
    if (k === "y") {
      const p = st.pend;
      if (!p || p.exp < Date.now()) { await ack("This withdrawal expired. Start again.", true); return true; }
      await save({ pend: null });
      await ack("Sending…"); await edit(chat, mid, "⏳ Sending…");
      try { const r = await T.withdraw(uid, p.c, p.amount, p.to); await edit(chat, mid, `✅ Sent ${fmt(r.amt, p.c)} ${nat(p.c)} to <code>${esc(p.to)}</code>\n<a href="${T.CH[p.c].exp}${r.hash}">View transaction</a>`); }
      catch (e) { await edit(chat, mid, errText(e)); }
      return true;
    }
    if (k === "n") { await save({ pend: null }); await ack("Cancelled"); await edit(chat, mid, "Withdrawal cancelled."); return true; }
    if (d === "Tg") { try { const i = await B.addWallet(uid); await ack(`Wallet W${i} created`); } catch (e) { await ack(e.message, true); } await edit(chat, mid, await walletMsg(await T.getRow(uid))); return true; }
    if (d === "Te") { await save({ bundle: !st.bundle }); await ack(st.bundle ? "Bundles on: Solana buys/sells use all your wallets" : "Bundles off"); await edit(chat, mid, await walletMsg(await T.getRow(uid))); return true; }
    if (d === "Tf") { await ack(); await prompt(chat, "💸 <b>Spread SOL</b>\nHow much SOL to send from W1 to <b>each</b> other wallet? e.g. <code>0.2</code>", "spread", "0.2"); return true; }
    if (d === "Th") { await ack(); await prompt(chat, "✏️ Jito bundle tip in SOL (higher lands faster), e.g. <code>0.001</code>", "set:tip", "0.001"); return true; }
    if (d === "Ti") { await ack("Collecting…"); try { const r = await B.collect(uid); await send(chat, `🧲 Moved ${fmt(r.total, "s")} SOL back to W1.`); } catch (e) { await send(chat, errText(e)); } await edit(chat, mid, await walletMsg(await T.getRow(uid))); return true; }
    if (d === "To") { await ack(); await edit(chat, mid, await ordersMsg(uid)); return true; }
    if (k === "r" && /^\d+$/.test(d.slice(2))) { await O.cancel(uid, d.slice(2)); await ack("Order cancelled"); await edit(chat, mid, await ordersMsg(uid)); return true; }
    const om = /^T([otjl])([sber]):(.+)$/.exec(d);
    if (om) {
      const [, oa, oc, oca] = om; await ack();
      if (oa === "o") { await edit(chat, mid, await ordersMsg(uid, oc, oca)); return true; }
      if (oa === "l") { await prompt(chat, `🟢 <b>Limit buy</b>\nToken: <code>${oca}</code> · ${T.CH[oc].name}\nReply with the drop % and how much ${nat(oc)} to spend, e.g. <code>30 0.5</code> = when the price is 30% lower than now, buy with 0.5 ${nat(oc)}.`, "lb:" + oc, "30 0.5"); return true; }
      if (oa === "t") { await prompt(chat, `🎯 <b>Take profit</b>\nToken: <code>${oca}</code> · ${T.CH[oc].name}\nReply with the gain % and how much to sell, e.g. <code>100 50</code> = when it's up 100% from your entry, sell 50%.`, "tp:" + oc, "100 50"); return true; }
      await prompt(chat, `🛑 <b>Stop loss</b>\nToken: <code>${oca}</code> · ${T.CH[oc].name}\nReply with the loss % (and optionally how much to sell), e.g. <code>30</code> = when it's down 30% from your entry, sell everything.`, "sl:" + oc, "30"); return true;
    }
    // token actions: Tv/TV<c>:<ca> (panel)  Tb<c><i|x>:<ca> (buy)  Tx<c><i|x>:<ca> (sell)  Tz<c><i>:<ca> (confirmed 100% sell)
    const m = /^T([vVbxz])([sber])([0-9x]?):(.+)$/.exec(d);
    if (!m) { await ack(); return true; }
    const [, act, c, opt, ca] = m, isPanel = /Wallet:/.test(q.message.text || "");
    if (act === "v" || act === "V") { await ack(); const pm = await panelMsg(uid, c, ca); if (isPanel && act === "v") await edit(chat, mid, pm); else await send(chat, pm); return true; }
    if (act === "b") {
      if (opt === "x") { await ack(); await prompt(chat, `✏️ How much <b>${nat(c)}</b> to spend?\nToken: <code>${ca}</code> · ${T.CH[c].name}\nReply with a number, e.g. <code>0.2</code>`, "buy:" + c, "0.2"); return true; }
      const amt = st.presets[c][Number(opt)]; if (amt == null) { await ack(); return true; }
      await ack("Buying…"); await doBuy(chat, uid, c, ca, String(amt), isPanel ? mid : null); return true;
    }
    if (act === "x" || act === "z") {
      if (opt === "x") { await ack(); await prompt(chat, `✏️ What % of your tokens to sell?\nToken: <code>${ca}</code> · ${T.CH[c].name}\nReply with a number from 1 to 100`, "sell:" + c, "50"); return true; }
      const pct = st.sellP[Number(opt)]; if (!pct) { await ack(); return true; }
      if (act === "x" && pct >= 100 && st.sellConfirm) { await ack(); await send(chat, { text: `🔒 Sell <b>100%</b> of <code>${ca}</code> on ${T.CH[c].name}?`, reply_markup: { inline_keyboard: [[{ text: "✅ Yes, sell all", callback_data: `Tz${c}${opt}:${ca}` }, { text: "❌ Cancel", callback_data: `Tv${c}:${ca}` }]] } }); return true; }
      await ack("Selling…"); await doSell(chat, uid, c, ca, pct, isPanel || act === "z" ? mid : null); return true;
    }
    await ack(); return true;
  }

  /** Replies to the bot's ✏️ prompts. Returns true when handled. Find-token replies return { ca, chain } to scan. */
  async function replyPrompt(msg) {
    const r = msg.reply_to_message; if (!r || !r.from || !r.from.is_bot || msg.chat.type !== "private") return false;
    const tag = /#(buy|sell|withdraw|set|find|tp|sl|lb|copyamt|copy|spread|pred)(?::([a-z]+))?(?::([sber]))?\s*$/.exec(r.text || ""); if (!tag) return false;
    const nr = notReady(); if (nr) { await send(msg.chat.id, nr); return true; }
    const [, kind, a1, a2] = tag, uid = msg.from.id, chat = msg.chat.id, txt = (msg.text || "").trim();
    if (kind === "find") {
      const link = /https?:\/\//.test(txt) ? await fromLink(txt) : null; if (link) return link;
      const ca = (txt.match(CA_RE) || [])[0]; if (ca) return { ca, chain: null };
      const handled = await textInput({ chat: msg.chat, text: txt.startsWith("$") ? txt : "$" + txt }); return handled || true;
    }
    if (kind === "pred") {
      try { await send(chat, await require("./predict").searchMsg(txt)); } catch (e) { await send(chat, errText(e)); }
      return true;
    }
    if (kind === "spread") {
      if (!/^\d*\.?\d+$/.test(txt)) { await send(chat, "Reply with an amount, e.g. <code>0.2</code>"); return true; }
      try { const r = await B.spread(uid, txt); await send(chat, { text: `💸 Sent ${fmt(r.amt, "s")} SOL from W1 to ${r.n} wallet(s).`, reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "TA" }]] } }); } catch (e) { await send(chat, errText(e)); }
      return true;
    }
    const row = await T.getRow(uid); if (!row) return true;
    const st = T.settings(row), num = (x) => (/^\d*\.?\d+$/.test(x) ? Number(x) : NaN), save = (p) => T.saveSettings(uid, Object.assign(st, p));
    if (kind === "set") {
      const nums = txt.replace(/%/g, "").split(/[\s,\/]+/).map(num);
      const ok = async (m) => { await send(chat, `✅ ${m}`); await send(chat, settingsMsg(await T.getRow(uid))); };
      if (a1 === "minpos" && nums[0] >= 0) { await save({ minPos: nums[0] }); return void (await ok(`Minimum position value: $${nums[0]}`)) || true; }
      if ((a1 === "slipb" || a1 === "slips") && nums[0] > 0 && nums[0] <= 50) { await save(a1 === "slipb" ? { slipBuy: nums[0] } : { slipSell: nums[0] }); return void (await ok(`${a1 === "slipb" ? "Buy" : "Sell"} slippage: ${nums[0]}%`)) || true; }
      if (a1 === "impact" && nums[0] >= 0 && nums[0] <= 100) { await save({ maxImpact: nums[0] }); return void (await ok(nums[0] ? `Max price impact: ${nums[0]}%` : "Max price impact check off")) || true; }
      if (a1 === "sellp" && nums.length === 3 && nums.every((x) => x >= 1 && x <= 100)) { await save({ sellP: nums.map(Math.round) }); return void (await ok(`Sell buttons: ${nums.map(Math.round).join("% / ")}%`)) || true; }
      if (a1 === "buyp" && T.CH[a2] && nums.length === 3 && nums.every((x) => x > 0)) { await save({ presets: Object.assign(st.presets, { [a2]: nums }) }); return void (await ok(`Buy buttons (${nat(a2)}): ${nums.join(" / ")}`)) || true; }
      if ((a1 === "autotp" || a1 === "autosl") && nums[0] > 0 && (a1 === "autotp" || nums[0] < 100)) {
        const sell = nums[1] >= 1 && nums[1] <= 100 ? Math.round(nums[1]) : a1 === "autotp" ? 50 : 100, k2 = a1 === "autotp" ? "autoTp" : "autoSl";
        await save({ [k2]: Object.assign(st[k2], { pct: nums[0], sell, on: true }) });
        return void (await ok(`${a1 === "autotp" ? "Auto take profit: +" : "Auto stop loss: -"}${nums[0]}%, sell ${sell}% (turned on)`)) || true;
      }
      if (a1 === "tip" && nums[0] > 0 && nums[0] <= 0.1) { await save({ bundleTip: nums[0] }); await send(chat, { text: `✅ Bundle tip: ${nums[0]} SOL`, reply_markup: { inline_keyboard: [[{ text: "👛 Wallet", callback_data: "TA" }]] } }); return true; }
      if (a1 === "auto" && T.CH[a2] && nums[0] > 0) { await save({ autoAmt: Object.assign(st.autoAmt, { [a2]: nums[0] }) }); return void (await ok(`Auto buy amount (${nat(a2)} on ${T.CH[a2].name}): ${nums[0]}`)) || true; }
      await send(chat, "That doesn't look right. Open ⚙️ Settings and try again."); return true;
    }
    const c = a1;
    if (kind === "copy") {
      const [w, amt, a3, a4] = txt.split(/\s+/), evm = /^0x/i.test(w || "");
      try {
        const r = await require("./copy").add(uid, w, amt, evm ? a3 : null, evm ? a4 : a3);
        await send(chat, `✅ Following <code>${r.target}</code> on ${T.CH[r.c].name}: ${r.amount} ${nat(r.c)} per buy.\nKeep enough ${nat(r.c)} in your Bartender wallet.`);
        await send(chat, await copyMsg(uid));
      } catch (e) { await send(chat, errText(e)); }
      return true;
    }
    if (kind === "copyamt") {
      const id = ((r.text || "").match(/copy #(\d+)/) || [])[1];
      if (!id || !/^\d*\.?\d+$/.test(txt) || !(Number(txt) > 0)) { await send(chat, "Reply with a number, e.g. <code>0.2</code>"); return true; }
      await require("./copy").update(uid, id, { amount: txt }); await send(chat, `✅ Copy #${id}: ${txt} per buy.`); await send(chat, await copyMsg(uid));
      return true;
    }
    if (kind === "lb") {
      const ca = ((r.text || "").match(CA_RE) || [])[0]; if (!ca || !T.CH[c]) return true;
      const [pct, amt] = txt.replace(/[%-]/g, "").split(/[\s,\/]+/);
      if (!(num(pct) > 0) || !amt) { await send(chat, `Reply like <code>30 0.5</code> (drop %, ${nat(c)} to spend).`); return true; }
      try {
        const o = await O.addLimit(uid, c, ca, num(pct), amt);
        await send(chat, { text: `✅ 🟢 Limit buy set: spend <b>${o.amount} ${nat(c)}</b> when the price drops ${o.pct}% (${o.ref.toPrecision(4)} → ${o.trig.toPrecision(4)} ${nat(c)}).\nKeep enough ${nat(c)} in your wallet. Checked every 5 minutes.`, reply_markup: { inline_keyboard: [[{ text: "📋 Orders", callback_data: `To${c}:${ca}` }, { text: "⬅️ Token", callback_data: `Tv${c}:${ca}` }]] } });
      } catch (e) { await send(chat, errText(e)); }
      return true;
    }
    if (kind === "tp" || kind === "sl") {
      const ca = ((r.text || "").match(CA_RE) || [])[0]; if (!ca || !T.CH[c]) return true;
      const nums = txt.replace(/[%+-]/g, "").split(/[\s,\/]+/).map(num);
      if (!(nums[0] > 0)) { await send(chat, kind === "tp" ? "Reply like <code>100 50</code> (gain %, sell %)." : "Reply like <code>30</code> or <code>30 100</code> (loss %, sell %)."); return true; }
      try {
        const o = await O.add(uid, c, ca, kind === "tp" ? "take_profit" : "stop_loss", nums[0], nums[1] || (kind === "tp" ? 50 : 100));
        await send(chat, { text: `✅ ${kind === "tp" ? "🎯 Take profit" : "🛑 Stop loss"} set: sell ${o.sell}% when the price ${kind === "tp" ? "rises" : "falls"} ${o.pct}% from ${o.from} (${o.ref.toPrecision(4)} → ${o.trig.toPrecision(4)} ${nat(c)}).`, reply_markup: { inline_keyboard: [[{ text: "📋 Orders", callback_data: `To${c}:${ca}` }, { text: "⬅️ Token", callback_data: `Tv${c}:${ca}` }]] } });
      } catch (e) { await send(chat, errText(e)); }
      return true;
    }
    if (kind === "withdraw") {
      const [amt, to] = txt.split(/\s+/);
      if (!amt || !to || !(/^all$/i.test(amt) || /^\d*\.?\d+$/.test(amt))) { await send(chat, "Reply with the amount and address, e.g. <code>0.5 ADDRESS</code> or <code>all ADDRESS</code>."); return true; }
      await save({ pend: { c, amount: amt, to, exp: Date.now() + 5 * 60000 } });
      await send(chat, { text: `Confirm withdrawal:\n<b>${esc(amt)} ${nat(c)}</b> on ${T.CH[c].name}\nto <code>${esc(to)}</code>\n\nDouble-check the address — this can't be undone.`, reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: "Ty" }, { text: "❌ Cancel", callback_data: "Tn" }]] } });
      return true;
    }
    const ca = ((r.text || "").match(CA_RE) || [])[0]; if (!ca) return true;
    if (!/^\d*\.?\d+%?$/.test(txt)) { await send(chat, "Please reply with just a number."); return true; }
    if (kind === "buy") await doBuy(chat, uid, c, ca, txt);
    else await doSell(chat, uid, c, ca, Number(txt.replace("%", "")));
    return true;
  }

  return { command, callback, replyPrompt, start, textInput, autoBuy };
}

module.exports = { make, tradeRows, fromLink, searchTicker };
