// Bonding-curve feed for the Token Radar: tokens still on a launchpad curve (pre-graduation), so people can find
// them early. Built by /api/cron?job=curves every 5 minutes, stored in radar_cache row "curve".
// Sources (public, no keys):
//   Pump.fun        frontend-api-v3 coin lists (live trades, market cap, king of the hill) — unofficial, best effort
//   GeckoTerminal   per-DEX pool lists for launchpad curve DEXes (Moonshot, LaunchLab/LetsBonk, Meteora DBC, Boop,
//                   Four.meme...). DEX ids are discovered once a day from GeckoTerminal's DEX list, so new ones appear.
//   Robinhood Chain Pons / Hood.fun / RobinFun factory launch events via the Robinhood Blockscout explorer
const db = require("./db");
const { runScan } = require("./scanner");

const ROW_ID = "curve", MAX = 150, SCORE_TTL = 20 * 60e3, DISCOVER_TTL = 24 * 3600e3;
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const GT = "https://api.geckoterminal.com/api/v2";
// Launchpad curve DEXes on GeckoTerminal (matched against discovered ids; graduated venues like pumpswap are excluded).
const GT_NETS = { solana: "solana", bsc: "bsc", base: "base" };
const CURVE_DEX = /pump-?fun|moonshot|launch-?lab|bonk|boop|believe|dbc|heaven|four-?meme|flap|virtuals|pons|hood|robin|klik|printr/i, NOT_CURVE = /pumpswap|amm|cpmm|clmm|dlmm|v2|v3|v4/i;
const PAD_NAME = (id) => /pons/i.test(id) ? ["Pons", "pons"] : /hood/i.test(id) ? ["Hood.fun", "hood"] : /robin/i.test(id) ? ["RobinFun", "robin"] : /pump/i.test(id) ? ["Pump.fun", "pump"] : /moonshot/i.test(id) ? ["Moonshot", "moon"] : /bonk|launch-?lab/i.test(id) ? ["LetsBonk", "bonk"]
  : /dbc|believe/i.test(id) ? ["Meteora DBC", "dbc"] : /boop/i.test(id) ? ["Boop", "boop"] : /four/i.test(id) ? ["Four.meme", "four"] : /flap/i.test(id) ? ["Flap", "flap"]
  : /virtual/i.test(id) ? ["Virtuals", "virt"] : /zora/i.test(id) ? ["Zora", "zora"] : /clanker/i.test(id) ? ["Clanker", "clanker"] : [id, "x"];
