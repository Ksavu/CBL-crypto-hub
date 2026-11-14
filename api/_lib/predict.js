// Predict: prediction markets inside CBL Bartender, through Jupiter's Prediction API (markets come from Polymarket and Kalshi).
//   Browse / search / event view, buy YES or NO shares, positions, sell, claim, and the CBL fee.
//   Needs JUP_API_KEY (the same key the Solana swaps use). The API is in beta and Jupiter blocks US and South Korea IPs.
//   Money flow: orders are paid in USDC. The user's Bartender wallet holds SOL, so a buy first swaps the missing USDC from SOL.
//   Fee: BOT_FEE_BPS (default 1%) of the order value, sent in SOL to BOT_SOL_FEE_ACCOUNT only after the order is filled.
//        It is written to bot_trades (chain solana, token "pred:<marketId>") so referral earnings pick it up like any other trade.
//   An order that is still waiting when the request ends stays in bot_orders (kind "pred"); the cron "orders" job finishes it.
//   Limits: PREDICT_MIN_USD (default and floor 5, Jupiter's minimum), PREDICT_MAX_USD (default 1000).
//   Callback data (Telegram limit 64 bytes):
//     TQ                    home (trending, all categories)
//     TQl<filter><cat>      list, e.g. TQltc = trending crypto
//     TQe:<eventId>         one event with its markets
//     TQs                   search prompt (reply tag #pred)
//     TQb<y|n>:<marketId>   pick an amount for YES / NO
//     TQi<y|n>:<marketId>   custom amount prompt (reply tag #pred:buy)
//     TQp<y|n><usd>:<id>    order preview
//     TQo<y|n><usd>:<id>    place the order
//     TQm                   my predictions (positions)
//     TQx:<position> / TQz:<position>   sell: ask / confirmed
//     TQc:<position>        claim a won position
//     TQu / TQU             USDC → SOL: ask / confirmed
const db = require("./db");
const T = require("./trade");
const V = require("./vault");
const { UserErr } = T;
const { esc } = require("./format");
const X = T._;

const BASE = "https://api.jup.ag/prediction/v1";
const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
const on = () => !!clean(process.env.JUP_API_KEY);
const fail = (m) => { throw new UserErr(m); };

const FILTER = { t: ["trending", "🔥 Trending"], n: ["new", "🆕 New"], l: ["live", "🔴 Live"] };
const CAT = { a: ["all", "All"], c: ["crypto", "Crypto"], s: ["sports", "Sports"], p: ["politics", "Politics"], e: ["esports", "E-sports"], u: ["culture", "Culture"], o: ["economics", "Economics"], t: ["tech", "Tech"] };
const NOTE = "<i>Markets by Polymarket and Kalshi via Jupiter. Not available to residents of the US or South Korea.</i>";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PRESETS = [5, 10, 25, 50];
const minUsd = () => Math.max(5, Math.round(Number(clean(process.env.PREDICT_MIN_USD)) || 5));
const maxUsd = () => Math.max(minUsd(), Math.round(Number(clean(process.env.PREDICT_MAX_USD)) || 1000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method, body) {
  const key = clean(process.env.JUP_API_KEY); if (!key) fail("Predict is not switched on yet (JUP_API_KEY).");
  const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
  let r, d = null;
  try { r = await fetch(BASE + path, { method: method || "GET", headers: Object.assign({ "x-api-key": key, accept: "application/json" }, body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined, signal: c.signal }); try { d = await r.json(); } catch (e) {} }
  catch (e) { fail("Jupiter did not answer. Try again in a moment."); }
  finally { clearTimeout(t); }
  if (!r.ok) fail(r.status === 403 || r.status === 451 ? "Prediction markets are not available from this server's region." : r.status === 404 && !method ? "That market was not found." : r.status === 429 ? "Too many requests. Try again in a minute." : errOf(d, r.status));
  return d;
}
const errOf = (d, status) => { const m = d && (d.error || d.message); return String((m && typeof m === "object" ? m.message || JSON.stringify(m) : m) || "Jupiter error " + status).slice(0, 160); };
const one = (d) => (d && d.data && !Array.isArray(d.data) && typeof d.data === "object" ? d.data : d);
const rows = (d) => (Array.isArray(d) ? d : d && Array.isArray(d.data) ? d.data : []);

// Prices arrive as dollars (0.63), cents (63) or micro USD (630000) depending on the endpoint version: normalise to 0–1.
function px(v) {
  const n = Number(v); if (v == null || v === "" || !Number.isFinite(n) || n < 0) return null;
  const p = n > 100 ? n / 1e6 : n > 1 ? n / 100 : n;
  return p > 1 ? null : p;
}
const cents = (p) => (p == null ? "–" : p < 0.01 ? "<1¢" : p >= 0.995 ? "99¢+" : Math.round(p * 100) + "¢");
const pct = (p) => (p == null ? "" : p < 0.01 ? "<1%" : p > 0.99 ? ">99%" : Math.round(p * 100) + "%");
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
function when(v) {
  if (v == null || v === "") return null;
  const ms = typeof v === "number" || /^\d+$/.test(String(v)) ? (Number(v) < 1e12 ? Number(v) * 1000 : Number(v)) : Date.parse(v);
  if (!Number.isFinite(ms) || ms < 1e11) return null;
  const left = ms - Date.now(), d = new Date(ms).toISOString().slice(0, 10);
  if (left <= 0) return "closed " + d;
  const h = left / 36e5;
  return h < 1 ? "closes in " + Math.max(1, Math.round(left / 6e4)) + " min" : h < 48 ? "closes in " + Math.round(h) + "h" : "closes " + d;
}

const titleOf = (ev) => (ev && ev.metadata && ev.metadata.title) || (ev && ev.title) || "Untitled event";
const mTitle = (m) => (m && m.metadata && m.metadata.title) || (m && m.title) || "";
const yesOf = (m) => px(m && m.pricing && m.pricing.buyYesPriceUsd);
const noOf = (m) => px(m && m.pricing && m.pricing.buyNoPriceUsd);
const openMarkets = (ev) => ((ev && ev.markets) || []).filter((m) => !m.status || m.status === "open");
/** The market that leads an event: highest YES price among open markets. */
function lead(ev) {
  const ms = openMarkets(ev).filter((m) => yesOf(m) != null);
  return ms.sort((a, b) => yesOf(b) - yesOf(a))[0] || null;
}
function evLine(ev, i) {
  const ms = openMarkets(ev), l = lead(ev), w = when(ev.metadata && ev.metadata.closeTime);
  const odds = !l ? "" : ms.length > 1 ? `${cut(mTitle(l), 28)} ${pct(yesOf(l))}` : `Yes ${pct(yesOf(l))}`;
  return `${i + 1}. <b>${esc(cut(titleOf(ev), 80))}</b>${odds ? "\n   " + esc(odds) : ""}${w ? " · " + w : ""}`;
}
const fits = (data) => Buffer.byteLength(data) <= 64;
function evButtons(evs) {
  return evs.filter((ev) => ev && ev.eventId && fits("TQe:" + ev.eventId)).map((ev) => {
    const l = lead(ev);
    return [{ text: cut(`${evs.indexOf(ev) + 1}. ${titleOf(ev)}`, 44) + (l && openMarkets(ev).length === 1 ? " · " + pct(yesOf(l)) : ""), callback_data: "TQe:" + ev.eventId }];
  });
}
function navRows(f, c) {
  const cats = Object.keys(CAT);
  return [
    Object.keys(FILTER).map((k) => ({ text: (k === f ? "• " : "") + FILTER[k][1], callback_data: "TQl" + k + c })),
    cats.slice(0, 4).map((k) => ({ text: (k === c ? "• " : "") + CAT[k][1], callback_data: "TQl" + f + k })),
    cats.slice(4).map((k) => ({ text: (k === c ? "• " : "") + CAT[k][1], callback_data: "TQl" + f + k })),
    [{ text: "🔎 Search", callback_data: "TQs" }, { text: "📊 My predictions", callback_data: "TQm" }],
    [{ text: "🔄 Refresh", callback_data: "TQl" + f + c }, { text: "⬅️ Menu", callback_data: "Tm" }],
  ];
}

/** Event list for a filter (t/n/l) and category (a/c/s/p/e/u/o/t). */
async function listMsg(f, c) {
  if (!FILTER[f]) f = "t"; if (!CAT[c]) c = "a";
  const q = new URLSearchParams({ filter: FILTER[f][0], includeMarkets: "true" }); if (c !== "a") q.set("category", CAT[c][0]);
  const evs = rows(await api("/events?" + q)).filter((ev) => ev && ev.isActive !== false).slice(0, 8);
  const L = [`🔮 <b>Predict</b> · ${FILTER[f][1]}${c === "a" ? "" : " · " + CAT[c][1]}`, "Trade on real-world events. Each share pays $1 if you're right.", ""];
  if (!evs.length) L.push("Nothing here right now. Try another filter or category.");
  evs.forEach((ev, i) => L.push(evLine(ev, i)));
  L.push("", NOTE);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [...evButtons(evs), ...navRows(f, c)] } };
}

