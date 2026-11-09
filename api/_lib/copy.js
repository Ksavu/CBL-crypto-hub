// Copy trading for the CBL Bartender: follow a wallet; when it buys, buy the same token with your fixed amount;
// when it sells, sell the same share of your position.
//   Solana: instant through a Helius webhook (POST /api/cron?job=copyhook), plus a 5-minute backup check.
//   BNB / Base / Robinhood: checked every 5 minutes by the cron (job=orders).
// Tables: bot_copy, bot_copy_log (copy.sql). Every trade is logged once per follower (unique tg_id+hash+token), so the
// webhook and the backup check never double-buy.
const db = require("./db");
const T = require("./trade");
const W = require("./wallets");
const X = T._;

const MAX_TARGETS = 5, MAX_AGE = 600; // skip trades older than 10 minutes (late copies are bad copies)
const env = (k) => X.clean(process.env[k]);
const SITE = () => (env("SITE_URL") || "https://cryptobarlounge.space").replace(/\/$/, "");
const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
const norm = (chain, a) => (chain === "solana" ? a : a.toLowerCase());

// ---------- follower settings ----------
const list = (uid) => db.select("bot_copy", `tg_id=eq.${uid}&select=*&order=id.asc`).then((r) => r || []);
async function add(uid, target, amount, chainWord, label) {
  target = String(target || "").trim();
  let chain;
  if (isSol(target)) chain = "solana";
  else if (isEvm(target)) { chain = { bsc: "bsc", bnb: "bsc", base: "base", robinhood: "robinhood", rh: "robinhood", hood: "robinhood" }[String(chainWord || "").toLowerCase()]; if (!chain) X.fail("For a 0x wallet add the chain: bnb, base or robinhood. Example: 0xabc… 0.01 base"); }
  else X.fail("That's not a wallet address.");
  const c = T.CODE[chain];
  if (!(await T.getRow(uid))) X.fail("Open /trade first to create your wallet.");
  const amt = String(amount || "").trim(); if (!/^\d*\.?\d+$/.test(amt) || !(Number(amt) > 0)) X.fail(`Add the ${T.CH[c].nat} amount per copy, e.g. ${target.slice(0, 6)}… 0.1`);
  const mine = await list(uid);
  if (mine.length >= MAX_TARGETS) X.fail(`You can follow up to ${MAX_TARGETS} wallets. Remove one first.`);
  const me = await T.getRow(uid); if (norm(chain, target) === (chain === "solana" ? me.sol_pub : me.evm_addr)) X.fail("That's your own wallet.");
  if (mine.some((m) => m.chain === chain && m.target === norm(chain, target))) X.fail("You already follow this wallet.");
  await db.insert("bot_copy", [{ tg_id: uid, chain, target: norm(chain, target), label: String(label || "").slice(0, 20) || null, amount: amt, sells: true, safe: true, max_day: 20, active: true }]);
  await setCursor(chain, norm(chain, target), { ts: Math.floor(Date.now() / 1000), h: [] });
  if (chain === "solana") await syncHook().catch((e) => console.error("copy hook", e.message));
  return { chain, c, target: norm(chain, target), amount: amt };
}
const own = (uid, id) => `tg_id=eq.${uid}&id=eq.${Number(id)}`;
async function update(uid, id, patch) { await db.patch("bot_copy", own(uid, id), patch); if ("active" in patch) await syncHook().catch(() => {}); }
async function remove(uid, id) { await db.del("bot_copy", own(uid, id)); await syncHook().catch(() => {}); }

// ---------- cursors (one per watched wallet, shared by all followers) ----------
async function getCursor(chain, t) { try { return ((await db.select("radar_cache", `id=eq.${encodeURIComponent("copycur:" + chain + ":" + t)}&select=data`))[0] || {}).data || null; } catch (e) { return null; } }
const setCursor = (chain, t, cur) => db.upsert("radar_cache", [{ id: "copycur:" + chain + ":" + t, data: cur }], "id").catch(() => {});