const RH_FACTORIES = [
  { n: "Pons", k: "pons", a: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e" },
  { n: "Hood.fun", k: "hood", a: "0x5fcc1df0dc020cf454e742e9a8ae2554c37a452c" },
  { n: "RobinFun", k: "robin", a: "0xd861cb5dc71a0171e8f0f6586cadb069f3a35e4d" },
];

const DIAG = {};
async function jget(u, ms = 7000, headers) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms), host = u.split("/")[2];
  try {
    const r = await fetch(u, { signal: c.signal, headers: Object.assign({ accept: "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }, headers || {}) });
    const d = DIAG[host] || (DIAG[host] = { ok: 0, fail: 0 });
    if (!r.ok) { d.fail++; d.last = "HTTP " + r.status; return null; }
    d.ok++; return await r.json();
  } catch (e) { const d = DIAG[host] || (DIAG[host] = { ok: 0, fail: 0 }); d.fail++; d.last = String((e && e.name) || e).slice(0, 30); return null; } finally { clearTimeout(t); }
}
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const now = () => Date.now();

// ---------- Pump.fun ----------
const pumpProgress = (c) => (num(c.virtual_token_reserves) != null ? Math.max(0, Math.min(100, (1 - (c.virtual_token_reserves / 1e6 - 279.9e6) / 793.1e6) * 100)) : null);
function pumpRow(c, tag) {
  return { chain: "solana", ca: c.mint, sym: c.symbol || "", name: c.name || "", logo: c.image_uri || null, lp: { n: "Pump.fun", k: "pump", g: false },
    progress: pumpProgress(c), mcap: num(c.usd_market_cap), created: num(c.created_timestamp), lastTrade: num(c.last_trade_timestamp), replies: num(c.reply_count) || 0,
    koth: !!c.king_of_the_hill_timestamp || tag === "koth", url: "https://pump.fun/coin/" + c.mint, src: "pump.fun" };
}
async function pump() {
  const list = (j) => (Array.isArray(j) ? j : (j && (j.coins || j.data)) || []);
  const H = { origin: "https://pump.fun", referer: "https://pump.fun/" }; // pump.fun's API refuses requests without its own origin
  const base = "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&includeNsfw=false&order=DESC&sort=";
  const [live, cap, koth, cur] = await Promise.all([jget(base + "last_trade_timestamp", 7000, H), jget(base + "market_cap", 7000, H),
    jget("https://frontend-api-v3.pump.fun/coins/king-of-the-hill?includeNsfw=false", 7000, H), jget("https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=50&includeNsfw=false", 7000, H)]);
  const out = new Map();
  for (const c of [...list(live), ...list(cap), ...list(cur)]) if (c && c.mint && !c.complete) out.set(c.mint, pumpRow(c));
  if (koth && koth.mint && !koth.complete) out.set(koth.mint, pumpRow(koth, "koth"));
  return [...out.values()];
}

// ---------- GeckoTerminal launchpad DEXes ----------
// Likely GeckoTerminal ids, used until discovery succeeds (wrong guesses just return nothing).
const GUESS = { solana: ["pump-fun", "moonshot", "raydium-launchlab", "meteora-dbc"], bsc: ["four-meme"], base: [] };
async function discover(prev, rhId) {
  if (rhId) GT_NETS[rhId] = "robinhood";
  if (prev && prev.t && now() - prev.t < DISCOVER_TTL && prev.ids && Object.values(prev.ids).some((l) => l.length)) return prev;
  const ids = {};
  await Promise.all(Object.keys(GT_NETS).map(async (net) => {
    const found = [];
    for (let p = 1; p <= 2; p++) {
      const j = await jget(`${GT}/networks/${net}/dexes?page=${p}`, 6000);
      const d = (j && j.data) || []; if (!d.length) break;
      d.forEach((x) => { const id = x.id || ""; if (CURVE_DEX.test(id) && !NOT_CURVE.test(id)) found.push(id); });
    }
    ids[net] = found.slice(0, 6);
  }));
  const ok = Object.values(ids).some((l) => l.length);
  return ok ? { t: now(), ids } : { t: 0, ids: GUESS }; // t:0 = try discovery again next run
}
async function gtCurves(ids, budget, withPump) {
  const rows = [], jobs = [];
  for (const [net, list] of Object.entries(ids || {})) for (const dex of list) if (withPump || !/pump/i.test(dex)) jobs.push([net, dex]); // pump.fun normally comes from its own API
  jobs.sort((a, b) => (/pump/i.test(b[1]) ? 1 : 0) - (/pump/i.test(a[1]) ? 1 : 0));
  for (const [net, dex] of jobs.slice(0, 7)) {
    if (now() > budget) break;
    const j = await jget(`${GT}/networks/${net}/dexes/${dex}/pools?page=1&sort=h24_tx_count_desc&include=base_token`, 6000);
    const toks = new Map(((j && j.included) || []).map((t) => [t.id, t.attributes || {}]));
    for (const p of (j && j.data) || []) {
      const a = p.attributes || {}, bt = p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
      if (!bt) continue;
      const ca = bt.slice(net.length + 1), t = toks.get(bt) || {}, [n, k] = PAD_NAME(dex), tx = (a.transactions && a.transactions.h1) || {};
      rows.push({ chain: GT_NETS[net], ca, sym: t.symbol || String(a.name || "").split(" / ")[0], name: t.name || "", logo: t.image_url && !/missing/.test(t.image_url) ? t.image_url : null,
        lp: { n, k, g: false }, progress: null, mcap: num(a.market_cap_usd) || num(a.fdv_usd), vol1h: num(a.volume_usd && a.volume_usd.h1) || 0, vol24: num(a.volume_usd && a.volume_usd.h24) || 0,
        tx1h: (tx.buys || 0) + (tx.sells || 0), buys1h: tx.buys || 0, created: a.pool_created_at ? Date.parse(a.pool_created_at) : null, ch1h: num(a.price_change_percentage && a.price_change_percentage.h1),
        url: `https://www.geckoterminal.com/${net}/pools/${a.address}`, src: "geckoterminal:" + dex });
    }
  }
  return rows;
}

// ---------- Robinhood Chain launchpads (factory launch events) ----------
function tokenFromLog(l) {
  const ps = (l.decoded && l.decoded.parameters) || [];
  const p = ps.find((x) => /^(token|memecoin|tokenAddress)$/i.test(x.name)) || ps.find((x) => /address/.test(x.type) && /token/i.test(x.name));
  return p && /^0x[a-fA-F0-9]{40}$/.test(p.value) ? p.value.toLowerCase() : null;
}
// Undecoded log (contract not verified on the explorer): every address-shaped word is a candidate; the caller keeps the ERC-20 ones.
function addrsFromLog(l) {
  const words = [...(l.topics || []).slice(1).filter(Boolean), ...((String(l.data || "").replace(/^0x/, "").match(/.{64}/g) || []).map((w) => "0x" + w))];
  return [...new Set(words.filter((w) => /^0x0{24}[0-9a-f]{40}$/i.test(w) && !/^0x0{64}$/.test(w)).map((w) => "0x" + w.slice(-40).toLowerCase()))];
}
// Straight from the chain (works even when the explorer is slow or can't decode the events):
// recent logs of each launchpad contract; every address in them is a candidate token, kept if it answers symbol().
// For Hood.fun / RobinFun the same contract also logs trades, so the log count per token doubles as activity.
const RH_RPC = "https://rpc.mainnet.chain.robinhood.com", PONS_LAUNCH = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
async function rpc(body, ms = 6000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(RH_RPC, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = DIAG["rpc.robinhood"] || (DIAG["rpc.robinhood"] = { ok: 0, fail: 0 }); if (!r.ok) { d.fail++; d.last = "HTTP " + r.status; return null; } d.ok++; return await r.json(); }
  catch (e) { const d = DIAG["rpc.robinhood"] || (DIAG["rpc.robinhood"] = { ok: 0, fail: 0 }); d.fail++; d.last = String((e && e.name) || e).slice(0, 30); return null; } finally { clearTimeout(t); }
}
const hexStr = (h) => { try { const b = Buffer.from(String(h || "").replace(/^0x/, ""), "hex"); if (b.length < 64) return b.toString("utf8").replace(/\0/g, "").trim(); const len = parseInt(b.slice(32, 64).toString("hex"), 16); return b.slice(64, 64 + len).toString("utf8").replace(/\0/g, "").trim(); } catch (e) { return ""; } };
async function rhFromChain(budget) {
  const head = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  const latest = head && head.result ? parseInt(head.result, 16) : 0;
  if (!latest) return [];
  const found = new Map(); // address -> { f, n }
  for (const f of RH_FACTORIES) {
    for (let k = 0; k < 4 && now() < budget; k++) { // 4 x 10k blocks (Robinhood Chain makes several blocks a second)
      const to = latest - k * 10000, from = Math.max(0, to - 9999);
      const r = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: f.a, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), ...(f.k === "pons" ? { topics: [PONS_LAUNCH] } : {}) }] });
      for (const l of (r && r.result) || []) for (const a of addrsFromLog(l)) {
        if (RH_FACTORIES.some((x) => x.a === a)) continue;
        const e = found.get(a) || { f, n: 0, block: parseInt(l.blockNumber, 16) }; e.n++; found.set(a, e);
      }
      if ([...found.values()].filter((x) => x.f === f).length >= 30) break;
    }
  }
  const cands = [...found.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 60);
  if (!cands.length) return [];
  const batch = [];
  cands.forEach(([a], i) => { batch.push({ jsonrpc: "2.0", id: i * 2, method: "eth_call", params: [{ to: a, data: "0x95d89b41" }, "latest"] }, { jsonrpc: "2.0", id: i * 2 + 1, method: "eth_call", params: [{ to: a, data: "0x06fdde03" }, "latest"] }); });
  const res = await rpc(batch, 8000);
  const by = new Map((Array.isArray(res) ? res : []).map((x) => [x.id, x]));
  const rows = [];
  cands.forEach(([a, e], i) => {
    const sym = by.get(i * 2), nm = by.get(i * 2 + 1);
    if (!sym || sym.error || !sym.result || sym.result === "0x") return; // not a token (curve, pair, user wallet...)
    const s = hexStr(sym.result); if (!s || s.length > 20) return;
    rows.push({ chain: "robinhood", ca: a, sym: s, name: nm && !nm.error ? hexStr(nm.result) : "", logo: null, lp: { n: e.f.n, k: e.f.k, g: false }, progress: null,
      mcap: null, tx1h: e.f.k === "pons" ? 0 : e.n, holders: 0, created: null, block: e.block, url: `https://robinhoodchain.blockscout.com/token/${a}`, src: "rpc" });
  });
  return rows;
}