/** Search results for free text. */
async function searchMsg(query) {
  const term = cut(query, 60); if (term.length < 2) fail("Send at least two letters to search, e.g. <code>bitcoin</code>.");
  const evs = rows(await api("/events/search?" + new URLSearchParams({ query: term, limit: "8", includeMarkets: "true" }))).slice(0, 8);
  const L = [`🔎 <b>Predict</b> · results for “${esc(term)}”`, ""];
  if (!evs.length) L.push("No markets found. Try a shorter or different word.");
  evs.forEach((ev, i) => L.push(evLine(ev, i)));
  L.push("", NOTE);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [...evButtons(evs), [{ text: "🔎 Search again", callback_data: "TQs" }, { text: "📊 My predictions", callback_data: "TQm" }], [{ text: "🔥 Trending", callback_data: "TQ" }, { text: "⬅️ Menu", callback_data: "Tm" }]] } };
}

/** One event: its markets with YES / NO prices, close time and the resolution rule. */
async function eventMsg(eventId) {
  if (!/^[\w.:~-]{1,60}$/.test(String(eventId || ""))) fail("That market was not found.");
  const d = await api("/events/" + encodeURIComponent(eventId) + "?includeMarkets=true"), ev = d && d.data && !Array.isArray(d.data) ? d.data : d;
  if (!ev || (!ev.eventId && !ev.metadata)) fail("That market was not found.");
  const all = ev.markets || [], ms = openMarkets(ev).sort((a, b) => (yesOf(b) || 0) - (yesOf(a) || 0)), w = when(ev.metadata && ev.metadata.closeTime);
  const L = [`🔮 <b>${esc(cut(titleOf(ev), 200))}</b>`];
  if (ev.metadata && ev.metadata.subtitle) L.push(esc(cut(ev.metadata.subtitle, 140)));
  L.push([ev.category && esc(String(ev.category)), ev.isLive ? "🔴 live" : null, w].filter(Boolean).join(" · "), "");
  if (!ms.length) L.push(all.length ? "This event is closed for trading." + (all[0].result ? ` Result: <b>${esc(String(all[0].result).toUpperCase())}</b>` : "") : "No open markets for this event.");
  ms.slice(0, 8).forEach((m) => {
    const single = ms.length === 1 && (!mTitle(m) || mTitle(m) === titleOf(ev));
    L.push(`${single ? "" : "<b>" + esc(cut(mTitle(m) || "Market", 60)) + "</b>\n"}🟢 Yes ${esc(cents(yesOf(m)))} · 🔴 No ${esc(cents(noOf(m)))}`);
  });
  if (ms.length > 8) L.push(`<i>+ ${ms.length - 8} more outcomes</i>`);
  const rule = ms[0] && ms[0].metadata && ms[0].metadata.rulesPrimary;
  if (rule) L.push("", "<b>How it resolves</b>", esc(cut(rule, 420)));
  L.push("", "<i>Prices are per share: a 40¢ share pays $1 if you're right and $0 if you're not. Tap an outcome to buy.</i>", NOTE);
  const kb = [];
  ms.slice(0, 8).forEach((m) => {
    if (!m.marketId || !fits("TQpy99999:" + m.marketId)) return;
    const single = ms.length === 1, y = yesOf(m), n = noOf(m), row = [];
    if (y != null) row.push({ text: `🟢 ${single ? "Yes" : cut(mTitle(m) || "Yes", 18)} ${cents(y)}`, callback_data: "TQby:" + m.marketId });
    if (n != null) row.push({ text: `🔴 No ${cents(n)}`, callback_data: "TQbn:" + m.marketId });
    if (row.length) kb.push(row);
  });
  kb.push([{ text: "🔄 Refresh", callback_data: "TQe:" + eventId }, { text: "📊 My predictions", callback_data: "TQm" }], [{ text: "🔥 Trending", callback_data: "TQ" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
  return { text: L.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n"), reply_markup: { inline_keyboard: kb } };
}

const SEARCH_PROMPT = "🔎 <b>Search prediction markets</b>\nReply with a word or name, e.g. <code>bitcoin</code>, <code>election</code> or a team.";

// ---------- trading ----------
const BACK = (rows) => ({ inline_keyboard: [...(rows || []), [{ text: "📊 My predictions", callback_data: "TQm" }, { text: "🔮 Predict", callback_data: "TQ" }, { text: "⬅️ Menu", callback_data: "Tm" }]] });
const sideName = (yes) => (yes ? "YES" : "NO");
const $ = (micro) => { const n = Number(micro) / 1e6; return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2); };
/** USD amounts arrive as micro USD integers ("5000000") or decimal dollars ("5.00"). Returns micro USD (BigInt) or null. */
function micro(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) return BigInt(s);
  const n = Number(s); return Number.isFinite(n) ? BigInt(Math.round(n * 1e6)) : null;
}
/** Number of shares in an order / position object (contracts are fractional). */
function shares(o) {
  if (!o) return 0;
  if (o.contractsDecimal != null && Number.isFinite(Number(o.contractsDecimal))) return Number(o.contractsDecimal);
  if (o.contractsMicro != null && Number.isFinite(Number(o.contractsMicro))) return Number(o.contractsMicro) / 1e6;
  return Number(o.contracts) || 0;
}
const sh = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, "");
const solTxt = (lamports) => T.fromUnits(lamports, 9);
const usdcBal = async (pub) => { const t = (await X.solTokens(pub, USDC))[0]; return t ? t.raw : 0n; };
const txLink = (sig) => `<a href="${T.CH.s.exp}${sig}">View transaction</a>`;

/** USD price of 1 SOL (DEX Screener, then a Jupiter quote as fallback). */
async function solUsd() {
  const m = await X.dsPrices("solana", [X.SOL_MINT]).catch(() => ({})), p = m[X.SOL_MINT] && Number(m[X.SOL_MINT].pu);
  if (p > 5 && p < 5000) return p;
  const o = await X.jup(`/order?inputMint=${X.SOL_MINT}&outputMint=${USDC}&amount=100000000`).catch(() => null), q = o && Number(o.outAmount) / 1e5; // 0.1 SOL in micro USDC
  if (q > 5 && q < 5000) return q;
  return fail("Couldn't get the SOL price right now. Try again in a moment.");
}
const usdToLamports = (microUsd, price) => BigInt(Math.ceil(Number(microUsd) / 1e6 / price * 1e9));

async function getMarket(marketId) {
  if (!/^[\w.:~-]{1,60}$/.test(String(marketId || ""))) fail("That market was not found.");
  const m = one(await api("/markets/" + encodeURIComponent(marketId)));
  if (!m || (!m.marketId && !m.pricing)) fail("That market was not found.");
  return m;
}
function sidePrice(m, yes) { return yes ? yesOf(m) : noOf(m); }
/** Event name for a market: from the API when it has one, else from the first line of the screen the user tapped ("🔮 <event>"). */
const evOf = (m, hint) => cut((m.eventMetadata && m.eventMetadata.title) || (m.event && m.event.metadata && m.event.metadata.title) || hint || "", 120);
const hintOf = (text) => { const x = /^🔮 (.+)$/m.exec(String(text || "")); return x && !/^Predict\b/.test(x[1]) ? x[1].trim() : ""; };
const fullTitle = (m, hint) => { const t = mTitle(m) || "Market", ev = evOf(m, hint); return cut(ev && ev !== t ? ev + " · " + t : t, 140); };
function marketHead(m, yes, hint) {
  const t = mTitle(m) || "Market", ev = evOf(m, hint);
  return `🔮 <b>${esc(ev || cut(t, 120))}</b>${ev && ev !== t ? "\n" + esc(cut(t, 120)) : ""}\nYour pick: <b>${yes ? "🟢 YES" : "🔴 NO"}</b>`;
}
function checkOpen(m, yes) {
  if (m.status && m.status !== "open") fail("This market is closed for trading.");
  const p = sidePrice(m, yes); if (p == null || p <= 0) fail("No price for this side right now. Try again later.");
  if (p >= 0.995) fail("This side is priced at about $1, so there is nothing left to win.");
  return p;
}
const backToEvent = (m) => (m.eventId && fits("TQe:" + m.eventId) ? { text: "⬅️ Back", callback_data: "TQe:" + m.eventId } : { text: "⬅️ Back", callback_data: "TQ" });

/** Step 1 of a buy: choose how many dollars. */
async function amountMsg(marketId, yes, hint) {
  const m = await getMarket(marketId), p = checkOpen(m, yes), s = yes ? "y" : "n";
  const amts = PRESETS.filter((a) => a >= minUsd() && a <= maxUsd());
  return { text: `${marketHead(m, yes, hint)}\nPrice: <b>${esc(cents(p))}</b> per share · each share pays <b>$1</b> if ${yes ? "it happens" : "it doesn't happen"}\n\nHow much do you want to put in? (minimum $${minUsd()})\n<i>Paid in USDC. If your wallet has SOL only, the Bartender swaps the needed USDC from your SOL first.</i>`,
    reply_markup: { inline_keyboard: [amts.map((a) => ({ text: "$" + a, callback_data: `TQp${s}${a}:${marketId}` })), [{ text: "✏️ Other amount", callback_data: `TQi${s}:${marketId}` }, backToEvent(m)]] } };
}

function parseUsd(v) {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n !== Math.round(n)) fail(`Send a whole dollar amount, e.g. <code>20</code>.`);
  if (n < minUsd()) fail(`The minimum order is $${minUsd()}.`);
  if (n > maxUsd()) fail(`The maximum order here is $${maxUsd()}.`);
  return n;
}

