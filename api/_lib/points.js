// CBL Points: free-to-earn points for using CBL, a weekly + all-time leaderboard, and a global group ranking (/rank).
//   Trades in the Bartender, invited friends who trade, scans, and calls that pump all earn points.
//   Totals are recalculated from the source tables every 30 minutes (cron "trending"), so nothing can be double-counted.
//   Weekly winners post: Monday at WEEKLY_HOUR_UTC (default 10) in the Trending channel. Prize text: WEEKLY_PRIZE.
const db = require("./db");
const { esc } = require("./format");

const P = { trade: 10, tradeDayCap: 30, ref: 200, scan: 2, scanDayCap: 25, call: 5, x2: 50, x5: 150, x10: 300 };
const env = (k) => String(process.env[k] || "").trim();
const bot = () => env("TELEGRAM_BOT_USERNAME").replace(/^@/, "");
const day = (t) => new Date(t).toISOString().slice(0, 10);
function weekStart(now = Date.now()) { const d = new Date(now); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); }

// ---------- recording ----------
const named = new Map();
/** Remember a user's display name (for leaderboards). Cheap: once per instance per user. */
async function seen(from) {
  if (!from || !from.id || !db.on() || named.get(from.id) === (from.username || from.first_name)) return;
  named.set(from.id, from.username || from.first_name); if (named.size > 5000) named.clear();
  await db.upsert("points_users", [{ tg_id: from.id, username: from.username || null, name: [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 40) || null }], "tg_id").catch(() => {});
}
/** One scan of a token per user per day earns points (capped per day at recalculation). */
async function scan(from, ca) {
  if (!from || !from.id || !db.on()) return;
  seen(from);
  await db.insertNew("points_events", [{ tg_id: from.id, kind: "scan", ref: day(Date.now()) + ":" + String(ca).slice(0, 64) }], "tg_id,kind,ref").catch(() => {});
}