async function robinhood(budget) {
  const rows = [];
  for (const f of RH_FACTORIES) {
    if (now() > budget) break;
    const j = await jget(`${BS}/addresses/${f.a}/logs`, 6000);
    const toks = [];
    for (const l of (j && j.items) || []) {
      if (l.decoded && !/launch|created/i.test(l.decoded.method_call || "")) continue;
      const ts = l.timestamp ? Date.parse(l.timestamp) : null, t = tokenFromLog(l);
      const cands = t ? [t] : addrsFromLog(l).filter((a) => !RH_FACTORIES.some((f) => f.a === a));
      for (const c of cands) if (!toks.find((x) => x.t === c)) toks.push({ t: c, ts, guess: !t });
    }
    await Promise.all(toks.slice(0, 16).map(async (x) => {
      const [tk, ctr] = await Promise.all([jget(`${BS}/tokens/${x.t}`, 4000), jget(`${BS}/tokens/${x.t}/counters`, 4000)]);
      if (!tk || (tk.type && !/ERC-20/i.test(tk.type))) return; // undecoded-log guesses that aren't tokens drop out here
      rows.push({ chain: "robinhood", ca: x.t, sym: tk.symbol || "", name: tk.name || "", logo: tk.icon_url || null, lp: { n: f.n, k: f.k, g: false }, progress: null,
        mcap: num(tk.circulating_market_cap) || null, holders: num(tk.holders_count || tk.holders) || 0, transfers: num(ctr && ctr.transfers_count) || 0,
        created: x.ts, url: `https://robinhoodchain.blockscout.com/token/${x.t}`, src: "blockscout" });
    }));
  }
  // Merge with what the chain itself says (fills gaps when the explorer returns nothing or can't decode).
  const chain = await rhFromChain(budget + 4000).catch(() => []);
  for (const r of chain) { const have = rows.find((x) => x.ca === r.ca); if (have) { have.tx1h = have.tx1h || r.tx1h; } else rows.push(r); }
  return rows;
}

