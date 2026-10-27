// Market data for XRPLabs tokens, read straight from the XRP Ledger (no indexer needed).
// Every trade on a launched token changes its AMM pool, so the AMM account's transaction
// history *is* the trade history: each validated tx's metadata holds the pool reserves after it.
const RPCS = ["https://xrplcluster.com", "https://s2.ripple.com:51234", "https://s1.ripple.com:51234"];
const RIPPLE_EPOCH = 946684800;
const DAY = 86400;

async function rpc(method, params, ms = 8000) {
  let last;
  for (const base of RPCS) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(base, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) });
      if (!r.ok) { last = new Error("HTTP " + r.status); continue; }
      const j = await r.json();
      if (j && j.result) {
        if (j.result.status === "error" && j.result.error !== "actNotFound") { last = new Error(j.result.error); continue; }
        return j.result;
      }
    } catch (e) { last = e; } finally { clearTimeout(t); }
  }
  throw last || new Error("XRPL unavailable");
}

async function poolOf(currency, issuer) {
  const r = await rpc("amm_info", { asset: { currency: "XRP" }, asset2: { currency, issuer }, ledger_index: "validated" });
  const a = r && r.amm;
  if (!a) return null;
  const xrpFirst = typeof a.amount === "string";
  const xrp = Number(xrpFirst ? a.amount : a.amount2) / 1e6, tok = Number(xrpFirst ? a.amount2.value : a.amount.value);
  return { account: a.account, xrp, tok, fee: (a.trading_fee || 0) / 1000 };
}

const txTime = (t, tx) => t.close_time_iso ? Date.parse(t.close_time_iso) / 1000 : (tx.date != null ? tx.date + RIPPLE_EPOCH : 0);

/** Reserves of the pool after this tx and how they changed (pool's perspective). */
function poolDelta(meta, amm, currency, issuer) {
  let x = null, px = null, k = null, pk = null;
  for (const n of meta.AffectedNodes || []) {
    const b = n.ModifiedNode || n.CreatedNode || n.DeletedNode; if (!b) continue;
    const f = b.FinalFields || b.NewFields || {}, p = b.PreviousFields || {};
    if (b.LedgerEntryType === "AccountRoot" && f.Account === amm) {
      x = Number(f.Balance || 0) / 1e6;
      px = n.CreatedNode ? 0 : p.Balance !== undefined ? Number(p.Balance) / 1e6 : x;
    } else if (b.LedgerEntryType === "RippleState") {
      const hi = f.HighLimit && f.HighLimit.issuer, lo = f.LowLimit && f.LowLimit.issuer, cur = (f.Balance && f.Balance.currency) || (f.HighLimit && f.HighLimit.currency);
      if (cur !== currency || !((hi === amm && lo === issuer) || (lo === amm && hi === issuer))) continue;
      const sign = lo === amm ? 1 : -1;
      k = n.DeletedNode ? 0 : Number(f.Balance.value) * sign;
      pk = n.CreatedNode ? 0 : p.Balance ? Number(p.Balance.value) * sign : k;
    }
  }
  if (x === null && k === null) return null;
  return { x, dx: x === null ? 0 : x - px, k, dk: k === null ? 0 : k - pk };
}

/**
 * Trades on the pool, newest first, until `since` (unix seconds) or `max` txs.
 * Each: { t, price, xrp (abs XRP moved), side: buy|sell|add|remove|create, account, hash }
 */