// ---------- recalculation ----------
async function all(table, q, max = 50000) {
  const out = [];
  for (let off = 0; off < max; off += 1000) { const r = (await db.select(table, `${q}&limit=1000&offset=${off}`).catch(() => null)) || []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
async function compute() {
  const ws = weekStart(), U = new Map();
  const u = (id) => { if (!U.has(id)) U.set(id, { tg_id: id, total: 0, week: 0, trades: 0, refs: 0, scans: 0, calls: 0, best_x: 0 }); return U.get(id); };
  const add = (id, pts, t) => { const x = u(id); x.total += pts; if (t >= ws) x.week += pts; };

  const trades = await all("bot_trades", "select=tg_id,created_at&order=id.asc");
  const perDay = new Map(), traders = new Set();
  for (const t of trades) { traders.add(t.tg_id); const k = t.tg_id + ":" + day(t.created_at), n = (perDay.get(k) || 0) + 1; perDay.set(k, n); if (n <= P.tradeDayCap) { add(t.tg_id, P.trade, Date.parse(t.created_at)); u(t.tg_id).trades++; } }

  const refs = await all("bot_refs", "select=tg_id,ref_by,created_at");
  for (const r of refs) if (traders.has(r.tg_id)) { add(r.ref_by, P.ref, Date.parse(r.created_at)); u(r.ref_by).refs++; }

  const scans = await all("points_events", "kind=eq.scan&select=tg_id,ref,created_at");
  const sDay = new Map();
  for (const s of scans) { const k = s.tg_id + ":" + String(s.ref).slice(0, 10), n = (sDay.get(k) || 0) + 1; sDay.set(k, n); if (n <= P.scanDayCap) { add(s.tg_id, P.scan, Date.parse(s.created_at)); u(s.tg_id).scans++; } }

  const calls = await all("calls", "select=user_id,username,name,mcap,peak_mcap,created_at");
  const names = new Map();
  for (const c of calls) {
    const t = Date.parse(c.created_at), x = Number(c.mcap) > 0 && Number(c.peak_mcap) > 0 ? c.peak_mcap / c.mcap : 0;
    add(c.user_id, P.call + (x >= 10 ? P.x10 : x >= 5 ? P.x5 : x >= 2 ? P.x2 : 0), t);
    const k = u(c.user_id); k.calls++; if (x > k.best_x) k.best_x = Math.round(x * 10) / 10;
    if (!names.has(c.user_id)) names.set(c.user_id, { username: c.username, name: c.name });
  }

  const pu = await all("points_users", "select=tg_id,username,name");
  pu.forEach((r) => names.set(r.tg_id, { username: r.username, name: r.name }));
  const rows = [...U.values()].filter((x) => x.total > 0).map((x) => Object.assign(x, names.get(x.tg_id) || {}, { updated_at: new Date().toISOString() }));
  rows.sort((a, b) => b.total - a.total).forEach((r, i) => (r.rank = i + 1));
  for (let i = 0; i < rows.length; i += 500) await db.upsert("points", rows.slice(i, i + 500), "tg_id").catch((e) => console.error("points upsert", e.message));
  return { users: rows.length };
}

/** Group ranking over 7 days: average peak X of its calls (groups with 5+ calls). */
async function groups(days = 7) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const calls = await all("calls", `created_at=gte.${since}&select=chat_id,mcap,peak_mcap`, 20000);
  const G = new Map();
  for (const c of calls) { const x = Number(c.mcap) > 0 && Number(c.peak_mcap) > 0 ? c.peak_mcap / c.mcap : 0; if (!x) continue; const g = G.get(c.chat_id) || { chat_id: c.chat_id, n: 0, sum: 0, hits: 0, best: 0 }; g.n++; g.sum += x; if (x >= 2) g.hits++; if (x > g.best) g.best = x; G.set(c.chat_id, g); }
  return [...G.values()].filter((g) => g.n >= 5).map((g) => Object.assign(g, { avg: g.sum / g.n })).sort((a, b) => b.avg - a.avg || b.n - a.n);
}

// ---------- views ----------
const who = (r) => (r.username ? "@" + esc(r.username) : esc(r.name || "anon"));
const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
const howTo = `<b>How to earn</b>\n• Trade in 🍸 CBL Bartender: ${P.trade} per trade (up to ${P.tradeDayCap}/day)\n• Invite a friend who trades: ${P.ref}\n• Scan a token: ${P.scan} (up to ${P.scanDayCap}/day)\n• Call a token in your group: ${P.call} · hits 2x +${P.x2} · 5x +${P.x5} · 10x +${P.x10}`;

async function me(uid) { return ((await db.select("points", `tg_id=eq.${uid}&select=*`).catch(() => [])) || [])[0] || null; }
async function top(field, n = 10) { return (await db.select("points", `${field}=gt.0&select=tg_id,username,name,total,week&order=${field}.desc&limit=${n}`).catch(() => [])) || []; }

async function pointsMsg(uid) {
  const m = await me(uid), wk = await top("week", 10);
  const L = ["⭐ <b>CBL Points</b>", ""];
  if (m) L.push(`You: <b>${m.total}</b> points · this week <b>${m.week}</b> · rank #${m.rank}`, `Trades ${m.trades} · friends ${m.refs} · scans ${m.scans} · calls ${m.calls}${m.best_x >= 2 ? " · best call " + m.best_x + "x" : ""}`);
  else L.push("You don't have points yet. Start below 👇");
  L.push("", "🏆 <b>This week</b>");
  if (wk.length) wk.forEach((r, i) => L.push(`${medal(i)} ${who(r)} · ${r.week}`)); else L.push("No points yet this week. Be first!");
  const prize = env("WEEKLY_PRIZE");
  L.push("", howTo, "", prize ? `🎁 Weekly prize: ${esc(prize)}` : "", "<i>Points update every 30 minutes. Week resets Monday 00:00 UTC.</i>");
  const kb = [[{ text: "🍸 Trade", url: `https://t.me/${bot()}?start=trade` }, { text: "🤝 Invite friends", url: `https://t.me/${bot()}?start=trade` }]];
  return { text: L.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n"), reply_markup: { inline_keyboard: kb } };
}

async function rankMsg(chatId, tg) {
  const gs = await groups(7), mine = chatId ? gs.findIndex((g) => g.chat_id === chatId) : -1;
  const L = ["🏆 <b>Top calling groups · 7 days</b>", "<i>Average peak X of calls made with CBL (groups with 5+ calls)</i>", ""];
  for (let i = 0; i < Math.min(10, gs.length); i++) {
    const g = gs[i]; let title = "Private group";
    try { const r = await tg("getChat", { chat_id: g.chat_id }); if (r && r.ok) title = r.result.username ? `<a href="https://t.me/${r.result.username}">${esc(r.result.title)}</a>` : esc(r.result.title || title); } catch (e) {}
    L.push(`${medal(i)} ${title} · <b>${g.avg.toFixed(1)}x</b> avg · ${g.n} calls · best ${g.best.toFixed(1)}x`);
  }
  if (!gs.length) L.push("No group has 5+ calls this week yet. Post tokens in your group with the bot to get ranked.");
  if (chatId) {
    const lb = await require("./calls").leaderboard(chatId, 7).catch(() => null);
    if (lb && lb.users.length) { L.push("", "👤 <b>Top callers in this group · 7 days</b>"); lb.users.slice(0, 5).forEach((u, i) => L.push(`${medal(i)} ${esc(u.who)} · <b>${u.avg.toFixed(1)}x</b> avg · ${u.n} calls · best ${u.best ? u.best.x.toFixed(1) + "x " + esc(u.best.sym || "") : "–"}`)); L.push("<i>Full board: /lb</i>"); }
  }
  if (chatId) L.push("", mine >= 0 ? `📍 This group: <b>#${mine + 1}</b> of ${gs.length} · ${gs[mine].avg.toFixed(1)}x avg · ${gs[mine].n} calls` : "📍 This group isn't ranked yet: it needs 5+ calls in 7 days.");
  return { text: L.join("\n") };
}

/** Monday post: top 10 points earners + top groups of last week. Runs from the trending cron. */
async function weekly(tg, force) {
  const chat = env("RECAP_CHANNEL") || env("TRENDING_CHANNEL"); if (!chat) return { weekly: "no channel" };
  const hour = env("WEEKLY_HOUR_UTC") !== "" && Number.isFinite(Number(env("WEEKLY_HOUR_UTC"))) ? Number(env("WEEKLY_HOUR_UTC")) : 10;
  const d = new Date(), wk = day(weekStart());
  const st = (((await db.select("radar_cache", "id=eq.weekly&select=data").catch(() => [])) || [])[0] || {}).data || {};
  if (!force && (d.getUTCDay() !== 1 || d.getUTCHours() !== hour || st.week === wk)) return { weekly: "not now" };
  // last week's points = what was "week" before Monday's reset, so read the saved snapshot taken on Sunday night
  const snap = st.snap || [];
  const gs = (await groups(7)).slice(0, 5);
  const L = ["🏆 <b>CBL WEEKLY WINNERS</b>", "", "⭐ <b>Top points</b>"];
  if (snap.length) snap.slice(0, 10).forEach((r, i) => L.push(`${medal(i)} ${who(r)} · ${r.week}`)); else L.push("Leaderboard starts this week. Earn points with /points.");
  if (gs.length) { L.push("", "📞 <b>Top calling groups</b>"); for (let i = 0; i < gs.length; i++) { let t = "Private group"; try { const r = await tg("getChat", { chat_id: gs[i].chat_id }); if (r && r.ok) t = esc(r.result.title || t); } catch (e) {} L.push(`${medal(i)} ${t} · ${gs[i].avg.toFixed(1)}x avg · ${gs[i].n} calls`); } }
  if (env("WEEKLY_PRIZE")) L.push("", `🎁 Winners get: ${esc(env("WEEKLY_PRIZE"))}. We'll DM you.`);
  L.push("", "New week, new board. /points to see how to earn.");
  const r = await tg("sendMessage", { chat_id: chat, text: L.join("\n"), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "⭐ My points", url: `https://t.me/${bot()}?start=points` }]] } });
  if (r && r.ok) await db.upsert("radar_cache", [{ id: "weekly", data: Object.assign({}, st, { week: wk }) }], "id").catch(() => {});
  return { weekly: r && r.ok ? "posted" : (r && r.description) || "failed" };
}

/** Every 30 min: recalc points; just before the Monday reset keep a snapshot of the week's board for the winners post. */
async function job(tg) {
  const st = (((await db.select("radar_cache", "id=eq.points&select=data").catch(() => [])) || [])[0] || {}).data || {};
  let out = {};
  if (Date.now() - (st.at || 0) > 30 * 60e3) {
    out = await compute();
    const d = new Date(), sundayLate = d.getUTCDay() === 0 && d.getUTCHours() >= 23;
    const patch = { at: Date.now() };
    await db.upsert("radar_cache", [{ id: "points", data: patch }], "id").catch(() => {});
    if (sundayLate) { const w = await top("week", 10); const wst = (((await db.select("radar_cache", "id=eq.weekly&select=data").catch(() => [])) || [])[0] || {}).data || {}; await db.upsert("radar_cache", [{ id: "weekly", data: Object.assign(wst, { snap: w }) }], "id").catch(() => {}); }
  }
  const w = await weekly(tg).catch((e) => ({ weeklyError: e.message }));
  return Object.assign(out, w);
}

module.exports = { P, seen, scan, compute, groups, pointsMsg, rankMsg, weekly, job };
