// CBL Buy Bot: projects add CBLScannerBot to their group and run /buybot <token>; every buy is posted there.
//   Solana: instant through the same Helius webhook as copy trading (the token mint is watched).
//   BNB / Base / Ethereum (and a Solana backup): GeckoTerminal pool trades, checked every 5 minutes by the cron.
// Table: bot_buybot (buybot.sql). One token per group.
const db = require("./db");
const W = require("./wallets");

const env = (k) => String(process.env[k] || "").trim();
const bot = () => env("TELEGRAM_BOT_USERNAME").replace(/^@/, "");
const SITE = () => (env("SITE_URL") || "https://cryptobarlounge.space").replace(/\/$/, "");
const GT = { solana: "solana", bsc: "bsc", base: "base", ethereum: "eth", robinhood: "robinhood" };
const CODE = { solana: "s", bsc: "b", base: "e", robinhood: "r" };
const NAT = { solana: "SOL", bsc: "BNB", base: "ETH", ethereum: "ETH", robinhood: "ETH" };
const EXP = { solana: "https://solscan.io/tx/", bsc: "https://bscscan.com/tx/", base: "https://basescan.org/tx/", ethereum: "https://etherscan.io/tx/", robinhood: "https://explorer.mainnet.chain.robinhood.com/tx/" };
const key = (chain, a) => (chain === "solana" ? a : String(a).toLowerCase());

async function jget(u, ms = 8000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json" } }); return r.ok ? await r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); }
}

/** Most liquid pair → chain, pool, price, market cap, native coin price. */
async function market(ca, chain) {
  const j = await jget("https://api.dexscreener.com/latest/dex/tokens/" + ca);
  const ps = ((j && j.pairs) || []).filter((p) => !chain || p.chainId === chain).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const p = ps[0]; if (!p) return null;
  const nat = ps.find((x) => /^W?(SOL|BNB|ETH)$/i.test((x.quoteToken && x.quoteToken.symbol) || "") && Number(x.priceNative) > 0) || p;
  return { chain: p.chainId, pool: p.pairAddress, sym: (p.baseToken && p.baseToken.symbol) || "", price: Number(p.priceUsd) || 0, mc: Number(p.marketCap || p.fdv) || 0,
    supply: Number(p.marketCap || p.fdv) && Number(p.priceUsd) ? (p.marketCap || p.fdv) / Number(p.priceUsd) : 0,
    natUsd: Number(nat.priceUsd) && Number(nat.priceNative) && /^W?(SOL|BNB|ETH)$/i.test((nat.quoteToken && nat.quoteToken.symbol) || "") ? Number(nat.priceUsd) / Number(nat.priceNative) : 0, url: p.url };
}

// ---------- group settings ----------
const get = (chat) => db.select("bot_buybot", `chat_id=eq.${chat}&select=*`).then((r) => (r && r[0]) || null);
async function set(chat, ca) {
  const m = await market(ca); if (!m) throw new Error("I can't find this token on DEX Screener yet.");
  if (!GT[m.chain]) throw new Error("This chain isn't supported by the buy bot yet.");
  await db.upsert("bot_buybot", [{ chat_id: chat, chain: m.chain, token: key(m.chain, ca), pool: m.pool, sym: m.sym, active: true, mkt: m, cursor: { ts: Math.floor(Date.now() / 1000), h: [] } }], "chat_id");
  if (m.chain === "solana") await require("./copy").syncHook().catch(() => {});
  return m;
}
async function patch(chat, p) { await db.patch("bot_buybot", `chat_id=eq.${chat}`, p); if ("active" in p) await require("./copy").syncHook().catch(() => {}); }
async function solMints() { const r = (await db.select("bot_buybot", "chain=eq.solana&active=eq.true&select=token").catch(() => [])) || []; return [...new Set(r.map((x) => x.token))]; }

// ---------- the post ----------
const usd = (n) => (n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + n.toFixed(n < 10 ? 2 : 0));
const amt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toPrecision(4));
function post(g, b) {
  const step = Math.max(1, Number(g.step_usd) || 10), n = Math.min(40, Math.max(1, Math.floor(b.usd / step)));
  const e = g.emoji || "🟢", sym = String(g.sym || "TOKEN").replace(/[<>&]/g, "");
  const L = [e.repeat(n), "", `<b>${sym} Buy!</b>`, "",
    `💵 ${b.nat ? b.nat.toPrecision(4).replace(/\.?0+$/, "") + " " + NAT[g.chain] + " " : ""}(${usd(b.usd)})`,
    `🪙 ${amt(b.tokens)} ${sym}`,
    `👤 <a href="${(g.chain === "solana" ? "https://solscan.io/account/" : EXP[g.chain].replace("/tx/", "/address/")) + b.buyer}">${b.buyer.slice(0, 4)}…${b.buyer.slice(-4)}</a> · <a href="${EXP[g.chain] + b.hash}">TX</a>`,
    b.mc ? `📊 MC ${usd(b.mc)}` : null, "", `<i>Buy bot by <a href="https://t.me/${bot()}">CBL</a></i>`].filter((x) => x !== null);
  const kb = [[{ text: "🍸 Buy", url: CODE[g.chain] ? `https://t.me/${bot()}?start=tr_${CODE[g.chain]}_${g.token}` : `${SITE()}/swap` }, { text: "📈 Chart", url: (g.mkt && g.mkt.url) || `https://dexscreener.com/${g.chain}/${g.token}` }, { text: "🔍 Scan", url: `${SITE()}/?ca=${encodeURIComponent(g.token)}#scanner` }]];
  return { text: L.join("\n"), reply_markup: { inline_keyboard: kb } };
}
async function send(tg, g, b) {
  if (b.usd < (Number(g.min_usd) || 0)) return false;
  const m = post(g, b), base = { chat_id: g.chat_id, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: m.reply_markup };
  const r = g.media ? await tg(/\.(mp4|gif)(\?|$)/i.test(g.media) ? "sendAnimation" : "sendPhoto", Object.assign({}, base, { [/\.(mp4|gif)(\?|$)/i.test(g.media) ? "animation" : "photo"]: g.media, caption: m.text }))
    : await tg("sendMessage", Object.assign({}, base, { text: m.text }));
  if (r && !r.ok && /kicked|not a member|chat not found|forbidden/i.test(r.description || "")) await patch(g.chat_id, { active: false }).catch(() => {});
  return !!(r && r.ok);
}
const seen = (g, h) => ((g.cursor && g.cursor.h) || []).includes(h);
const remember = (g, items) => { const h = [...items.map((x) => x.hash), ...((g.cursor && g.cursor.h) || [])].slice(0, 60); const ts = Math.max((g.cursor && g.cursor.ts) || 0, ...items.map((x) => x.ts || 0)); g.cursor = { ts, h }; return db.patch("bot_buybot", `chat_id=eq.${g.chat_id}`, { cursor: g.cursor }).catch(() => {}); };