/** Step 2 of a buy: what the user gets and pays. Nothing is sent yet. */
async function previewMsg(row, marketId, yes, usd, hint) {
  usd = parseUsd(usd);
  const m = await getMarket(marketId), p = checkOpen(m, yes), s = yes ? "y" : "n", dep = BigInt(usd) * 1000000n;
  const [have, sol, price] = await Promise.all([usdcBal(row.sol_pub).catch(() => 0n), X.solBal(row.sol_pub).catch(() => null), solUsd()]);
  const feeUsd = dep * BigInt(T.feeBps()) / 10000n, need = have >= dep ? 0n : dep - have;
  const L = [marketHead(m, yes, hint), "",
    `Order: <b>$${usd}</b> at about <b>${esc(cents(p))}</b> per share`,
    `You get about <b>${sh(usd / p)} shares</b> → pays about <b>$${(usd / p).toFixed(2)}</b> if you're right, $0 if not`,
    `CBL fee: ${T.feeBps() / 100}% = ${$(feeUsd)}, taken in SOL (≈ ${solTxt(usdToLamports(feeUsd, price))} SOL) after the order fills`,
    "<i>The final price is set when the order fills, and the market's own trading fee is included in it.</i>", "",
    `Wallet: ${$(have)} USDC · ${sol == null ? "?" : solTxt(sol)} SOL`];
  if (need > 0n) L.push(`The Bartender will first swap about <b>${solTxt(usdToLamports(need, price))} SOL</b> into the missing ${$(need)} USDC.`);
  L.push("", "<i>By confirming you state that you are not a resident of the United States or South Korea.</i>");
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [[{ text: `✅ Confirm $${usd} on ${sideName(yes)}`, callback_data: `TQo${s}${usd}:${marketId}` }], [{ text: "❌ Cancel", callback_data: `TQb${s}:${marketId}` }]] } };
}

