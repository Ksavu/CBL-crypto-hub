// First calls (like Phanes): in groups, the first person to post a token's contract address "called" it.
// We store who, when and the market cap at that moment, then track the peak market cap so the group gets
// X alerts (2x, 3x, 5x, 10x...) and caller leaderboards.
//   record()      — from the bot whenever a token is scanned in a group
//   trackJob()    — /api/cron?job=calls every 5 minutes: refresh market caps, update peaks, send X alerts
//   leaderboard() / userCalls() — /lb and /calls
const db = require("./db");

const TRACK_DAYS = 14, MILESTONES = [2, 3, 5, 10, 20, 50, 100, 250, 500, 1000];
const norm = (ca) => (/^(0x|terra1)/i.test(ca) ? String(ca).toLowerCase() : String(ca));
const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
const DS_CHAIN = { ethereum: "ethereum", bsc: "bsc", base: "base", arbitrum: "arbitrum", polygon: "polygon", optimism: "optimism", avalanche: "avalanche", linea: "linea",
  blast: "blast", zksync: "zksync", scroll: "scroll", mantle: "mantle", sonic: "sonic", unichain: "unichain", cronos: "cronos", robinhood: "robinhood", solana: "solana" };

/** Save the first call of a token in a group (no-op if someone called it before). Returns the first call row. */
async function record(chat, user, r, msgId) {
  if (!db.on() || !r || !r.address || chat.type === "private") return null;
  const address = norm(r.address), key = `chat_id=eq.${chat.id}&address=eq.${db.enc(address)}`;
  const prev = (await db.select("calls", key + "&select=*&limit=1"))[0];
  if (prev) return Object.assign(prev, { isNew: false });
  const mcap = r.market ? num(r.market.marketCap) || num(r.market.fdv) : null;
  const row = {
    chat_id: chat.id, address, chain: r.chain, sym: (r.token && r.token.symbol) || "", user_id: user.id,
    username: user.username || null, name: [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 40) || null,
    mcap, peak_mcap: mcap, last_mcap: mcap, peak_at: new Date().toISOString(), alerted_x: 1, msg_id: msgId || null,
  };
  await db.insert("calls", [row], "chat_id,address");
  const saved = (await db.select("calls", key + "&select=*&limit=1"))[0] || row; // a parallel post may have won the race
  return Object.assign(saved, { isNew: saved.user_id === user.id && !prev });
}

const who = (c) => (c.username ? "@" + c.username : c.name || "anon");
const xOf = (c, m) => (num(c.mcap) && num(m) ? m / c.mcap : null);

/** Leaderboard for a group over `days` (0 = all time). Ranks callers by average peak X. */
async function leaderboard(chatId, days) {
  const since = days ? `&created_at=gte.${new Date(Date.now() - days * 864e5).toISOString()}` : "";
  const rows = (await db.select("calls", `chat_id=eq.${chatId}${since}&select=user_id,username,name,sym,address,chain,mcap,peak_mcap,last_mcap,created_at&order=created_at.desc&limit=2000`)) || [];
  const U = new Map();
  for (const c of rows) {
    const x = xOf(c, c.peak_mcap); if (!x) continue;
    const u = U.get(c.user_id) || { user_id: c.user_id, who: who(c), n: 0, sum: 0, hits: 0, best: null };
    u.n++; u.sum += x; if (x >= 2) u.hits++;
    if (!u.best || x > u.best.x) u.best = { x, sym: c.sym, address: c.address, chain: c.chain };
    U.set(c.user_id, u);
  }
  const users = [...U.values()].map((u) => Object.assign(u, { avg: u.sum / u.n, hit: u.hits / u.n })).sort((a, b) => b.avg - a.avg || b.n - a.n);
  const top = rows.map((c) => Object.assign({}, c, { x: xOf(c, c.peak_mcap), who: who(c) })).filter((c) => c.x).sort((a, b) => b.x - a.x).slice(0, 5);
  return { users, top, total: rows.length };
}

