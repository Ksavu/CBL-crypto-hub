// Predict: prediction markets inside CBL Bartender, through Jupiter's Prediction API (markets come from Polymarket and Kalshi).
//   Step 1 (this file): browse, search and event view, read-only. Buy / sell / claim and the CBL fee come in the next step.
//   Needs JUP_API_KEY (the same key the Solana swaps use). The API is in beta and Jupiter blocks US and South Korea IPs.
//   Callback data (Telegram limit 64 bytes):
//     TQ                 home (trending, all categories)
//     TQl<filter><cat>   list, e.g. TQltc = trending crypto
//     TQe:<eventId>      one event with its markets
//     TQs                search prompt (the reply is handled in tradebot.js, tag #pred)
const { UserErr } = require("./trade");
const { esc } = require("./format");

const BASE = "https://api.jup.ag/prediction/v1";
const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
const on = () => !!clean(process.env.JUP_API_KEY);
const fail = (m) => { throw new UserErr(m); };

const FILTER = { t: ["trending", "🔥 Trending"], n: ["new", "🆕 New"], l: ["live", "🔴 Live"] };
const CAT = { a: ["all", "All"], c: ["crypto", "Crypto"], s: ["sports", "Sports"], p: ["politics", "Politics"], e: ["esports", "E-sports"], u: ["culture", "Culture"], o: ["economics", "Economics"], t: ["tech", "Tech"] };
const NOTE = "<i>Preview: browsing only for now, trading opens soon. Markets by Polymarket and Kalshi via Jupiter. Not available to residents of the US or South Korea.</i>";

async function api(path) {
  const key = clean(process.env.JUP_API_KEY); if (!key) fail("Predict is not switched on yet (JUP_API_KEY).");
  const c = new AbortController(), t = setTimeout(() => c.abort(), 12000);
  let r, d = null;
  try { r = await fetch(BASE + path, { headers: { "x-api-key": key, accept: "application/json" }, signal: c.signal }); try { d = await r.json(); } catch (e) {} }
  catch (e) { fail("Jupiter did not answer. Try again in a moment."); }
  finally { clearTimeout(t); }
  if (!r.ok) fail(r.status === 403 || r.status === 451 ? "Prediction markets are not available from this server's region." : r.status === 404 ? "That market was not found." : r.status === 429 ? "Too many requests. Try again in a minute." : String((d && (d.error || d.message)) || "Jupiter error " + r.status).slice(0, 160));
  return d;
}
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
    [{ text: "🔎 Search", callback_data: "TQs" }, { text: "🔄 Refresh", callback_data: "TQl" + f + c }, { text: "⬅️ Menu", callback_data: "Tm" }],
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
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [...evButtons(evs), [{ text: "🔎 Search again", callback_data: "TQs" }, { text: "🔥 Trending", callback_data: "TQ" }, { text: "⬅️ Menu", callback_data: "Tm" }]] } };
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
  L.push("", "<i>Prices are per share: a 40¢ share pays $1 if you're right and $0 if you're not.</i>", NOTE);
  return { text: L.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "TQe:" + eventId }, { text: "🔥 Trending", callback_data: "TQ" }, { text: "⬅️ Menu", callback_data: "Tm" }]] } };
}

const SEARCH_PROMPT = "🔎 <b>Search prediction markets</b>\nReply with a word or name, e.g. <code>bitcoin</code>, <code>election</code> or a team.";

module.exports = { on, listMsg, searchMsg, eventMsg, SEARCH_PROMPT, FILTER, CAT, _: { px, cents, pct, when, lead, evLine, rows } };