// ---------- sending transactions ----------
async function sendTx(row, b64) {
  if (!b64 || typeof b64 !== "string") fail("Jupiter did not return a transaction. Try again.");
  const signed = V.solSignTx(b64, V.solSeed(row));
  let sig;
  try { sig = await X.srpc("sendTransaction", [signed, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }], 15000); }
  catch (e) {
    if (!/blockhash/i.test(String(e.message))) fail("Solana rejected the transaction: " + cut(e.message, 150));
    sig = await X.srpc("sendTransaction", [signed, { encoding: "base64", skipPreflight: true, maxRetries: 5 }], 15000).catch((e2) => fail("Solana rejected the transaction: " + cut(e2.message, 150)));
  }
  if (!sig || typeof sig !== "string") fail("Solana did not accept the transaction. Nothing was sent. Try again.");
  return sig;
}
/** true = confirmed, false = not seen before the deadline. Throws if it failed on-chain. */
async function confirm(sig, deadline) {
  while (Date.now() < deadline) {
    const r = await X.srpc("getSignatureStatuses", [[sig]], 8000).catch(() => null), st = r && r.value && r.value[0];
    if (st && st.err) fail(`The transaction failed on-chain, nothing was bought or sold.\n${T.CH.s.exp}${sig}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return true;
    await sleep(1300);
  }
  return false;
}
/** Order fill status: created | partiallyfilled | filled | failed | null (unknown yet). */
async function orderStatus(orderPubkey) {
  let d; try { d = await api("/orders/status/" + encodeURIComponent(orderPubkey)); } catch (e) { return null; }
  const o = one(d) || {}, raw = String(o.status || (o.order && o.order.status) || "").toLowerCase().replace(/[^a-z]/g, "");
  if (["created", "partiallyfilled", "filled", "failed"].includes(raw)) return raw;
  if (raw === "pending") return "created";
  const j = JSON.stringify(d || ""); // some versions answer with an event history instead of a status field
  return /order_failed/.test(j) ? "failed" : /order_filled/.test(j) ? "filled" : null;
}
async function waitFill(orderPubkey, deadline) {
  let st = null;
  while (Date.now() < deadline) {
    st = await orderStatus(orderPubkey);
    if (st === "filled" || st === "failed") return st;
    await sleep(2000);
  }
  return st;
}
const getPosition = async (pubkey) => { try { return one(await api("/positions/" + encodeURIComponent(pubkey))); } catch (e) { return null; } };

// ---------- pending orders (bot_orders, kind "pred") ----------
async function savePending(uid, marketId, params) {
  const r = await db.insertRet("bot_orders", [{ tg_id: uid, chain: "solana", token: ("pred:" + marketId).slice(0, 120), kind: "pred", params, active: true }]).catch((e) => { console.error("pred pending save", e.message); return null; });
  return r && r[0] ? r[0] : null;
}
/** Only one caller (this request or the cron job) may finish an order: whoever flips active to false wins. */
async function take(id) {
  if (!id) return true;
  const r = await db.patchRet("bot_orders", `id=eq.${Number(id)}&active=eq.true`, { active: false }).catch(() => null);
  return Array.isArray(r) && r.length > 0;
}

/** Send the CBL fee (in SOL) for a filled order and write the trade row. Returns lamports actually paid. */
async function chargeFee(row, o, baseMicro, sig, contracts) {
  const bps = BigInt(T.feeBps()), to = X.feeTo("s");
  let price = null; try { price = await solUsd(); } catch (e) {}
  const fee = to && bps > 0n && price && baseMicro > 0n ? usdToLamports(baseMicro * bps / 10000n, price) : 0n;
  let paid = 0n;
  if (fee > 0n) { try { await X.solSend(row, to, fee); paid = fee; } catch (e) { console.error("pred fee transfer failed", e.message); } }
  await X.record({ tg_id: row.tg_id, chain: "solana", token: ("pred:" + o.marketId).slice(0, 120), side: o.op === "sell" ? "sell" : "buy", native_raw: (price ? usdToLamports(baseMicro, price) : 0n).toString(),
    token_raw: String(Math.round((contracts || 0) * 1e6)), decimals: 6, tx: sig || null, fee_raw: paid.toString() });
  return paid;
}
/** A buy order was filled: work out what was bought, charge the fee. */
async function finishBuy(row, o) {
  const pos = o.pos ? await getPosition(o.pos) : null, dep = BigInt(o.usd);
  const cost = pos && micro(pos.totalCostUsd), base = cost && cost > 0n && cost < dep ? cost : dep; // a first buy on a market: the position cost is the filled amount
  const n = shares(pos) || shares(o.q), avg = pos ? px(pos.avgPriceUsd) : null;
  const fee = await chargeFee(row, o, base, o.sig, n);
  return { n, avg, fee, base };
}
async function finishSell(row, o, got) {
  const base = got && got > 0n ? got : BigInt(o.est || "0");
  const fee = await chargeFee(row, o, base, o.sig, Number(o.n) || 0);
  return { fee, base };
}
const boughtTxt = (o, r) => `✅ <b>Bought ${r.n ? sh(r.n) + " " : ""}${sideName(o.yes)} shares</b>${r.avg ? " at " + esc(cents(r.avg)) : ""} for ${$(r.base)}\n${esc(cut(o.title, 140))}\nPays <b>$${r.n ? r.n.toFixed(2) : "1 per share"}</b> if you're right.${r.fee > 0n ? `\nCBL fee: ${solTxt(r.fee)} SOL` : ""}${o.sig ? "\n" + txLink(o.sig) : ""}`;
const soldTxt = (o, r) => `✅ <b>Sold ${o.n ? sh(Number(o.n)) + " " : ""}${sideName(o.yes)} shares</b> for about ${$(r.base)} USDC\n${esc(cut(o.title, 140))}${r.fee > 0n ? `\nCBL fee: ${solTxt(r.fee)} SOL` : ""}${o.sig ? "\n" + txLink(o.sig) : ""}`;
const FAILED = (o) => `⚠️ <b>Your ${o.op === "sell" ? "sell" : "buy"} order could not be filled</b>\n${esc(cut(o.title, 140))}\nJupiter closes unfilled orders automatically${o.op === "sell" ? "; your shares stay in 📊 My predictions" : " and the USDC goes back to your wallet"}. No CBL fee was charged.`;

/** Buy `usd` dollars of YES / NO shares. `say(html)` updates the progress message. */
async function buy(uid, marketId, yes, usd, say, hint) {
  const t0 = Date.now(), end = t0 + 50000; usd = parseUsd(usd);
  const row = await T.getRow(uid); if (!row) fail("Open /trade first to create your wallet.");
  const st = T.settings(row), m = await getMarket(marketId), p = checkOpen(m, yes), dep = BigInt(usd) * 1000000n;
  const ts = await api("/trading-status").catch(() => null); if (ts && one(ts) && one(ts).trading_active === false) fail("Prediction trading is paused by the exchange right now. Try again later.");
  const [have, sol, price] = await Promise.all([usdcBal(row.sol_pub), X.solBal(row.sol_pub), solUsd()]);
  const need = have >= dep ? 0n : dep - have, swapIn = need > 0n ? usdToLamports(need < 1000000n ? 1000000n : need, price) * 102n / 100n : 0n; // 2% over, at least $1, so the swap covers the order
  const feeEst = usdToLamports(dep * BigInt(T.feeBps()) / 10000n, price), reserve = X.toUnits("0.012", 9); // network fees + rent for the order and position accounts
  if (sol < swapIn + feeEst + reserve) fail(`Not enough SOL. This order needs about ${solTxt(swapIn + feeEst + reserve)} SOL (${need > 0n ? "swap to USDC, " : ""}fee and network costs); you have ${solTxt(sol)} SOL${have > 0n ? " and " + $(have) + " USDC" : ""}.\nDeposit SOL to your Solana address in /trade.`);
  if (!(await X.lock(uid))) fail("Another trade is still running. Wait a few seconds.");
  let swapped = false, sent = false;
  try {
    if (swapIn > 0n) {
      await say(`⏳ Swapping ${solTxt(swapIn)} SOL to USDC…`);
      await X.solSwap(row, X.SOL_MINT, USDC, swapIn, st); swapped = true;
      let now = 0n; for (let i = 0; i < 6 && (now = await usdcBal(row.sol_pub).catch(() => 0n)) < dep; i++) await sleep(1200);
      if (now < dep) fail(`The swap gave ${$(now)} USDC, a little under the $${usd} order. The USDC stays in your wallet: try again, or pick a smaller amount.`);
    }
    await say(`⏳ Placing your $${usd} ${sideName(yes)} order…`);
    const q = await api("/orders", "POST", { ownerPubkey: row.sol_pub, marketId, isYes: !!yes, isBuy: true, depositAmount: dep.toString(), depositMint: USDC });
    const ord = (q && q.order) || {}; if (!q || !q.transaction) fail(errOf(q, 200) === "Jupiter error 200" ? "Jupiter could not build this order. Try again." : errOf(q, 200));
    const sig = await sendTx(row, q.transaction); sent = true;
    const o = { op: "buy", marketId, yes: !!yes, usd: dep.toString(), order: ord.orderPubkey || null, pos: ord.positionPubkey || null, sig, title: fullTitle(m, hint), q: { contractsMicro: ord.contractsMicro, contractsDecimal: ord.contractsDecimal, contracts: ord.contracts }, t: t0 };
    const pend = await savePending(uid, marketId, o);
    if (!(await confirm(sig, Math.min(end, Date.now() + 25000)))) return { text: `🕒 <b>Order sent, not confirmed yet</b>\n${esc(o.title)}\nSolana is slow to confirm it. I'll message you when it fills; if it never lands, nothing is spent.\n${txLink(sig)}`, reply_markup: BACK() };
    await say(`⏳ Order placed at about ${esc(cents(p))}. Waiting for it to fill…`);
    const fs = o.order ? await waitFill(o.order, end) : null;
    if (fs === "failed") { await take(pend && pend.id); return { text: FAILED(o), reply_markup: BACK() }; }
    if (fs !== "filled") return { text: `🕒 <b>Order placed, waiting to be filled</b>\n${esc(o.title)}\n$${usd} on ${sideName(yes)}. I'll message you when it fills (checked every few minutes).\n${txLink(sig)}`, reply_markup: BACK() };
    if (!(await take(pend && pend.id))) return { text: `✅ <b>Order filled</b>\n${esc(o.title)}`, reply_markup: BACK() }; // the cron job got there first and sends the details
    return { text: boughtTxt(o, await finishBuy(row, o)), reply_markup: BACK() };
  } catch (e) {
    if (swapped && !sent && e instanceof UserErr) fail(e.message + "\n\nNo order was placed. The USDC from the swap stays in your wallet: try again, or swap it back in 📊 My predictions → 💵 USDC → SOL.");
    throw e;
  } finally { await X.unlock(uid); }
}

/** My predictions: open positions with value and profit, sell / claim buttons. */
async function positionsMsg(row) {
  const [ps, have] = await Promise.all([api("/positions?ownerPubkey=" + row.sol_pub).then(rows), usdcBal(row.sol_pub).catch(() => 0n)]);
  const open = ps.filter((x) => x && x.pubkey && !x.claimed && (shares(x) > 0 || x.claimable)).slice(0, 10);
  const L = ["📊 <b>My predictions</b>", ""], kb = [];
  if (!open.length) L.push("No open predictions yet. Open 🔮 Predict, pick a market and tap an outcome.");
  open.forEach((x, i) => {
    const ev = x.eventMetadata && x.eventMetadata.title, mt = x.marketMetadata && x.marketMetadata.title, title = ev && mt && ev !== mt ? ev + " · " + mt : mt || ev || x.marketId || "Market";
    const n = shares(x), val = micro(x.valueUsd), pnl = micro(x.pnlUsd), avg = px(x.avgPriceUsd), res = x.marketMetadata && x.marketMetadata.result;
    L.push(`${i + 1}. <b>${esc(cut(title, 90))}</b>\n   ${x.isYes ? "🟢 YES" : "🔴 NO"} · ${sh(n)} shares${avg ? " at " + esc(cents(avg)) : ""}${val != null ? " · worth " + $(val) : ""}${pnl != null ? ` · ${pnl >= 0n ? "🟢 +" + $(pnl) : "🔴 " + $(pnl)}` : ""}${x.claimable ? "\n   🏆 Won: " + (micro(x.payoutUsd) != null ? $(micro(x.payoutUsd)) : "$" + n.toFixed(2)) + " ready to claim" : res ? "\n   Result: " + esc(String(res).toUpperCase()) : ""}${x.openOrders > 0 ? "\n   🕒 order still filling" : ""}`);
    kb.push([x.claimable ? { text: `💰 Claim ${i + 1}`, callback_data: "TQc:" + x.pubkey } : { text: `🔴 Sell ${i + 1} · ${cut(title, 24)}`, callback_data: "TQx:" + x.pubkey }]);
  });
  L.push("", `Wallet: <b>${$(have)} USDC</b>`, "<i>Winnings and sale proceeds arrive as USDC. Use them for the next prediction or turn them back into SOL.</i>");
  const last = [{ text: "🔄 Refresh", callback_data: "TQm" }]; if (have >= 500000n) last.push({ text: "💵 USDC → SOL", callback_data: "TQu" });
  kb.push(last, [{ text: "🔮 Predict", callback_data: "TQ" }, { text: "⬅️ Menu", callback_data: "Tm" }]);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}
function posTitle(x) { const ev = x.eventMetadata && x.eventMetadata.title, mt = x.marketMetadata && x.marketMetadata.title; return cut(ev && mt && ev !== mt ? ev + " · " + mt : mt || ev || x.marketId || "Market", 140); }
async function myPosition(row, pubkey) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(pubkey || ""))) fail("That position was not found.");
  const x = await getPosition(pubkey); if (!x || (x.ownerPubkey && x.ownerPubkey !== row.sol_pub)) fail("That position was not found in your wallet.");
  return x;
}
async function sellAskMsg(row, pubkey) {
  const x = await myPosition(row, pubkey), n = shares(x), val = micro(x.valueUsd), sp = px(x.sellPriceUsd);
  if (x.claimable) fail("This prediction already won. Tap 💰 Claim instead.");
  if (!(n > 0)) fail("There are no shares left in this position.");
  return { text: `🔴 <b>Sell this prediction?</b>\n${esc(posTitle(x))}\n${x.isYes ? "🟢 YES" : "🔴 NO"} · <b>${sh(n)} shares</b>${sp ? " at about " + esc(cents(sp)) : ""}${val != null ? " ≈ <b>" + $(val) + "</b>" : ""}\n\nYou sell all shares at the current market price and receive USDC. CBL fee: ${T.feeBps() / 100}% of the proceeds, taken in SOL.`,
    reply_markup: { inline_keyboard: [[{ text: "✅ Yes, sell all", callback_data: "TQz:" + pubkey }, { text: "❌ Cancel", callback_data: "TQm" }]] } };
}
async function sell(uid, pubkey, say) {
  const t0 = Date.now(), end = t0 + 50000, row = await T.getRow(uid); if (!row) fail("Open /trade first to create your wallet.");
  const x = await myPosition(row, pubkey), n = shares(x); if (!(n > 0)) fail("There are no shares left in this position.");
  const sp = px(x.sellPriceUsd), est = micro(x.valueUsd) || (sp ? BigInt(Math.round(n * sp * 1e6)) : 0n);
  if ((await X.solBal(row.sol_pub)) < X.toUnits("0.003", 9)) fail("You need a little SOL for network fees. Deposit some first.");
  if (!(await X.lock(uid))) fail("Another trade is still running. Wait a few seconds.");
  try {
    const before = await usdcBal(row.sol_pub).catch(() => null);
    await say("⏳ Selling…");
    const q = await api("/positions/" + encodeURIComponent(pubkey), "DELETE", { ownerPubkey: row.sol_pub }), ord = (q && q.order) || {};
    if (!q || !q.transaction) fail("Jupiter could not build the sell order. Try again.");
    const sig = await sendTx(row, q.transaction);
    const o = { op: "sell", marketId: x.marketId || "", yes: !!x.isYes, order: ord.orderPubkey || null, pos: pubkey, sig, title: posTitle(x), n, est: est.toString(), t: t0 };
    const pend = await savePending(uid, o.marketId, o);
    if (!(await confirm(sig, Math.min(end, Date.now() + 25000)))) return { text: `🕒 <b>Sell sent, not confirmed yet</b>\n${esc(o.title)}\nI'll message you when it fills.\n${txLink(sig)}`, reply_markup: BACK() };
    await say("⏳ Sell order placed. Waiting for it to fill…");
    let got = null, fs = null; // proceeds = the USDC that arrives in the wallet
    while (Date.now() < end) {
      fs = o.order ? await orderStatus(o.order) : null; if (fs === "failed") break;
      const now = before == null ? null : await usdcBal(row.sol_pub).catch(() => null);
      if (now != null && now > before) { got = now - before; break; }
      if (fs === "filled" && before == null) break;
      await sleep(2000);
    }
    if (fs === "failed") { await take(pend && pend.id); return { text: FAILED(o), reply_markup: BACK() }; }
    if (got == null && fs !== "filled") return { text: `🕒 <b>Sell order placed, waiting to be filled</b>\n${esc(o.title)}\nI'll message you when it fills (checked every few minutes).\n${txLink(sig)}`, reply_markup: BACK() };
    if (!(await take(pend && pend.id))) return { text: `✅ <b>Sold</b>\n${esc(o.title)}`, reply_markup: BACK() };
    return { text: soldTxt(o, await finishSell(row, o, got)), reply_markup: BACK() };
  } finally { await X.unlock(uid); }
}
/** Claim a won position: $1 per share, no fee. */
async function claim(uid, pubkey, say) {
  const row = await T.getRow(uid); if (!row) fail("Open /trade first to create your wallet.");
  const x = await myPosition(row, pubkey);
  if (x.claimed) fail("This prediction was already claimed.");
  if ((await X.solBal(row.sol_pub)) < X.toUnits("0.002", 9)) fail("You need a little SOL for network fees. Deposit some first.");
  if (!(await X.lock(uid))) fail("Another trade is still running. Wait a few seconds.");
  try {
    await say("⏳ Claiming…");
    const q = await api("/positions/" + encodeURIComponent(pubkey) + "/claim", "POST", { ownerPubkey: row.sol_pub });
    if (!q || !q.transaction) return { text: `ℹ️ ${esc(cut((q && (q.message || q.error)) || "Nothing to claim here: this market pays out automatically.", 200))}`, reply_markup: BACK() };
    const sig = await sendTx(row, q.transaction), ok = await confirm(sig, Date.now() + 30000), pay = q.position && micro(q.position.payoutAmountUsd);
    return { text: `${ok ? "✅ <b>Claimed</b>" : "🕒 <b>Claim sent</b>, waiting for Solana to confirm"}${pay != null ? " " + $(pay) + " USDC" : ""}\n${esc(posTitle(x))}\nNo fee on claims.\n${txLink(sig)}`, reply_markup: BACK() };
  } finally { await X.unlock(uid); }
}
/** Turn the wallet's USDC back into SOL (plain Jupiter swap, no CBL fee). */
async function usdcAskMsg(row) {
  const have = await usdcBal(row.sol_pub); if (have < 500000n) fail("There is less than $0.50 USDC in your wallet.");
  return { text: `💵 <b>Swap ${$(have)} USDC to SOL?</b>\nAll USDC in your Bartender wallet is swapped to SOL through Jupiter. No CBL fee.`, reply_markup: { inline_keyboard: [[{ text: "✅ Swap to SOL", callback_data: "TQU" }, { text: "❌ Cancel", callback_data: "TQm" }]] } };
}
async function usdcToSol(uid, say) {
  const row = await T.getRow(uid); if (!row) fail("Open /trade first to create your wallet.");
  const have = await usdcBal(row.sol_pub); if (have < 500000n) fail("There is less than $0.50 USDC in your wallet.");
  if (!(await X.lock(uid))) fail("Another trade is still running. Wait a few seconds.");
  try { await say("⏳ Swapping USDC to SOL…"); const r = await X.solSwap(row, USDC, X.SOL_MINT, have, T.settings(row)); return { text: `✅ Swapped ${$(have)} USDC to ${solTxt(r.out)} SOL\n${txLink(r.sig)}`, reply_markup: BACK() }; }
  finally { await X.unlock(uid); }
}