// Heat: how much is happening right now. Used for the "Hot" sort.
function heat(r) {
  const age = r.created ? (now() - r.created) / 60000 : 1e4, fresh = r.lastTrade ? Math.max(0, 30 - (now() - r.lastTrade) / 60000) : 0;
  return (r.vol1h || 0) + (r.tx1h || 0) * 25 + (r.mcap || 0) * 0.05 + fresh * 300 + (r.replies || 0) * 15 + (r.holders || 0) * 20 + (r.transfers || 0) * 2 + (r.koth ? 5000 : 0) + (age < 60 ? 1500 : 0);
}

async function build(budgetMs = 23000) {
  const t0 = now(), deadline = t0 + budgetMs;
  let prev = null;
  try { prev = db.on() ? ((await db.select("radar_cache", "id=eq." + ROW_ID + "&select=data"))[0] || {}).data : null; } catch (e) { prev = null; }
  for (const k of Object.keys(DIAG)) delete DIAG[k];
  let rhId = null;
  try { const rs = db.on() ? ((await db.select("radar_cache", "id=eq.feed&select=data"))[0] || {}).data : null; rhId = rs && rs.rhNet && rs.rhNet.id; } catch (e) { rhId = null; }
  const [p, disc, rh] = await Promise.all([pump().catch(() => []), discover(prev && prev.disc && (!rhId || (prev.disc.ids && rhId in prev.disc.ids)) ? prev.disc : null, rhId).catch(() => ({ t: 0, ids: GUESS })), robinhood(t0 + 14000).catch(() => [])]);
  const g = await gtCurves(disc && disc.ids, t0 + 15000, !p.length).catch(() => []); // no Pump.fun API? take Pump.fun pools from GeckoTerminal
  // Tokens on the main Radar that still trade on a launchpad curve (DexScreener lists many pump.fun / moonshot curves).
  let fromRadar = [];
  try {
    const rs = db.on() ? ((await db.select("radar_cache", "id=eq.feed&select=data"))[0] || {}).data : null;
    fromRadar = ((rs && rs.rows) || []).filter((r) => r.lp && r.lp.g === false).map((r) => ({ chain: r.chain, ca: r.ca, sym: r.sym, name: r.name, logo: r.logo, lp: r.lp, progress: r.s && r.s.curve != null ? r.s.curve : null,
      mcap: r.mcap, vol1h: r.vol1h, vol24: r.vol24, tx1h: (r.buys1h || 0) + (r.sells1h || 0), created: r.created, ch1h: r.ch1h, url: r.url, src: "radar", s: r.s }));
  } catch (e) { fromRadar = []; }
  const seen = new Map();
  for (const r of [...p, ...g, ...rh, ...fromRadar]) { const k = r.chain + "|" + r.ca; if (!seen.has(k)) seen.set(k, r); }
  let rows = [...seen.values()];
  rows.forEach((r) => (r.heat = heat(r)));
  rows.sort((a, b) => b.heat - a.heat);
  // Every launchpad keeps its 15 hottest, so busy ones (Pump.fun) can't push smaller ones (Pons, Hood.fun...) off the list.
  const per = {}, keepSet = new Set();
  rows.forEach((r) => { const k = (r.lp && r.lp.n) || r.chain; per[k] = (per[k] || 0) + 1; if (per[k] <= 15) keepSet.add(r); });
  rows = rows.filter((r) => keepSet.has(r)).concat(rows.filter((r) => !keepSet.has(r))).slice(0, MAX).sort((a, b) => b.heat - a.heat);
  // CBL score for the hottest ones (scores reused for 20 minutes)
  const scores = (prev && prev.scores) || {};
  const todo = rows.filter((r) => { const s = scores[r.chain + "|" + r.ca]; return !s || now() - s.t > SCORE_TTL; }).slice(0, 40);
  const work = async () => {
    while (todo.length && now() < deadline - 2500) {
      const r = todo.shift();
      const s = await Promise.race([runScan(r.ca, r.chain, { noDeep: true }).catch(() => null), new Promise((z) => setTimeout(() => z(null), 6000))]);
      if (s && s.ok) scores[r.chain + "|" + r.ca] = { score: s.score, verdict: s.verdict, honeypot: s.flags && s.flags.honeypot, mint: s.flags && s.flags.mint, freeze: s.flags && s.flags.freeze,
        creator: s.creator || null, t: now(), progress: s.market && typeof s.market.curveProgress === "number" ? s.market.curveProgress : null };
    }
  };
  await Promise.all([work(), work(), work(), work(), work()]);
  rows.forEach((r) => { const s = scores[r.chain + "|" + r.ca]; r.s = s || r.s || null; if (r.progress == null && s && s.progress != null) r.progress = s.progress; });
  const keep = new Set(rows.map((r) => r.chain + "|" + r.ca));
  for (const k of Object.keys(scores)) if (!keep.has(k) && now() - scores[k].t > 6 * 3600e3) delete scores[k];
  const snap = { t: now(), rows, scores, disc };
  if (db.on()) await db.upsert("radar_cache", [{ id: ROW_ID, data: snap, updated_at: new Date().toISOString() }], "id").catch(() => {});
  return { snap, stats: { pump: p.length, gecko: g.length, robinhood: rh.length, radar: fromRadar.length, rows: rows.length, scored: rows.filter((r) => r.s).length, dexes: disc && disc.ids, sources: Object.assign({}, DIAG), ms: now() - t0 } };
}

