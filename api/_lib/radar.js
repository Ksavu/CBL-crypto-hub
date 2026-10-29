// CBL Token Radar: trending, new and boosted tokens across the scanner's chains, each with a CBL safety score.
//
// build()  — run by /api/cron?job=radar every 5 minutes: gathers candidates, refreshes market data, scores the
//            most active tokens with the Coin Sniffer engine (scores are reused for 30 minutes) and stores one
//            snapshot in Supabase (table radar_cache, row "feed").
// read()   — used by /api/scan?radar=1 and the bot's /radar: returns the snapshot with market numbers refreshed
//            from DexScreener (the API response is edge-cached for 60s, so this runs at most once a minute).
// Sources (public, no keys): DexScreener boosts / profiles / takeovers, GeckoTerminal trending and new pools.
const db = require("./db");
const { runScan, OK_CHAINS } = require("./scanner");

const GT_NET = { eth: "ethereum", bsc: "bsc", base: "base", solana: "solana", arbitrum: "arbitrum", polygon_pos: "polygon", optimism: "optimism", avax: "avalanche",
  linea: "linea", blast: "blast", zksync: "zksync", scroll: "scroll", mantle: "mantle", sonic: "sonic", unichain: "unichain", cro: "cronos" };
const SUPPORTED = new Set(OK_CHAINS);
const SCORE_TTL = 30 * 60e3, MAX_ROWS = 150, FEED_ID = "feed";