// ---------- Telegram wiring (called from tradebot.js) ----------
/** Callback queries starting with "TQ". ui = { d, uid, chat, mid, row, ack, edit, send, prompt, errText }. */
async function callback(ui) {
  const { d, uid, chat, mid, row, ack, edit, send, prompt, errText } = ui, sub = d[2], hint = hintOf(ui.text);
  const show = async (make, wait) => {
    await ack(wait);
    try { const r = await edit(chat, mid, await make()); if (r && r.ok === false && !/not modified/i.test(r.description || "")) { console.error("predict edit failed", d, r.description); await send(chat, "⚠️ Couldn't show this screen. Try again in a moment."); } }
    catch (e) { await edit(chat, mid, { text: errText(e), reply_markup: BACK() }); }
  };
  const run = async (first, work) => { // long actions: one progress message that is edited as it goes
    await ack();
    await edit(chat, mid, first);
    const say = (t) => edit(chat, mid, t).catch(() => {});
    try { await edit(chat, mid, await work(say)); } catch (e) { await edit(chat, mid, { text: errText(e), reply_markup: BACK() }); }
  };
  if (sub === "s") { await ack(); await prompt(chat, SEARCH_PROMPT, "pred", "bitcoin"); return true; }
  if (sub === "m") return void (await show(() => positionsMsg(row), "Loading your predictions…")) || true;
  if (sub === "u") return void (await show(() => usdcAskMsg(row))) || true;
  if (sub === "U") return void (await run("⏳ Swapping USDC to SOL…", (say) => usdcToSol(uid, say))) || true;
  if (sub === "e") return void (await show(() => eventMsg(d.slice(4)), "Loading market…")) || true;
  if (sub === "x") return void (await show(() => sellAskMsg(row, d.slice(4)))) || true;
  if (sub === "z") return void (await run("⏳ Selling…", (say) => sell(uid, d.slice(4), say))) || true;
  if (sub === "c") return void (await run("⏳ Claiming…", (say) => claim(uid, d.slice(4), say))) || true;
  const m = /^TQ([bipo])([yn])(\d{0,5}):(.+)$/.exec(d);
  if (m) {
    const [, act, s, amt, marketId] = m, yes = s === "y";
    if (act === "b") return void (await show(() => amountMsg(marketId, yes, hint))) || true;
    if (act === "i") { await ack(); await prompt(chat, `✏️ How many dollars on <b>${sideName(yes)}</b>? Reply with a whole number from ${minUsd()} to ${maxUsd()}, e.g. <code>20</code>\nMarket: <code>${esc(marketId)}</code>\nSide: ${sideName(yes)}${hint ? "\nEvent: " + esc(hint) : ""}`, "pred:buy", "20"); return true; }
    if (act === "p") return void (await show(() => previewMsg(row, marketId, yes, amt, hint))) || true;
    if (act === "o") return void (await run(`⏳ Preparing your $${esc(amt)} ${sideName(yes)} order…`, (say) => buy(uid, marketId, yes, amt, say, hint))) || true;
  }
  return void (await show(() => listMsg(sub === "l" ? d[3] : "t", sub === "l" ? d[4] : "a"), "Loading markets…")) || true;
}
/** Replies to #pred prompts: search words, or a custom amount (#pred:buy). */
async function reply(ui) {
  const { a1, uid, chat, txt, promptText, send, errText } = ui;
  try {
    if (a1 === "buy") {
      const mk = /Market:\s*(\S+)/.exec(promptText || ""), sd = /Side:\s*(YES|NO)/.exec(promptText || ""), row = await T.getRow(uid);
      if (!mk || !sd || !row) fail("That prompt expired. Open the market again and tap an outcome.");
      return void (await send(chat, await previewMsg(row, mk[1], sd[1] === "YES", txt, (/Event:\s*(.+)/.exec(promptText || "") || [])[1])));
    }
    await send(chat, await searchMsg(txt));
  } catch (e) { await send(chat, errText(e)); }
}