/** For the page and bot: the snapshot, with the Pump.fun live list refreshed (it moves fastest). */
async function read(opts = {}) {
  let snap = null;
  try { snap = db.on() ? ((await db.select("radar_cache", "id=eq." + ROW_ID + "&select=data"))[0] || {}).data : null; } catch (e) { snap = null; }
  if (!snap || !snap.rows || now() - snap.t > 30 * 60e3 || (!snap.rows.length && now() - snap.t > 120e3)) snap = (await build(opts.budget || 12000)).snap;
  else if (opts.refresh !== false) {
    const live = await pump().catch(() => []);
    const by = new Map(snap.rows.map((r) => [r.chain + "|" + r.ca, r]));
    for (const r of live) { const old = by.get("solana|" + r.ca); if (old) Object.assign(old, r, { s: old.s }); else { r.s = (snap.scores || {})["solana|" + r.ca] || null; snap.rows.push(r); } }
    snap.rows = snap.rows.filter((r) => !(r.lp && r.lp.k === "pump") || live.find((x) => x.ca === r.ca) || now() - snap.t < 10 * 60e3); // drop pump tokens that graduated meanwhile
    snap.rows.forEach((r) => (r.heat = heat(r)));
  }
  return { t: snap.t, rows: snap.rows };
}

module.exports = { build, read, pump, gtCurves, robinhood, discover, heat, pumpProgress, tokenFromLog };