async function userCalls(chatId, userId) {
  return ((await db.select("calls", `chat_id=eq.${chatId}&user_id=eq.${userId}&select=*&order=created_at.desc&limit=15`)) || [])
    .map((c) => Object.assign(c, { x: xOf(c, c.peak_mcap), now: xOf(c, c.last_mcap) }));
}

async function settings(chatId) {
  try { return (await db.select("group_settings", `chat_id=eq.${chatId}&select=*`))[0] || { chat_id: chatId, x_alerts: true }; } catch (e) { return { chat_id: chatId, x_alerts: true }; }
}
const setAlerts = (chatId, on) => db.upsert("group_settings", [{ chat_id: chatId, x_alerts: !!on }], "chat_id");

async function jget(u, ms = 6000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json" } }); return r.ok ? await r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); }
}

/** Cron: refresh market caps of recent calls, update peaks, return X alerts to send. */
async function trackJob(deadline) {
  const since = new Date(Date.now() - TRACK_DAYS * 864e5).toISOString();
  const rows = (await db.select("calls", `created_at=gte.${since}&mcap=gt.0&select=*&order=checked_at.asc.nullsfirst&limit=300`)) || [];
  const by = {};
  rows.forEach((c) => { if (DS_CHAIN[c.chain]) (by[c.chain] = by[c.chain] || new Map()).set(c.address, null); });
  const jobs = [];
  for (const [chain, m] of Object.entries(by)) { const a = [...m.keys()]; for (let i = 0; i < a.length; i += 30) jobs.push([chain, a.slice(i, i + 30)]); }
  const mc = {};
  const run = async () => {
    while (jobs.length && Date.now() < deadline - 3000) {
      const [chain, part] = jobs.shift();
      const j = await jget(`https://api.dexscreener.com/tokens/v1/${DS_CHAIN[chain]}/${part.join(",")}`);
      if (!Array.isArray(j)) continue;
      for (const a of part) {
        const ps = j.filter((p) => String(p.baseToken && p.baseToken.address).toLowerCase() === a.toLowerCase())
          .sort((x, y) => ((y.liquidity && y.liquidity.usd) || 0) - ((x.liquidity && x.liquidity.usd) || 0));
        if (ps[0]) mc[chain + "|" + a] = { m: num(ps[0].marketCap) || num(ps[0].fdv), url: ps[0].url, sym: ps[0].baseToken.symbol };
      }
    }
  };
  await Promise.all([run(), run(), run()]);
  const alerts = [], now = new Date().toISOString();
  let updated = 0;
  for (const c of rows) {
    const d = mc[c.chain + "|" + c.address];
    if (!d || !d.m) { if (Date.now() < deadline - 1500) await db.patch("calls", `chat_id=eq.${c.chat_id}&address=eq.${db.enc(c.address)}`, { checked_at: now }).catch(() => {}); continue; }
    const peak = Math.max(num(c.peak_mcap) || 0, d.m), x = d.m / c.mcap;
    const hit = MILESTONES.filter((k) => x >= k && k > (Number(c.alerted_x) || 1)).pop();
    const patch = { last_mcap: d.m, checked_at: now };
    if (peak > (num(c.peak_mcap) || 0)) Object.assign(patch, { peak_mcap: peak, peak_at: now });
    if (hit) { patch.alerted_x = hit; alerts.push({ call: Object.assign({}, c, { sym: c.sym || d.sym }), x, hit, mcap: d.m, url: d.url }); }
    if (Date.now() < deadline - 1500) { await db.patch("calls", `chat_id=eq.${c.chat_id}&address=eq.${db.enc(c.address)}`, patch).catch(() => {}); updated++; }
  }
  return { checked: rows.length, updated, alerts };
}

module.exports = { record, leaderboard, userCalls, settings, setAlerts, trackJob, who, xOf, MILESTONES };
