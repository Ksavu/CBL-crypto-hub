// On-chain fallback for EVM chains where GoPlus has no coverage (e.g. Robinhood Chain): Blockscout API + RPC.
const CFG = {
  robinhood: { api: "https://robinhoodchain.blockscout.com/api/v2", rpc: "https://rpc.mainnet.chain.robinhood.com", win: 50, bwin: 20, fan: 20000, chunk: 20000 },
};
const DEAD = /^0x(0{40}|0{39}1|[0d]*dead[0-9a-f]*)$/i;
const NET = [];
const get = async (u, opt = {}) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
  const h = Object.assign({ accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; CBLScanner/1.0; +https://cryptobarlounge.space)" }, opt.headers || {});
  try { const r = await fetch(u, Object.assign({}, opt, { signal: c.signal, headers: h })); if (!r.ok) { NET.push(new URL(u).host + " HTTP " + r.status); return null; } return await r.json(); }
  catch (e) { NET.push(new URL(u).host + " " + String((e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 60)); return null; } finally { clearTimeout(t); }
};
const rpc = (cfg, to, data) => get(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) }).then((r) => r && r.result);

async function explorerEvm(chain, addr, pairAddr) {
  const cfg = CFG[chain]; if (!cfg) return null;
  NET.length = 0;
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

async function evmLaunch(chain, token, pairCreatedMs, supply, creationTx, budgetMs = 9000) {
  const cfg = CFG[chain]; if (!cfg) return null;
  const dbg = { supply: supply || null, creationTx: creationTx || null }, fail = (why) => ({ traced: false, dbg: Object.assign(dbg, { why }) });
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const origin = cfg.api.replace(/\/api\/v2$/, "");
  let start = 0;
  if (creationTx) { const tx = await get(`${cfg.api}/transactions/${creationTx}`); start = parseInt((tx && (tx.block_number != null ? tx.block_number : tx.block)) || 0, 10); }
  if (!(start > 0)) {
    // deployment block straight from the node: first block where the token has code
    const hn = parseInt(await rpcCall(cfg, "eth_blockNumber", []), 16);
    const has = async (n) => { const c = await rpcCall(cfg, "eth_getCode", [token, "0x" + n.toString(16)]); return c === null ? null : c !== "0x" && c.length > 2; };
    if (hn > 0 && (await has(hn)) === true) {
      let lo = 1, hi = hn, ok = true;
      for (let i = 0; i < 40 && lo < hi; i++) { if (left() < 5000) { ok = false; break; } const mid = Math.floor((lo + hi) / 2), v = await has(mid); if (v === null) { ok = false; break; } if (v) hi = mid; else lo = mid + 1; }
      if (ok && lo > 1) { start = lo; dbg.startFrom = "code"; }
    }
  }
  if (!(start > 0) && pairCreatedMs) {
    const bt = await get(`${origin}/api?module=block&action=getblocknobytime&timestamp=${Math.floor(pairCreatedMs / 1000) - 120}&closest=after`);
    start = parseInt((bt && bt.result && (bt.result.blockNumber || bt.result)) || 0, 10);
  }
  dbg.start = start;
  if (!(start > 0) && pairCreatedMs) {
    // last resort: find the block by timestamp straight from the RPC (binary search)
    const ts = Math.floor(pairCreatedMs / 1000) - 120, hn = parseInt(await rpcCall(cfg, "eth_blockNumber", []), 16);
    if (hn > 0) {
      const tsOf = async (n) => { const b = await rpcCall(cfg, "eth_getBlockByNumber", ["0x" + n.toString(16), false]); return b ? parseInt(b.timestamp, 16) : null; };
      let lo = 1, hi = hn;
      for (let i = 0; i < 40 && lo < hi && left() > 6000; i++) { const mid = Math.floor((lo + hi) / 2), v = await tsOf(mid); if (v === null) break; if (v < ts) lo = mid + 1; else hi = mid; }
      if (lo > 1 && lo < hn) start = lo;
    }
  }
  if (!(supply > 0)) { const ts = await rpcCall(cfg, "eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]); const v = typeof ts === "string" && ts.length > 2 ? parseInt(ts, 16) : 0; if (v > 0) { supply = v; dbg.supply = v; } }
  dbg.start = start; dbg.net = NET.slice(0, 6);
  if (!(start > 0)) return fail("no start block (explorer and RPC unavailable)");
  const head = parseInt(await rpcCall(cfg, "eth_blockNumber", []), 16);
  dbg.head = head;
  const tl = (from, to, src) => rpcCall(cfg, "eth_getLogs", [{ address: token, topics: src ? [TRANSFER, pad(src)] : [TRANSFER], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  const dec = (l) => ({ from: "0x" + l.topics[1].slice(26).toLowerCase(), to: "0x" + l.topics[2].slice(26).toLowerCase(), blk: parseInt(l.blockNumber, 16), amt: Number(l.data && l.data.length > 2 ? parseInt(l.data, 16) : 0) || 0 });
  const zero = /^0x0{40}$/;
  // 1. find the first chunk with real (non-mint) transfers and pick the distributor: the address that sends to the most different wallets (pool, pair or launchpad contract)
  let src = null, first = null, size = cfg.chunk, chunkT = [], chunkAll = [];
  for (let b = start, n = 0; b <= head && n < 8 && left() > 4000 && !src; n++) {
    let L = await tl(b, Math.min(head, b + size - 1));
    if (L === null && size > 500) { size = Math.floor(size / 5); L = await tl(b, Math.min(head, b + size - 1)); }
    if (L === null) return fail("eth_getLogs failed on the RPC (range too large or blocked)");
    b += size; dbg.chunks = (dbg.chunks || 0) + 1; dbg.logs = (dbg.logs || 0) + L.length;
    const T = L.map(dec).filter((x) => !zero.test(x.from));
    if (!T.length) continue;
    const rec = {};
    T.slice(0, 400).forEach((x) => { (rec[x.from] = rec[x.from] || new Set()).add(x.to); });
    const best = Object.keys(rec).sort((a, c) => rec[c].size - rec[a].size)[0];
    if (rec[best].size >= 2) { chunkT = T; chunkAll = L.map(dec); dbg.senders = Object.keys(rec).sort((a, c) => rec[c].size - rec[a].size).slice(0, 4).map((k) => k.slice(0, 8) + ":" + rec[k].size); src = best; first = Math.min(...T.filter((x) => x.from === best).map((x) => x.blk)); }
  }
  if (!src) return fail("no distributor found in the first blocks");
  // 2. everything the distributor ever sent. Real "launch" = first burst of new buyers (a token can sit idle or have a few early buyers before trading starts)
  const sends = [];
  let sz = 100000;
  for (let b = start; b <= head && left() > 2500;) {
    let L = await tl(b, Math.min(head, b + sz - 1), src);
    if (L === null && sz > 10000) { sz = 20000; L = await tl(b, Math.min(head, b + sz - 1), src); }
    if (L === null) break;
    L.forEach((l) => sends.push(dec(l)));
    b += sz; dbg.sendChunks = (dbg.sendChunks || 0) + 1;
    if (sends.length > 20000) break;
  }
  if (!sends.length) return fail("no transfers from distributor");
  const tk = token.toLowerCase(), seenTo = {}, recs = [];
  sends.sort((a, c) => a.blk - c.blk);
  for (const x of sends) {
    if (x.to === src || DEAD.test(x.to) || zero.test(x.to) || x.to === tk || seenTo[x.to] !== undefined) continue;
    seenTo[x.to] = x.blk; recs.push({ to: x.to, blk: x.blk });
  }
  if (!recs.length) return fail("no recipients");
  const launch = first;
  dbg.source = src; dbg.firstBlock = first; dbg.launch = launch; dbg.launchOffset = launch - first; dbg.recipients = recs.length;
  const by = {};
  recs.forEach((r) => { if (r.blk >= launch && r.blk - launch <= cfg.win) by[r.to] = { first: r.blk }; });
  const boughtOf = (ws) => { const set = new Set(ws); let t = 0; sends.concat(chunkT).forEach((x) => { if (set.has(x.to) && x.blk >= launch && x.blk - launch <= cfg.fan) t += x.amt; }); return supply > 0 ? (t / supply) * 100 : null; };
  const all = Object.keys(by), same = all.filter((a) => by[a].first - launch <= (cfg.bwin || 0));
  // Bundle = one wallet that received tokens at launch and immediately fanned them out to many fresh wallets
  const got = {}; // wallets that received tokens (from the distributor or a mint) -> block
  chunkAll.concat(sends).forEach((x) => { if (got[x.to] === undefined || x.blk < got[x.to]) got[x.to] = x.blk; });
  const fan = {};
  chunkT.forEach((x) => { if (x.from === src || x.blk - first > cfg.fan || x.to === src || DEAD.test(x.to) || x.to === tk || zero.test(x.to)) return; (fan[x.from] = fan[x.from] || { to: new Set(), amt: 0 }); fan[x.from].to.add(x.to); fan[x.from].amt += x.amt; });
  const fans = Object.keys(fan).filter((a) => fan[a].to.size >= 5).sort((a, c) => fan[c].amt - fan[a].amt);
  dbg.fanOut = fans.slice(0, 4).map((a) => a.slice(0, 8) + ":" + fan[a].to.size + ":" + (supply > 0 ? ((fan[a].amt / supply) * 100).toFixed(1) : "?") + "%");
  let bundle = fans.length ? Array.from(fan[fans[0]].to).filter((a) => a !== src).slice(0, 60) : (same.length >= 2 ? same : []);
  const snipe = all.filter((a) => !bundle.includes(a));
  const grp = async (ws) => {
    if (!ws.length) return null;
    const sel = ws.slice(0, 40);
    const bal = await Promise.all(sel.map((a) => rpcCall(cfg, "eth_call", [{ to: token, data: "0x70a08231" + pad(a).slice(2) }, "latest"]).then((v) => (typeof v === "string" && v.length > 2 ? parseInt(v, 16) : 0)).catch(() => 0)));
    return { wallets: ws.length, boughtPct: boughtOf(ws), stillHolding: bal.filter((x) => x > 0).length, heldPct: (supply > 0 ? (bal.reduce((x, y) => x + y, 0) / supply) * 100 : null) };
  };
  const [bundlers, snipers] = await Promise.all([grp(bundle), grp(snipe)]);
  dbg.buyers = all.length; dbg.sameBlock = same.length;
  // diagnostics: first-time receivers from ANY sender (launchpads often fan out through helper contracts)
  const seen = {}, blkCount = {};
  chunkT.forEach((x) => { if (x.to === src || x.to === tk || DEAD.test(x.to) || zero.test(x.to) || seen[x.to] !== undefined) return; seen[x.to] = x.blk; });
  Object.values(seen).forEach((b) => { if (b - first <= 200) blkCount[b - first] = (blkCount[b - first] || 0) + 1; });
  dbg.anyRecv = Object.keys(seen).length;
  dbg.recvByBlockOffset = Object.entries(blkCount).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([k, v]) => k + ":" + v);
  return { traced: true, bundlers, snipers, dbg };
}
module.exports = { explorerEvm, evmLaunch, NET, EXPLORER_CHAINS: Object.keys(CFG) };