async function jget(u, ms = 7000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; CBLRadar/1.0; +https://cryptobarlounge.space)" } }); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
const key = (c, a) => c + "|" + (c === "solana" ? a : String(a).toLowerCase());

/** Candidate tokens: [{chain, ca, src}] from all sources, deduped. */
async function candidates() {
  const C = new Map();
  const add = (chain, ca, src) => {
    if (!SUPPORTED.has(chain) || !ca) return;
    const k = key(chain, ca), c = C.get(k);
    if (c) { if (!c.src.includes(src)) c.src.push(src); } else C.set(k, { chain, ca: chain === "solana" ? ca : String(ca).toLowerCase(), src: [src] });
  };
  const ds = (u, src) => jget("https://api.dexscreener.com/" + u).then((j) => (Array.isArray(j) ? j : []).forEach((x) => add(x.chainId, x.tokenAddress, src)));
  const gt = (u, src) => jget("https://api.geckoterminal.com/api/v2/" + u, 8000).then((j) => ((j && j.data) || []).forEach((p) => {
    const net = p.relationships && p.relationships.network && p.relationships.network.data && p.relationships.network.data.id;
    const bt = p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
    const chain = GT_NET[net]; if (!chain || !bt || !bt.startsWith(net + "_")) return;
    add(chain, bt.slice(net.length + 1), src);
  }));
  await Promise.all([
    ds("token-boosts/top/v1", "boosted"), ds("token-boosts/latest/v1", "boosted"), ds("token-profiles/latest/v1", "profile"), ds("community-takeovers/latest/v1", "cto"),
    gt("networks/trending_pools?page=1", "trending"), gt("networks/trending_pools?page=2", "trending"),
    gt("networks/new_pools?page=1", "new"), gt("networks/solana/new_pools?page=1", "new"), gt("networks/base/new_pools?page=1", "new"), gt("networks/bsc/new_pools?page=1", "new"),
    gt("networks/solana/trending_pools?page=1", "trending"), gt("networks/base/trending_pools?page=1", "trending"), gt("networks/bsc/trending_pools?page=1", "trending"), gt("networks/eth/trending_pools?page=1", "trending"),
  ].map((p) => p.catch(() => {})));
  return [...C.values()];
}

/** Market data for many tokens via DexScreener tokens/v1 (30 per call). Returns Map key -> row fields. */
async function market(list, deadline) {
  const out = new Map(), by = {};
  list.forEach((t) => (by[t.chain] = by[t.chain] || []).push(t));
  const jobs = [];
  for (const [chain, L] of Object.entries(by)) for (let i = 0; i < L.length; i += 30) jobs.push([chain, L.slice(i, i + 30)]);
  const run = async () => {
    while (jobs.length && (!deadline || Date.now() < deadline)) {
      const [chain, part] = jobs.shift();
      const j = await jget(`https://api.dexscreener.com/tokens/v1/${chain}/${part.map((t) => t.ca).join(",")}`, 6000);
      if (!Array.isArray(j)) continue;
      for (const t of part) {
        const low = String(t.ca).toLowerCase();
        const ps = j.filter((p) => p.chainId === chain && String(p.baseToken && p.baseToken.address).toLowerCase() === low);
        if (!ps.length) continue;
        const p = ps.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
        const tx = p.txns || {}, pc = p.priceChange || {}, v = p.volume || {};
        out.set(key(chain, t.ca), {
          sym: p.baseToken.symbol || "", name: p.baseToken.name || "", logo: (p.info && p.info.imageUrl) || null,
          price: Number(p.priceUsd) || null, mcap: p.marketCap || p.fdv || null, liq: (p.liquidity && p.liquidity.usd) || 0,
          vol24: v.h24 || 0, vol1h: v.h1 || 0, vol5m: v.m5 || 0, ch5m: pc.m5 ?? null, ch1h: pc.h1 ?? null, ch24: pc.h24 ?? null,
          buys24: (tx.h24 && tx.h24.buys) || 0, sells24: (tx.h24 && tx.h24.sells) || 0, buys1h: (tx.h1 && tx.h1.buys) || 0, sells1h: (tx.h1 && tx.h1.sells) || 0,
          created: p.pairCreatedAt || null, dex: p.dexId || "", url: p.url || null, boosts: (p.boosts && p.boosts.active) || 0,
          profile: !!(p.info && (p.info.imageUrl || (p.info.websites && p.info.websites.length) || (p.info.socials && p.info.socials.length))),
        });
      }
    }
  };
  await Promise.all([run(), run(), run(), run()]);
  return out;
}

// Momentum: 1h volume with a bonus for buy pressure and fresh activity. Used for the Trending tab and for scoring priority.
function trend(r) {
  const bs = (r.buys1h + 1) / (r.sells1h + 1), act = r.vol1h || r.vol24 / 24;
  return act * Math.min(2, Math.max(0.5, bs)) * (r.src.includes("trending") ? 1.3 : 1) * (r.boosts ? 1.1 : 1);
}

function scoreOf(s) {
  if (!s) return null;
  return { score: s.score, verdict: s.verdict, honeypot: s.flags && s.flags.honeypot, sellTax: s.flags && s.flags.sellTax, mint: s.flags && s.flags.mint, freeze: s.flags && s.flags.freeze,
    creator: s.creator || null, paid: s.dex ? s.dex.paid : null, cto: s.dex ? !!s.dex.cto : false,
    curve: s.market && s.market.curve ? (typeof s.market.curveProgress === "number" ? s.market.curveProgress : 0) : null, t: Date.now() };
}

/** Build a full snapshot (cron). budgetMs bounds the whole run. */
async function build(budgetMs = 23000) {
  const t0 = Date.now(), deadline = t0 + budgetMs;
  let prev = null;
  try { prev = db.on() ? ((await db.select("radar_cache", "id=eq." + FEED_ID + "&select=data"))[0] || {}).data : null; } catch (e) { prev = null; }
  const scores = (prev && prev.scores) || {}, seen = (prev && prev.seen) || {};
  const cands = await candidates();
  // keep tokens from the last snapshot too, so a token doesn't vanish when it drops off one source for a few minutes
  if (prev && prev.rows) for (const r of prev.rows) if (!cands.find((c) => c.chain === r.chain && c.ca === r.ca) && Date.now() - (seen[key(r.chain, r.ca)] || 0) < 3 * 3600e3) cands.push({ chain: r.chain, ca: r.ca, src: r.src.filter((s) => s !== "new") });
  const mk = await market(cands, t0 + 9000);
  let rows = [];
  for (const c of cands) {
    const m = mk.get(key(c.chain, c.ca));
    if (!m || m.liq < 1000 || m.vol24 < 1000) continue;
    const k = key(c.chain, c.ca);
    if (!seen[k]) seen[k] = Date.now();
    rows.push(Object.assign({ chain: c.chain, ca: c.ca, src: c.src, first: seen[k] }, m));
  }
  rows.forEach((r) => (r.trend = trend(r)));
  rows.sort((a, b) => b.trend - a.trend);
  rows = rows.slice(0, MAX_ROWS);
  // Score: most active first, plus everything brand new; reuse scores younger than 30 minutes.
  const todo = rows.filter((r) => { const s = scores[key(r.chain, r.ca)]; return !s || Date.now() - s.t > SCORE_TTL; })
    .sort((a, b) => (b.created && Date.now() - b.created < 6 * 3600e3 ? 1 : 0) - (a.created && Date.now() - a.created < 6 * 3600e3 ? 1 : 0) || b.trend - a.trend);
  let scored = 0;
  const work = async () => {
    while (todo.length && Date.now() < deadline - 2500) {
      const r = todo.shift();
      const s = await Promise.race([runScan(r.ca, r.chain, { noDeep: true }).catch(() => null), new Promise((z) => setTimeout(() => z(null), 7000))]);
      if (s && s.ok) { scores[key(r.chain, r.ca)] = scoreOf(s); scored++; }
    }
  };
  await Promise.all([work(), work(), work(), work(), work(), work()]);
  rows.forEach((r) => Object.assign(r, { s: scores[key(r.chain, r.ca)] || null }));
  // trim caches
  const keep = new Set(rows.map((r) => key(r.chain, r.ca)));
  for (const k of Object.keys(scores)) if (!keep.has(k) && Date.now() - scores[k].t > 6 * 3600e3) delete scores[k];
  for (const k of Object.keys(seen)) if (!keep.has(k) && Date.now() - seen[k] > 24 * 3600e3) delete seen[k];
  const snap = { t: Date.now(), rows, scores, seen };
  if (db.on()) await db.upsert("radar_cache", [{ id: FEED_ID, data: snap, updated_at: new Date().toISOString() }], "id").catch(() => {});
  return { snap, stats: { candidates: cands.length, rows: rows.length, scored, withScore: rows.filter((r) => r.s).length, ms: Date.now() - t0 } };
}

/** Snapshot for the page and bot, with fresh market numbers. */
async function read(opts = {}) {
  let snap = null;
  try { snap = db.on() ? ((await db.select("radar_cache", "id=eq." + FEED_ID + "&select=data"))[0] || {}).data : null; } catch (e) { snap = null; }
  if (!snap || !snap.rows || Date.now() - snap.t > 30 * 60e3) {
    // No (recent) cron snapshot: build a quick one now without saving scores for long.
    snap = (await build(opts.budget || 16000)).snap;
  } else if (opts.refresh !== false) {
    const mk = await market(snap.rows, Date.now() + 6000);
    for (const r of snap.rows) { const m = mk.get(key(r.chain, r.ca)); if (m) Object.assign(r, m, { trend: trend(Object.assign({}, r, m)) }); }
  }
  return { ok: true, t: snap.t, now: Date.now(), rows: snap.rows };
}

module.exports = { build, read, candidates, market, trend, GT_NET };
