// On-chain fallback for EVM chains where GoPlus has no coverage (e.g. Robinhood Chain): Blockscout API + RPC.
const CFG = {
  robinhood: { api: "https://robinhoodchain.blockscout.com/api/v2", rpc: "https://rpc.mainnet.chain.robinhood.com" },
};
const DEAD = /^0x(0{40}|0{39}1|[0d]*dead[0-9a-f]*)$/i;
const get = async (u, opt = {}) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 8000);
  try { const r = await fetch(u, Object.assign({ signal: c.signal, headers: { accept: "application/json" } }, opt)); if (!r.ok) return null; return await r.json(); }
  catch (e) { return null; } finally { clearTimeout(t); }
};
const rpc = (cfg, to, data) => get(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) }).then((r) => r && r.result);

async function explorerEvm(chain, addr, pairAddr) {
  const cfg = CFG[chain]; if (!cfg) return null;
  const [tok, ad, hold, own] = await Promise.all([
    get(`${cfg.api}/tokens/${addr}`), get(`${cfg.api}/addresses/${addr}`), get(`${cfg.api}/tokens/${addr}/holders`),
    rpc(cfg, addr, "0x8da5cb5b"),
  ]);
  if (!tok && !ad && !hold && !own) return null;
  const out = { holders: null, verified: null, proxy: null, creator: null, creatorPct: null, top1: null, top5: null, owner: undefined, ownerKnown: false };
  if (tok && tok.holders_count != null) out.holders = parseInt(tok.holders_count, 10) || null;
  if (ad) {
    if (typeof ad.is_verified === "boolean") out.verified = ad.is_verified;
    out.proxy = !!(ad.proxy_type || (ad.implementations && ad.implementations.length));
    out.creator = (ad.creator_address_hash || "").toLowerCase() || null;
  }
  if (typeof own === "string" && /^0x[0-9a-f]{64}$/i.test(own)) { out.ownerKnown = true; out.owner = "0x" + own.slice(26).toLowerCase(); }
  const supply = tok && parseFloat(tok.total_supply);
  const items = (hold && hold.items) || [];
  if (supply > 0 && items.length) {
    const pa = (pairAddr || "").toLowerCase(), pct = [];
    for (const it of items) {
      const a = ((it.address && it.address.hash) || "").toLowerCase(), v = parseFloat(it.value);
      if (!a || !(v >= 0)) continue;
      const p = (v / supply) * 100;
      if (out.creator && a === out.creator) out.creatorPct = p;
      if (a === pa || DEAD.test(a) || (it.address && it.address.is_contract)) continue;
      pct.push(p);
    }
    pct.sort((x, y) => y - x);
    if (pct.length) { out.top1 = pct[0]; out.top5 = pct.slice(0, 5).reduce((x, y) => x + y, 0); }
    if (out.creator && out.creatorPct === null && items.length >= 50) out.creatorPct = 0;
  }
  return out;
}
module.exports = { explorerEvm, EXPLORER_CHAINS: Object.keys(CFG) };
