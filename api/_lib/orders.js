// Take profit / stop loss for the CBL trading bot.
//   Orders live in bot_orders (kind take_profit | stop_loss). params: { ref, trig, pct, sell, fails }
//   ref  = entry price in the chain's coin (average buy price from bot_trades, or the price when the order was set)
//   trig = price that fires the order;  pct = gain/loss %;  sell = % of the position to sell when it fires
//   /api/cron?job=orders checks prices every run (GitHub Actions: every 5 minutes) and sells through trade.sell().
const db = require("./db");
const T = require("./trade");

const NATIVE_Q = /^(W?SOL|W?BNB|W?ETH)$/i;
async function jget(u, ms = 8000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json" } }); return r.ok ? await r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); }
}
const key = (chain, ca) => (chain === "solana" ? ca : String(ca).toLowerCase());

/** Price in the chain's own coin (SOL / BNB / ETH) from the most liquid native-quoted pair. */
async function prices(chain, cas) {
  const out = {};
  for (let i = 0; i < cas.length; i += 30) {
    const j = await jget(`https://api.dexscreener.com/tokens/v1/${chain}/${cas.slice(i, i + 30).join(",")}`);
    for (const p of (Array.isArray(j) ? j : [])) {
      if (!p.baseToken || !p.quoteToken || !NATIVE_Q.test(p.quoteToken.symbol || "")) continue;
      const k = key(chain, p.baseToken.address), liq = (p.liquidity && p.liquidity.usd) || 0, pn = Number(p.priceNative);
      if (pn > 0 && (!out[k] || liq > out[k].liq)) out[k] = { pn, liq, pu: Number(p.priceUsd) || null, sym: p.baseToken.symbol };
    }
  }
  return out;
}

/** Average entry price (coin per token) from this user's bot buys. */
async function entry(uid, chain, ca) {
  const rows = (await db.select("bot_trades", `tg_id=eq.${uid}&chain=eq.${chain}&token=eq.${encodeURIComponent(key(chain, ca))}&side=eq.buy&select=native_raw,token_raw,decimals`)) || [];
  let nat = 0, tok = 0; const nd = T.CH[T.CODE[chain]].dec;
  rows.forEach((r) => { nat += Number(r.native_raw) / 10 ** nd; tok += Number(r.token_raw) / 10 ** (r.decimals || 0); });
  return nat > 0 && tok > 0 ? nat / tok : null;
}

async function add(uid, c, ca, kind, pct, sell) {
  const chain = T.CH[c].key;
  pct = Number(pct); sell = Math.min(100, Math.max(1, Math.round(Number(sell) || 100)));
  if (!(pct > 0) || (kind === "stop_loss" && pct >= 100)) throw new T.UserErr(kind === "stop_loss" ? "Stop loss must be between 1 and 99%." : "Take profit must be above 0%.");
  let ref = await entry(uid, chain, ca), from = "your average entry";
  if (!ref) { const p = (await prices(chain, [key(chain, ca)]))[key(chain, ca)]; if (!p) throw new T.UserErr("No price for this token yet, so I can't set a target."); ref = p.pn; from = "the current price"; }
  const trig = kind === "take_profit" ? ref * (1 + pct / 100) : ref * (1 - pct / 100);
  await db.insert("bot_orders", [{ tg_id: uid, chain, token: key(chain, ca), kind, params: { ref, trig, pct, sell, fails: 0 }, active: true }]);
  return { ref, trig, from, pct, sell };
}
const list = (uid, chain, ca) => db.select("bot_orders", `tg_id=eq.${uid}&active=eq.true${chain ? `&chain=eq.${chain}&token=eq.${encodeURIComponent(key(chain, ca))}` : ""}&select=*&order=created_at.asc&limit=50`).then((r) => r || []);
const cancel = (uid, id) => db.patch("bot_orders", `tg_id=eq.${uid}&id=eq.${Number(id)}`, { active: false });

