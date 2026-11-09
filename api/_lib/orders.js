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
/** Limit buy: spend `amount` coin when the price drops `pct`% below the current price. */
async function addLimit(uid, c, ca, pct, amount) {
  const chain = T.CH[c].key; pct = Number(pct);
  if (!(pct > 0 && pct < 100)) throw new T.UserErr("The drop must be between 1 and 99%.");
  const amt = String(amount || "").trim(); if (!/^\d*\.?\d+$/.test(amt) || !(Number(amt) > 0)) throw new T.UserErr("Enter the amount to spend, e.g. 0.5");
  const p = (await prices(chain, [key(chain, ca)]))[key(chain, ca)]; if (!p) throw new T.UserErr("No price for this token yet, so I can't set a limit.");
  const trig = p.pn * (1 - pct / 100);
  await db.insert("bot_orders", [{ tg_id: uid, chain, token: key(chain, ca), kind: "limit_buy", params: { ref: p.pn, trig, pct, amount: amt, fails: 0 }, active: true }]);
  return { ref: p.pn, trig, pct, amount: amt, sym: p.sym };
}

// ---------- Price / market-cap alerts (no wallet needed, any chain DexScreener covers) ----------
/** USD price + market cap from the most liquid pair of any quote. */
async function usdInfo(chain, cas) {
  const out = {};
  for (let i = 0; i < cas.length; i += 30) {
    const j = await jget(`https://api.dexscreener.com/tokens/v1/${chain}/${cas.slice(i, i + 30).join(",")}`);
    for (const p of (Array.isArray(j) ? j : [])) {
      if (!p.baseToken) continue;
      const k = key(chain, p.baseToken.address), liq = (p.liquidity && p.liquidity.usd) || 0;
      if (Number(p.priceUsd) > 0 && (!out[k] || liq > out[k].liq)) out[k] = { liq, pu: Number(p.priceUsd), mc: Number(p.marketCap || p.fdv) || null, sym: p.baseToken.symbol, url: p.url };
    }
  }
  return out;
}
/** Find chain + live numbers for any token address. */
async function lookup(ca) {
  const j = await jget("https://api.dexscreener.com/latest/dex/tokens/" + ca);
  const p = ((j && j.pairs) || []).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
  return p ? { chain: p.chainId, pu: Number(p.priceUsd) || null, mc: Number(p.marketCap || p.fdv) || null, sym: p.baseToken && p.baseToken.symbol } : null;
}
const num = (s) => { const m = /^\$?(\d*\.?\d+)\s*([kmb])?$/i.exec(String(s).trim()); return m ? Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1) : NaN; };
/** spec: "2x" | "+50%" | "-30%" | "mc 1m" | "$0.01" */
async function addAlert(uid, ca, spec) {
  const t = await lookup(ca); if (!t || !t.pu) throw new T.UserErr("I can't find a price for this token on DEX Screener.");
  spec = String(spec || "").trim().toLowerCase();
  let metric = "price", target, label;
  let m;
  if ((m = /^(\d*\.?\d+)\s*x$/.exec(spec))) { target = t.pu * Number(m[1]); label = `${m[1]}x`; }
  else if ((m = /^([+-])?\s*(\d*\.?\d+)\s*%$/.exec(spec))) { const pc = Number(m[2]) * (m[1] === "-" ? -1 : 1); if (pc <= -100) throw new T.UserErr("A drop must be under 100%."); target = t.pu * (1 + pc / 100); label = `${pc > 0 ? "+" : ""}${pc}%`; }
  else if ((m = /^(?:mc|mcap|cap)\s+(.+)$/.exec(spec))) { metric = "mc"; target = num(m[1]); if (!t.mc) throw new T.UserErr("No market cap for this token."); label = "MC " + m[1].toUpperCase(); }
  else { target = num(spec); label = "$" + spec.replace(/^\$/, ""); }
  if (!(target > 0)) throw new T.UserErr("Use: 2x · +50% · -30% · mc 1m · $0.01");
  const now = metric === "mc" ? t.mc : t.pu, dir = target >= now ? "up" : "down";
  const mine = (await db.select("bot_orders", `tg_id=eq.${uid}&kind=eq.alert&active=eq.true&select=id`).catch(() => [])) || [];
  if (mine.length >= 25) throw new T.UserErr("You have 25 alerts already. Remove some with /alerts.");
  await db.insert("bot_orders", [{ tg_id: uid, chain: t.chain, token: key(t.chain, ca), kind: "alert", params: { metric, target, dir, start: now, label, sym: t.sym }, active: true }]);
  return { sym: t.sym, chain: t.chain, metric, target, dir, now, label };
}
const alerts = (uid) => db.select("bot_orders", `tg_id=eq.${uid}&kind=eq.alert&active=eq.true&select=*&order=created_at.asc&limit=30`).then((r) => r || []);
async function alertJob(deadline, notify) {
  const rows = (await db.select("bot_orders", "active=eq.true&kind=eq.alert&select=*&order=created_at.asc&limit=1000").catch(() => [])) || [];
  if (!rows.length) return { alerts: 0 };
  const by = {}; rows.forEach((o) => (by[o.chain] = by[o.chain] || new Set()).add(o.token));
  const px = {}; await Promise.all(Object.entries(by).map(async ([ch, s]) => { const p = await usdInfo(ch, [...s]); Object.keys(p).forEach((k) => (px[ch + "|" + k] = p[k])); }));
  let sent = 0;
  for (const o of rows) {
    if (Date.now() > deadline) break;
    const p = px[o.chain + "|" + o.token]; if (!p) continue;
    const v = o.params.metric === "mc" ? p.mc : p.pu; if (!v) continue;
    if (o.params.dir === "up" ? v < o.params.target : v > o.params.target) continue;
    await db.patch("bot_orders", `id=eq.${o.id}`, { active: false }).catch(() => {});
    const fmt = (n) => (o.params.metric === "mc" ? "$" + (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : Math.round(n)) : "$" + Number(n).toPrecision(4));
    const ch = v / o.params.start;
    await notify(o.tg_id, `🔔 <b>Alert: ${String(p.sym || o.params.sym || "token").replace(/[<>&]/g, "")} ${o.params.label}</b>\n${o.params.metric === "mc" ? "Market cap" : "Price"} is now <b>${fmt(v)}</b> (${ch >= 1 ? "+" : ""}${((ch - 1) * 100).toFixed(1)}% since you set it at ${fmt(o.params.start)})\n<code>${o.token}</code>`, T.CODE[o.chain] || null, o.token, p.url);
    sent++;
  }
  return { alerts: rows.length, sent };
}

