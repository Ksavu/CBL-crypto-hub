// xStocks: tokenized US stocks/ETFs on Solana (AAPLx, TSLAx, NVDAx, SPYx…), traded in the Bartender through Jupiter.
//   The list is discovered live from Jupiter's token API and kept only if the token is Jupiter-verified AND its name
//   ends in "xStock" AND its symbol ends in "x" — copycat "Apple on Solana" tokens are left out.
//   Cached 5 minutes per instance.
const SEARCH = ["xStock", "AAPLx", "TSLAx", "NVDAx", "SPYx", "QQQx", "METAx", "GOOGLx", "AMZNx", "MSFTx", "COINx", "MSTRx", "HOODx", "CRCLx", "NFLXx", "AMDx", "PLTRx", "GMEx"];
let cache = { t: 0, list: [] };

async function jget(u, ms = 6000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, { signal: c.signal, headers: { accept: "application/json" } }); return r.ok ? await r.json() : null; } catch (e) { return null; } finally { clearTimeout(t); }
}
const official = (t) => t && t.id && t.isVerified === true && /xstock\s*$/i.test(String(t.name || "")) && /^[A-Z.]{1,8}x$/.test(String(t.symbol || ""));

async function list() {
  if (Date.now() - cache.t < 5 * 60e3 && cache.list.length) return cache.list;
  const res = await Promise.all(SEARCH.map((q) => jget("https://lite-api.jup.ag/tokens/v2/search?query=" + encodeURIComponent(q))));
  const M = new Map();
  for (const arr of res) for (const t of Array.isArray(arr) ? arr : []) if (official(t) && !M.has(t.id)) {
    const s = t.stats24h || {};
    M.set(t.id, { mint: t.id, sym: t.symbol, name: String(t.name).replace(/\s*xStock\s*$/i, ""), icon: t.icon || null, price: Number(t.usdPrice) || null,
      ch24: Number.isFinite(Number(s.priceChange)) ? Number(s.priceChange) : null, liq: Number(t.liquidity) || 0, vol: (Number(s.buyVolume) || 0) + (Number(s.sellVolume) || 0) });
  }
  const out = [...M.values()].sort((a, b) => b.liq - a.liq);
  if (out.length) cache = { t: Date.now(), list: out };
  return out.length ? out : cache.list;
}

/** US market status (NYSE regular hours 9:30–16:00 New York, Mon–Fri; holidays not included). */
function market(now = new Date()) {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })), d = ny.getDay(), m = ny.getHours() * 60 + ny.getMinutes();
  const open = d >= 1 && d <= 5 && m >= 570 && m < 960;
  return { open, label: open ? "🟢 US market open" : "🌙 US market closed", note: open ? "Prices track the real stock closely right now." : "The stock exchange is closed: xStock prices can drift from the real stock and spreads are wider. Use limit-style care and smaller sizes." };
}

module.exports = { list, market, official };