/** Settings → Auto TP/SL: attach orders to every buy. */
async function autoOnBuy(uid, c, ca, st) {
  const made = [];
  if (st.autoTp && st.autoTp.on) made.push(Object.assign({ kind: "TP" }, await add(uid, c, ca, "take_profit", st.autoTp.pct, st.autoTp.sell).catch(() => null)));
  if (st.autoSl && st.autoSl.on) made.push(Object.assign({ kind: "SL" }, await add(uid, c, ca, "stop_loss", st.autoSl.pct, st.autoSl.sell).catch(() => null)));
  return made.filter((m) => m.trig);
}

/** Cron: check every active order and sell when a target is hit. notify(uid, html) sends the Telegram message. */
async function job(deadline, notify) {
  if (!T.on()) return { skipped: "trading off" };
  const rows = (await db.select("bot_orders", "active=eq.true&kind=in.(take_profit,stop_loss)&select=*&order=created_at.asc&limit=500")) || [];
  if (!rows.length) return { orders: 0 };
  const by = {}; rows.forEach((o) => (by[o.chain] = by[o.chain] || new Set()).add(o.token));
  const px = {}; await Promise.all(Object.entries(by).map(async ([ch, s]) => { const p = await prices(ch, [...s]); Object.keys(p).forEach((k) => (px[ch + "|" + k] = p[k])); }));
  const hits = rows.filter((o) => { const p = px[o.chain + "|" + o.token]; return p && (o.kind === "take_profit" ? p.pn >= o.params.trig : p.pn <= o.params.trig); })
    .sort((a, b) => (a.kind === "stop_loss" ? -1 : 1) - (b.kind === "stop_loss" ? -1 : 1)); // stop losses first
  let fired = 0, failed = 0; const done = new Set();
  for (const o of hits) {
    if (Date.now() > deadline - 12000) break;
    const k = o.tg_id + "|" + o.chain + "|" + o.token; if (done.has(k)) continue; // one sell per position per run
    const c = T.CODE[o.chain], p = px[o.chain + "|" + o.token], label = o.kind === "take_profit" ? `🎯 Take profit +${o.params.pct}%` : `🛑 Stop loss -${o.params.pct}%`;
    try {
      const r = await T.sell(o.tg_id, c, o.token, o.params.sell);
      await db.patch("bot_orders", `id=eq.${o.id}`, { active: false });
      if (o.params.sell >= 100) await db.patch("bot_orders", `tg_id=eq.${o.tg_id}&chain=eq.${o.chain}&token=eq.${encodeURIComponent(o.token)}&active=eq.true`, { active: false });
      done.add(k); fired++;
      await notify(o.tg_id, `${label} hit on <b>${p.sym || o.token.slice(0, 6)}</b> (${T.CH[c].name})\nSold ${o.params.sell}% for ~${T.fromUnits(r.out, T.CH[c].dec)} ${T.CH[c].nat}\n<a href="${T.CH[c].exp}${r.hash}">View transaction</a>`, c, o.token);
    } catch (e) {
      const msg = String((e && e.message) || e), gone = /don't hold/i.test(msg), fails = (o.params.fails || 0) + 1;
      const stop = gone || fails >= 3;
      await db.patch("bot_orders", `id=eq.${o.id}`, { params: Object.assign({}, o.params, { fails }), active: !stop });
      if (/still running/i.test(msg)) continue; // user busy: try next run
      failed++;
      if (!gone) await notify(o.tg_id, `${label} triggered on <b>${p.sym || o.token.slice(0, 6)}</b> but the sell failed${stop ? " 3 times, so the order was cancelled" : " (I'll retry next check)"}:\n${msg.slice(0, 160)}`, c, o.token);
    }
  }
  return { orders: rows.length, triggered: hits.length, fired, failed };
}

module.exports = { add, list, cancel, autoOnBuy, job, entry, prices };