// ---------- Helius webhook (Solana, instant) ----------
const hookUrl = () => SITE() + "/api/cron?job=copyhook";
async function syncHook() {
  const key = env("HELIUS_API_KEY"), secret = env("CRON_SECRET"); if (!key || !secret) return { skipped: "HELIUS_API_KEY / CRON_SECRET missing" };
  const rows = (await db.select("bot_copy", "chain=eq.solana&active=eq.true&select=target")) || [];
  const addrs = [...new Set(rows.map((r) => r.target))];
  const base = "https://api.helius.xyz/v0/webhooks", q = "?api-key=" + key;
  const all = await X.jfetch(base + q, {}, 8000);
  const mine = all.ok && Array.isArray(all.d) ? all.d.find((w) => w.webhookURL === hookUrl()) : null;
  const body = { webhookURL: hookUrl(), transactionTypes: ["ANY"], accountAddresses: addrs.length ? addrs : ["11111111111111111111111111111111"], webhookType: "enhanced", authHeader: "Bearer " + secret };
  const r = mine ? await X.jfetch(`${base}/${mine.webhookID}${q}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 8000)
    : await X.jfetch(base + q, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 8000);
  return { ok: r.ok, addresses: addrs.length, id: r.d && r.d.webhookID };
}

// ---------- copying ----------
async function claimTrade(uid, target, hash, side, token) { // true the first time only
  try { const r = await db.insertNew("bot_copy_log", [{ tg_id: uid, target, hash, side, token }], "tg_id,hash,token"); return Array.isArray(r) && r.length > 0; } catch (e) { return false; }
}
const logNote = (uid, hash, token, ok, note) => db.patch("bot_copy_log", `tg_id=eq.${uid}&hash=eq.${encodeURIComponent(hash)}&token=eq.${encodeURIComponent(token)}`, { ok, note: String(note || "").slice(0, 200) }).catch(() => {});
async function buysToday(uid) { const since = new Date(Date.now() - 864e5).toISOString(); const r = await db.select("bot_copy_log", `tg_id=eq.${uid}&side=eq.buy&ok=eq.true&created_at=gte.${since}&select=id`).catch(() => []); return (r || []).length; }

async function safeEnough(ca, chain) {
  try {
    const { runScan } = require("./scanner");
    const r = await Promise.race([runScan(ca, chain, { noDeep: true }), new Promise((ok) => setTimeout(() => ok(null), 7000))]);
    if (!r) return { ok: true, why: "scan timed out" };
    if (r.honeypot || (r.flags && r.flags.honeypot)) return { ok: false, why: "honeypot" };
    return r.score >= 50 ? { ok: true, score: r.score } : { ok: false, why: `CBL score ${r.score}/100` };
  } catch (e) { return { ok: true, why: "scan failed" }; }
}

/** How much of its position the watched wallet just sold (0–100). */
async function soldPct(chain, target, ca, amt) {
  try {
    let rem = 0;
    if (chain === "solana") { const t = (await X.solTokens(target, ca))[0]; rem = t ? Number(t.raw) / 10 ** t.dec : 0; }
    else { const b = await X.evmTokenBal(T.CODE[chain], ca, target); rem = Number(b.raw) / 10 ** b.dec; }
    return Math.min(100, Math.max(1, Math.round(amt / (amt + rem) * 100)));
  } catch (e) { return 100; }
}

/** Copy one wallet's fresh buy/sell events to all its followers. */
async function handle(chain, target, events, notify, deadline) {
  const now = Math.floor(Date.now() / 1000);
  const evs = (events || []).filter((e) => (e.type === "buy" || e.type === "sell") && e.token && e.token.id && now - (e.ts || now) <= MAX_AGE);
  if (!evs.length) return 0;
  const fol = (await db.select("bot_copy", `chain=eq.${chain}&target=eq.${encodeURIComponent(target)}&active=eq.true&select=*`).catch(() => [])) || [];
  if (!fol.length) return 0;
  const c = T.CODE[chain], nat = T.CH[c].nat; let done = 0;
  for (const e of evs) {
    const ca = e.token.id, sym = e.token.sym || ca.slice(0, 6), pct = e.type === "sell" ? await soldPct(chain, target, ca, e.amt) : 0;
    const safe = e.type === "buy" && fol.some((f) => f.safe) ? await safeEnough(ca, chain) : { ok: true };
    for (const f of fol) {
      if (deadline && Date.now() > deadline) return done;
      if (e.type === "sell" && !f.sells) continue;
      if (!(await claimTrade(f.tg_id, target, e.hash, e.type, ca))) continue;
      const who = f.label ? `<b>${String(f.label).replace(/[<>&]/g, "")}</b>` : `<code>${target.slice(0, 4)}…${target.slice(-4)}</code>`;
      const src = `<a href="${T.CH[c].exp}${e.hash}">their tx</a>`;
      try {
        if (e.type === "buy") {
          if (f.safe && !safe.ok) { await logNote(f.tg_id, e.hash, ca, false, "skipped: " + safe.why); await notify(f.tg_id, `👥 ${who} bought <b>${sym}</b> · skipped (🛡 safe mode: ${safe.why}). ${src}`, c, ca); continue; }
          if ((await buysToday(f.tg_id)) >= (f.max_day || 20)) { await logNote(f.tg_id, e.hash, ca, false, "daily limit"); continue; }
          const r = await T.buy(f.tg_id, c, ca, f.amount);
          await logNote(f.tg_id, e.hash, ca, true, r.hash); done++;
          const row = await T.getRow(f.tg_id), st = T.settings(row); await require("./orders").autoOnBuy(f.tg_id, c, ca, st).catch(() => {});
          await notify(f.tg_id, `👥 Copied ${who}: bought <b>${sym}</b> with ${f.amount} ${nat}\n<a href="${T.CH[c].exp}${r.hash}">Your tx</a> · ${src}`, c, ca);
        } else {
          const r = await T.sell(f.tg_id, c, ca, pct);
          await logNote(f.tg_id, e.hash, ca, true, r.hash); done++;
          await notify(f.tg_id, `👥 Copied ${who}: sold ${pct}% of <b>${sym}</b> for ~${T.fromUnits(r.out, T.CH[c].dec)} ${nat}\n<a href="${T.CH[c].exp}${r.hash}">Your tx</a> · ${src}`, c, ca);
        }
      } catch (err) {
        const msg = String((err && err.message) || err);
        await logNote(f.tg_id, e.hash, ca, false, msg);
        if (e.type === "sell" && /don't hold|no .*balance/i.test(msg)) continue; // never bought it: nothing to copy
        await notify(f.tg_id, `👥 ${who} ${e.type === "buy" ? "bought" : "sold"} <b>${sym}</b> but the copy failed:\n${msg.slice(0, 160)}`, c, ca);
      }
    }
  }
  return done;
}

/** Helius webhook body: array of enhanced transactions. */
async function onHook(body, notify, deadline) {
  const txs = Array.isArray(body) ? body : [];
  if (!txs.length) return { txs: 0 };
  const rows = (await db.select("bot_copy", "chain=eq.solana&active=eq.true&select=target")) || [];
  const watched = new Set(rows.map((r) => r.target)); let copied = 0;
  for (const t of txs) {
    const who = new Set([t.feePayer, ...(t.accountData || []).map((a) => a.account)].filter((a) => watched.has(a)));
    for (const a of who) copied += await handle("solana", a, W.solParse(t, a), notify, deadline);
  }
  return { txs: txs.length, copied };
}

/** Cron backup: poll every watched wallet (all chains) for trades since the last check. */
async function pollJob(deadline, notify) {
  const rows = (await db.select("bot_copy", "active=eq.true&select=chain,target").catch(() => [])) || [];
  const uniq = [...new Map(rows.map((r) => [r.chain + ":" + r.target, r])).values()];
  let copied = 0, checked = 0;
  for (const r of uniq) {
    if (Date.now() > deadline) break;
    const cur = (await getCursor(r.chain, r.target)) || null;
    if (!cur) { await setCursor(r.chain, r.target, { ts: Math.floor(Date.now() / 1000), h: [] }); continue; }
    const ev = r.chain === "solana" ? await W.solEvents(r.target, cur).catch(() => null) : await W.evmEvents(r.chain, r.target, cur).catch(() => null);
    if (!ev) continue; checked++;
    if (ev.length) {
      const top = Math.max(...ev.map((e) => e.ts || 0));
      await setCursor(r.chain, r.target, { ts: top, h: ev.filter((e) => e.ts === top).map((e) => e.hash) });
      copied += await handle(r.chain, r.target, ev, notify, deadline);
    }
  }
  return { copyTargets: uniq.length, copyChecked: checked, copied };
}

module.exports = { MAX_TARGETS, list, add, update, remove, syncHook, onHook, pollJob, handle };