// ---------- Solana (webhook) ----------
async function onSolTx(t, tg) {
  const mints = new Set((t.tokenTransfers || []).map((x) => x.mint)); if (!mints.size) return 0;
  const rows = (await db.select("bot_buybot", "chain=eq.solana&active=eq.true&select=*").catch(() => [])) || [];
  let sent = 0;
  for (const g of rows.filter((r) => mints.has(r.token))) {
    if (seen(g, t.signature)) continue;
    const buyers = new Set(); (t.accountData || []).forEach((a) => (a.tokenBalanceChanges || []).forEach((b) => { if (b.mint === g.token && Number(b.rawTokenAmount && b.rawTokenAmount.tokenAmount) > 0) buyers.add(b.userAccount); }));
    const out = [];
    for (const who of buyers) {
      const ev = W.solParse(t, who).find((e) => e.type === "buy" && e.token && e.token.id === g.token); if (!ev) continue;
      const p = (ev.paid || [])[0] || {}, m = g.mkt || {};
      const usdV = p.sym === "SOL" ? p.amt * (m.natUsd || 0) : /USD/.test(p.sym || "") ? p.amt : 0;
      out.push({ hash: t.signature, ts: Number(t.timestamp), buyer: who, tokens: ev.amt, nat: p.sym === "SOL" ? p.amt : 0, usd: usdV || ev.amt * (m.price || 0), mc: m.mc || 0 });
    }
    if (!out.length) continue;
    await remember(g, out);
    for (const b of out) if (await send(tg, g, b)) sent++;
  }
  return sent;
}

// ---------- every chain (cron, GeckoTerminal) ----------
async function pollJob(deadline, tg) {
  const rows = (await db.select("bot_buybot", "active=eq.true&select=*&order=chat_id.asc&limit=200").catch(() => [])) || [];
  let sent = 0, checked = 0;
  const byPool = {}; rows.forEach((g) => (byPool[g.chain + ":" + g.pool] = byPool[g.chain + ":" + g.pool] || []).push(g));
  for (const [k, groups] of Object.entries(byPool)) {
    if (Date.now() > deadline) break;
    const g0 = groups[0], m = await market(g0.token, g0.chain);
    if (m) for (const g of groups) { g.mkt = m; await db.patch("bot_buybot", `chat_id=eq.${g.chat_id}`, { mkt: m, sym: m.sym || g.sym }).catch(() => {}); }
    const j = await jget(`https://api.geckoterminal.com/api/v2/networks/${GT[g0.chain]}/pools/${g0.pool}/trades`);
    const trades = ((j && j.data) || []).map((x) => x.attributes || {}).filter((a) => a.kind === "buy" && key(g0.chain, a.to_token_address || "") === key(g0.chain, g0.token));
    checked++;
    for (const g of groups) {
      const cut = (g.cursor && g.cursor.ts) || Math.floor(Date.now() / 1000);
      const fresh = trades.map((a) => ({ hash: a.tx_hash, ts: Math.floor(Date.parse(a.block_timestamp) / 1000), buyer: a.tx_from_address || "", tokens: Number(a.to_token_amount) || 0,
        nat: m && m.natUsd && Math.abs(Number(a.price_from_in_usd) - m.natUsd) / m.natUsd < 0.1 ? Number(a.from_token_amount) || 0 : 0, // paid in the native coin (SOL/BNB/ETH)?
        usd: Number(a.volume_in_usd) || 0, mc: m && m.price && m.supply ? Number(a.price_to_in_usd || m.price) * m.supply : (m && m.mc) || 0 }))
        .filter((b) => b.ts >= cut && !seen(g, b.hash)).sort((a, b) => a.ts - b.ts).slice(-10); // at most 10 posts per group per run
      if (!fresh.length) continue;
      await remember(g, fresh);
      for (const b of fresh) if (await send(tg, g, b)) sent++;
    }
  }
  return { buybotGroups: rows.length, buybotPools: checked, buybotSent: sent };
}

module.exports = { get, set, patch, solMints, onSolTx, pollJob, post, market };
