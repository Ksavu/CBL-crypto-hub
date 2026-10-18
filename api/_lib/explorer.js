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
  const out = { holders: null, verified: null, proxy: null, creator: null, creationTx: null, creatorPct: null, top1: null, top5: null, top10: null, owner: undefined, ownerKnown: false };
  if (tok && tok.holders_count != null) out.holders = parseInt(tok.holders_count, 10) || null;
  if (ad) {
    if (typeof ad.is_verified === "boolean") out.verified = ad.is_verified;
    out.proxy = !!(ad.proxy_type || (ad.implementations && ad.implementations.length));
    out.creator = (ad.creator_address_hash || "").toLowerCase() || null;
    out.creationTx = ad.creation_transaction_hash || ad.creation_tx_hash || null;
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

async function evmLaunch(chain, token, pairCreatedMs, supply, creationTx, budgetMs = 14000) {
  const cfg = CFG[chain]; if (!cfg || !(supply > 0)) return null;
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const origin = cfg.api.replace(/\/api\/v2$/, "");
  let start = 0;
  if (creationTx) { const tx = await get(`${cfg.api}/transactions/${creationTx}`); start = parseInt((tx && (tx.block_number != null ? tx.block_number : tx.block)) || 0, 10); }
  if (!(start > 0) && pairCreatedMs) {
    const bt = await get(`${origin}/api?module=block&action=getblocknobytime&timestamp=${Math.floor(pairCreatedMs / 1000) - 120}&closest=after`);
    start = parseInt((bt && bt.result && (bt.result.blockNumber || bt.result)) || 0, 10);
  }
  if (!(start > 0)) return { traced: false };
  const head = parseInt(await rpcCall(cfg, "eth_blockNumber", []), 16);
  const tl = (from, to, src) => rpcCall(cfg, "eth_getLogs", [{ address: token, topics: src ? [TRANSFER, pad(src)] : [TRANSFER], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  const dec = (l) => ({ from: "0x" + l.topics[1].slice(26).toLowerCase(), to: "0x" + l.topics[2].slice(26).toLowerCase(), blk: parseInt(l.blockNumber, 16) });
  const zero = /^0x0{40}$/;
  // 1. find the first chunk with real (non-mint) transfers and pick the distributor: the address that sends to the most different wallets (pool, pair or launchpad contract)
  let src = null, first = null, size = cfg.chunk;
  for (let b = start, n = 0; b <= head && n < 8 && left() > 4000 && !src; n++) {
    let L = await tl(b, Math.min(head, b + size - 1));
    if (L === null && size > 500) { size = Math.floor(size / 5); L = await tl(b, Math.min(head, b + size - 1)); }
    if (L === null) return { traced: false };
    b += size;
    const T = L.map(dec).filter((x) => !zero.test(x.from));
    if (!T.length) continue;
    const rec = {};
    T.slice(0, 400).forEach((x) => { (rec[x.from] = rec[x.from] || new Set()).add(x.to); });
    const best = Object.keys(rec).sort((a, c) => rec[c].size - rec[a].size)[0];
    if (rec[best].size >= 2) { src = best; first = Math.min(...T.filter((x) => x.from === best).map((x) => x.blk)); }
  }
  if (!src) return { traced: false };
  // 2. everything the distributor sent in the first blocks of trading
  const W = await tl(first, Math.min(head, first + cfg.win), src);
  if (!W || !W.length) return { traced: false };
  const by = {}, tk = token.toLowerCase();
  for (const l of W) {
    const x = dec(l);
    if (x.to === src || DEAD.test(x.to) || zero.test(x.to) || x.to === tk) continue;
    (by[x.to] = by[x.to] || { first: x.blk }).first = Math.min(by[x.to].first, x.blk);
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
  return { traced: true, bundlers, snipers, firstBlock: first, source: src };
}
module.exports = { explorerEvm, evmLaunch, EXPLORER_CHAINS: Object.keys(CFG) };
