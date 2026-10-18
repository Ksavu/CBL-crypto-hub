// On-chain fallback for EVM chains where GoPlus has no coverage (e.g. Robinhood Chain): Blockscout API + RPC.
const CFG = {
  robinhood: { api: "https://robinhoodchain.blockscout.com/api/v2", rpc: "https://rpc.mainnet.chain.robinhood.com", win: 40, chunk: 5000 },
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
  const out = { holders: null, verified: null, proxy: null, creator: null, creatorPct: null, top1: null, top5: null, top10: null, owner: undefined, ownerKnown: false };
  if (tok && tok.holders_count != null) out.holders = parseInt(tok.holders_count, 10) || null;
  if (ad) {
    if (typeof ad.is_verified === "boolean") out.verified = ad.is_verified;
    out.proxy = !!(ad.proxy_type || (ad.implementations && ad.implementations.length));
    out.creator = (ad.creator_address_hash || "").toLowerCase() || null;
  }
  if (typeof own === "string" && /^0x[0-9a-f]{64}$/i.test(own)) { out.ownerKnown = true; out.owner = "0x" + own.slice(26).toLowerCase(); }
  const supply = tok && parseFloat(tok.total_supply);
  out.supplyRaw = supply > 0 ? supply : null;
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
    if (pct.length) { out.top1 = pct[0]; out.top5 = pct.slice(0, 5).reduce((x, y) => x + y, 0); out.top10 = pct.slice(0, 10).reduce((x, y) => x + y, 0); }
    if (out.creator && out.creatorPct === null && items.length >= 50) out.creatorPct = 0;
  }
  return out;
}

// Snipers and bundlers from Transfer logs out of the pair/pool, starting at the block where trading began.
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const rpcCall = (cfg, method, params) => get(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => (r && r.result !== undefined ? r.result : null));
const logs = (cfg, token, pair, from, to) => rpcCall(cfg, "eth_getLogs", [{ address: token, topics: [TRANSFER, pad(pair)], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);

async function evmLaunch(chain, token, pair, pairCreatedMs, supply, budgetMs = 12000) {
  const cfg = CFG[chain]; if (!cfg || !pair || !pairCreatedMs || !(supply > 0)) return null;
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const origin = cfg.api.replace(/\/api\/v2$/, "");
  const bt = await get(`${origin}/api?module=block&action=getblocknobytime&timestamp=${Math.floor(pairCreatedMs / 1000) - 120}&closest=after`);
  let start = bt && bt.result && parseInt(bt.result.blockNumber || bt.result, 10);
  if (!(start > 0)) return { traced: false };
  const head = parseInt(await rpcCall(cfg, "eth_blockNumber", []), 16);
  let first = null;
  for (let b = start, n = 0; b <= head && n < 6 && left() > 3000 && !first; b += cfg.chunk, n++) {
    const L = await logs(cfg, token, pair, b, Math.min(head, b + cfg.chunk - 1));
    if (L === null) { if (n === 0) return { traced: false }; break; }
    if (L.length) first = Math.min(...L.map((x) => parseInt(x.blockNumber, 16)));
  }
  if (first === null) return { traced: false };
  const W = await logs(cfg, token, pair, first, Math.min(head, first + cfg.win));
  if (!W || !W.length) return { traced: false };
  const by = {}, pa = pair.toLowerCase();
  for (const l of W) {
    const to = "0x" + l.topics[2].slice(26).toLowerCase(), blk = parseInt(l.blockNumber, 16);
    if (to === pa || DEAD.test(to) || to === token.toLowerCase()) continue;
    (by[to] = by[to] || { first: blk }).first = Math.min(by[to].first, blk);
  }
  const all = Object.keys(by), same = all.filter((a) => by[a].first === first);
  const bundle = same.length >= 2 ? same : [], snipe = all.filter((a) => !bundle.includes(a));
  const grp = async (ws) => {
    if (!ws.length) return null;
    const sel = ws.slice(0, 40);
    const bal = await Promise.all(sel.map((a) => rpcCall(cfg, "eth_call", [{ to: token, data: "0x70a08231" + pad(a).slice(2) }, "latest"]).then((v) => (typeof v === "string" && v.length > 2 ? parseInt(v, 16) : 0)).catch(() => 0)));
    return { wallets: ws.length, stillHolding: bal.filter((x) => x > 0).length, heldPct: (bal.reduce((x, y) => x + y, 0) / supply) * 100 };
  };
  const [bundlers, snipers] = await Promise.all([grp(bundle), grp(snipe)]);
  return { traced: true, bundlers, snipers, firstBlock: first };
}
module.exports = { explorerEvm, evmLaunch, EXPLORER_CHAINS: Object.keys(CFG) };