/** Cron ("orders" job): finish orders that were still waiting when the user's request ended, and tell the user. */
async function job(deadline) {
  const out = { pred: 0, predDone: 0 };
  if (!on() || !db.on()) return out;
  const list = (await db.select("bot_orders", "active=eq.true&kind=eq.pred&select=*&order=created_at.asc&limit=60").catch(() => [])) || [];
  const tell = (uid, text) => fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: uid, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: BACK() }) }).catch(() => {});
  for (const r of list) {
    if (Date.now() > deadline) break;
    out.pred++;
    try {
      const o = r.params || {}, age = Date.now() - (Number(o.t) || Date.parse(r.created_at) || 0);
      if (age < 60000) continue; // the user's own request may still be working on it
      let st = o.order ? await orderStatus(o.order) : null;
      if (!o.order && o.op === "sell") { const x = await getPosition(o.pos); if (!x || !(shares(x) > 0)) st = "filled"; } // no order id: the position is gone once sold
      if (st !== "filled" && st !== "failed") { if (age > 864e5 && (await take(r.id))) out.predDone++; continue; } // give up after a day, no fee
      if (!(await take(r.id))) continue;
      out.predDone++;
      if (st === "failed") { await tell(r.tg_id, FAILED(o)); continue; }
      const row = await T.getRow(r.tg_id); if (!row) continue;
      await tell(r.tg_id, o.op === "sell" ? soldTxt(o, await finishSell(row, o, null)) : boughtTxt(o, await finishBuy(row, o)));
    } catch (e) { console.error("pred job", r.id, e && e.message); }
  }
  return out;
}

module.exports = { on, listMsg, searchMsg, eventMsg, callback, reply, job, SEARCH_PROMPT, FILTER, CAT, _: { px, cents, pct, when, lead, evLine, rows, micro, shares, usdToLamports } };