async function trades(pool, currency, issuer, { since = 0, max = 400 } = {}) {
  const out = [];
  let marker, pages = 0, lastX = pool.xrp, lastK = pool.tok, older = null;
  do {
    const r = await rpc("account_tx", { account: pool.account, ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false, ...(marker ? { marker } : {}) });
    for (const t of r.transactions || []) {
      const tx = t.tx_json || t.tx || {}, meta = t.meta || t.metaData;
      if (!meta || meta.TransactionResult !== "tesSUCCESS") continue;
      const d = poolDelta(meta, pool.account, currency, issuer); if (!d) continue;
      const x = d.x !== null ? d.x : lastX, k = d.k !== null ? d.k : lastK;
      lastX = x - d.dx; lastK = k - d.dk; // reserves before this tx (we walk backwards)
      const time = txTime(t, tx);
      const row = {
        t: time, price: k > 0 ? x / k : null, xrp: Math.abs(d.dx), tok: Math.abs(d.dk),
        side: tx.TransactionType === "AMMCreate" ? "create" : d.dx > 0 && d.dk < 0 ? "buy" : d.dx < 0 && d.dk > 0 ? "sell" : d.dx >= 0 && d.dk >= 0 ? "add" : "remove",
        account: tx.Account || null, hash: t.hash || tx.hash || null,
      };
      if (since && time < since) { older = row; break; }
      out.push(row);
      if (out.length >= max) break;
    }
    marker = r.marker; pages++;
  } while (marker && !older && out.length < max && pages < 6);
  return { list: out, before: older };
}

async function supplyOf(issuer, currency) {
  try { const g = await rpc("gateway_balances", { account: issuer, ledger_index: "validated" }); return Number((g.obligations || {})[currency]) || null; } catch (e) { return null; }
}

/** Compact market stats for list views. */
async function stats(l) {
  const pool = await poolOf(l.currency, l.issuer);
  if (!pool) return null;
  const now = Date.now() / 1000;
  const { list, before } = await trades(pool, l.currency, l.issuer, { since: now - DAY, max: 600 });
  const price = pool.xrp / pool.tok;
  const swaps = list.filter((r) => r.side === "buy" || r.side === "sell");
  const base = before ? before.price : (list.length ? list[list.length - 1].price : price);
  const supply = Number(l.supply) || (await supplyOf(l.issuer, l.currency)) || null;
  return {
    price, liq: pool.xrp * 2, mcap: supply ? price * supply : null, supply,
    vol24: swaps.reduce((s, r) => s + r.xrp, 0), buys24: swaps.filter((r) => r.side === "buy").length, sells24: swaps.filter((r) => r.side === "sell").length,
    change24: base ? (price / base - 1) * 100 : null, amm: pool.account, poolFee: pool.fee,
  };
}

/** Full detail for one token page: stats + price history + recent trades + holders. */
async function detail(l) {
  const pool = await poolOf(l.currency, l.issuer);
  if (!pool) return null;
  const [{ list }, s, holders] = await Promise.all([
    trades(pool, l.currency, l.issuer, { max: 1200 }),
    stats(l),
    holdersOf(l.issuer, l.currency, pool.account),
  ]);
  return { stats: s, holders, history: list.slice().reverse().filter((r) => r.price).map((r) => ({ t: r.t, p: r.price, v: r.side === "buy" || r.side === "sell" ? r.xrp : 0, s: r.side })), trades: list.slice(0, 50) };
}

async function holdersOf(issuer, currency, amm) {
  let n = 0, top = [], marker, pages = 0, total = 0;
  try {
    do {
      const r = await rpc("account_lines", { account: issuer, ledger_index: "validated", limit: 400, ...(marker ? { marker } : {}) });
      for (const l of r.lines || []) {
        if (l.currency !== currency) continue;
        const bal = -Number(l.balance); if (!(bal > 0)) continue;
        total += bal; if (l.account === amm) continue;
        n++; top.push({ account: l.account, bal });
      }
      marker = r.marker; pages++;
    } while (marker && pages < 5);
  } catch (e) { return null; }
  top.sort((a, b) => b.bal - a.bal);
  return { count: n, capped: !!marker, top: top.slice(0, 10).map((h) => ({ account: h.account, pct: total ? (h.bal / total) * 100 : 0 })) };
}

module.exports = { stats, detail, poolDelta, rpc };