const list = (uid, chain, ca) => db.select("bot_orders", `tg_id=eq.${uid}&active=eq.true&kind=neq.alert${chain ? `&chain=eq.${chain}&token=eq.${encodeURIComponent(key(chain, ca))}` : ""}&select=*&order=created_at.asc&limit=50`).then((r) => r || []);
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
  const rows = (await db.select("bot_orders", "active=eq.true&kind=in.(take_profit,stop_loss,limit_buy)&select=*&order=created_at.asc&limit=500")) || [];
  if (!rows.length) return { orders: 0 };
  const by = {}; rows.forEach((o) => (by[o.chain] = by[o.chain] || new Set()).add(o.token));
  const px = {}; await Promise.all(Object.entries(by).map(async ([ch, s]) => { const p = await prices(ch, [...s]); Object.keys(p).forEach((k) => (px[ch + "|" + k] = p[k])); }));
  const hits = rows.filter((o) => { const p = px[o.chain + "|" + o.token]; return p && (o.kind === "take_profit" ? p.pn >= o.params.trig : p.pn <= o.params.trig); }) // stop loss and limit buy both fire on a drop
    .sort((a, b) => (a.kind === "stop_loss" ? -1 : 1) - (b.kind === "stop_loss" ? -1 : 1)); // stop losses first
  let fired = 0, failed = 0; const done = new Set();
  for (const o of hits) {
    if (Date.now() > deadline - 12000) break;
    const k = o.tg_id + "|" + o.chain + "|" + o.token; if (done.has(k)) continue; // one sell per position per run
    const c = T.CODE[o.chain], p = px[o.chain + "|" + o.token];
    if (o.kind === "limit_buy") {
      try {
        const r = await T.buy(o.tg_id, c, o.token, o.params.amount);
        await db.patch("bot_orders", `id=eq.${o.id}`, { active: false }); fired++;
        await notify(o.tg_id, `🟢 Limit buy filled on <b>${p.sym || o.token.slice(0, 6)}</b> (${T.CH[c].name})\nPrice dropped ${o.params.pct}% → bought with ${o.params.amount} ${T.CH[c].nat}\n<a href="${T.CH[c].exp}${r.hash}">View transaction</a>`, c, o.token);
      } catch (e) {
        const msg = String((e && e.message) || e), fails = (o.params.fails || 0) + 1, stop = /not enough/i.test(msg) || fails >= 3;
        await db.patch("bot_orders", `id=eq.${o.id}`, { params: Object.assign({}, o.params, { fails }), active: !stop });
        if (/still running/i.test(msg)) continue;
        failed++; await notify(o.tg_id, `🟢 Limit buy triggered on <b>${p.sym || o.token.slice(0, 6)}</b> but the buy failed${stop ? ", so the order was cancelled" : " (I'll retry next check)"}:\n${msg.slice(0, 160)}`, c, o.token);
      }
      continue;
    }
    const label = o.kind === "take_profit" ? `🎯 Take profit +${o.params.pct}%` : `🛑 Stop loss -${o.params.pct}%`;
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

module.exports = { addLimit, addAlert, alerts, alertJob, lookup, add, list, cancel, autoOnBuy, job, entry, prices };
