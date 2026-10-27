// DexScreener "DEX paid" status (paid profile, community takeover, ads) + boosts. Hype info only, never scored.
async function getOrders(chain, address, ms = 3500) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(`https://api.dexscreener.com/orders/v1/${chain}/${encodeURIComponent(address)}`, { signal: c.signal, headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

/** paid: true/false, or null when unknown. */
function dexPaid(orders, pair) {
  const list = Array.isArray(orders) ? orders : (orders && Array.isArray(orders.orders) ? orders.orders : null);
  const ok = (t) => !!list && list.some((o) => o && o.type === t && o.status === "approved");
  let paid = list ? ok("tokenProfile") : null;
  // Orders API unavailable: an enhanced profile (header banner) on the pair means it was paid.
  if (paid === null && pair && pair.info && pair.info.header) paid = true;
  const ts = list ? list.filter((o) => o && o.type === "tokenProfile" && o.status === "approved").map((o) => o.paymentTimestamp).filter(Boolean)[0] : null;
  return { paid, paidAt: ts || null, cto: ok("communityTakeover"), ads: ok("tokenAd") || ok("trendingBarAd"), boosts: (pair && pair.boosts && pair.boosts.active) || 0 };
}

module.exports = { getOrders, dexPaid };
