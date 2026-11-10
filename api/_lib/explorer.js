// On-chain fallback for EVM chains where GoPlus has no coverage (e.g. Robinhood Chain, Elysium): Blockscout API + RPC.
const ELY = require("./elysium");
const CFG = {
  robinhood: { api: "https://robinhoodchain.blockscout.com/api/v2", rpc: "https://rpc.mainnet.chain.robinhood.com", win: 50, bwin: 20, fan: 20000, chunk: 20000 },
  // Elysium: ~100 ms blocks, so the windows are wider in blocks (sniper window ~10 s, same-moment bundle ~3 s).
  // The Blockscout API host and the RPC come from ./elysium (env overrides); logMax = the RPC's eth_getLogs block span.
  elysium: { api: null, rpc: ELY.PUBLIC_RPC, win: 100, bwin: 30, fan: 20000, chunk: 2000, logMax: 2000, dynamic: true },
};
// Per-call settings. Elysium's explorer API is resolved at run time and may be missing: everything then runs on the RPC alone.
async function conf(chain) {
  const c = CFG[chain]; if (!c) return null;
  if (!c.dynamic) return c;
  const n = ELY.logRange();
  return Object.assign({}, c, { api: await ELY.blockscoutApi().catch(() => null), rpc: ELY.rpc(), chunk: n, logMax: n });
}
const DEAD = /^0x(0{40}|0{39}1|[0d]*dead[0-9a-f]*)$/i;
const NET = [];
const get = async (u, opt = {}) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
  const h = Object.assign({ accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; CBLScanner/1.0; +https://cryptobarlounge.space)" }, opt.headers || {});
  try { const r = await fetch(u, Object.assign({}, opt, { signal: c.signal, headers: h })); if (!r.ok) { NET.push(new URL(u).host + " HTTP " + r.status); return null; } return await r.json(); }
  catch (e) { NET.push(new URL(u).host + " " + String((e && e.cause && e.cause.code) || (e && e.message) || e).slice(0, 60)); return null; } finally { clearTimeout(t); }
};
const bs = (cfg, path) => (cfg.api ? get(cfg.api + path) : Promise.resolve(null));
// ABI-encoded string (or bytes32) returned by name()/symbol()
function abiStr(h) {
  if (typeof h !== "string" || h.length < 4) return null;
  try {
    const b = Buffer.from(h.slice(2), "hex"); let out;
    if (b.length >= 96 && Number(BigInt("0x" + b.subarray(0, 32).toString("hex"))) === 32) { const n = Number(BigInt("0x" + b.subarray(32, 64).toString("hex"))); out = b.subarray(64, 64 + Math.min(n, 128)); }
    else out = b.subarray(0, 32);
    const t = out.toString("utf8").replace(/\u0000+$/g, "").replace(/[^\x20-\x7e\u00a0-\uffff]/g, "").trim();
    return t ? t.slice(0, 64) : null;
  } catch (e) { return null; }
}
const rpc = (cfg, to, data) => get(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) }).then((r) => r && r.result);

async function explorerEvm(chain, addr, pairAddr) {
  const cfg = await conf(chain); if (!cfg) return null;
  NET.length = 0;
  // Elysium without a Blockscout API: token facts and holders from the opsis indexer, mapped to Blockscout's shape.
  // If the indexer gives no holder list, Kinetiq's explorer API is tried (same item shape; it often refuses servers).
  const kin = !!cfg.dynamic && !cfg.api;
  let tok, ad, hold, own, kinCount = null, idx = null;
  if (kin) {
    let ih; [idx, ih, own] = await Promise.all([ELY.indexToken(addr).catch(() => null), ELY.indexHolders(addr).catch(() => null), rpc(cfg, addr, "0x8da5cb5b")]);
    tok = idx && idx.supply ? { name: idx.name, symbol: idx.symbol, holders_count: idx.holders, total_supply: idx.supply } : null;
    ad = idx && (idx.creator || idx.creationTx) ? { creator_address_hash: idx.creator || "", creation_transaction_hash: idx.creationTx } : null;
    hold = ih;
    if (!hold) [hold, kinCount] = await Promise.all([ELY.holders(addr).catch(() => null), idx && idx.holders ? null : ELY.holderCount(addr).catch(() => null)]);
  } else {
    [tok, ad, hold, own] = await Promise.all([bs(cfg, `/tokens/${addr}`), bs(cfg, `/addresses/${addr}`), bs(cfg, `/tokens/${addr}/holders`), rpc(cfg, addr, "0x8da5cb5b")]);
  }
  // No explorer answer (down, or its API host isn't configured): name, symbol and supply straight from the token contract.
  let chainTok = null;
  if (!tok) {
    const [nm, sy, ts] = await Promise.all([rpc(cfg, addr, "0x06fdde03"), rpc(cfg, addr, "0x95d89b41"), rpc(cfg, addr, "0x18160ddd")]);
    const sup = typeof ts === "string" && ts.length > 2 ? parseInt(ts, 16) : 0;
    if (sup > 0 || abiStr(sy)) chainTok = { name: abiStr(nm), symbol: abiStr(sy), supply: sup > 0 ? sup : null };
  }
  if (!tok && !ad && !hold && !own && !chainTok) return null;
  const out = { holders: null, verified: null, proxy: null, creator: null, creationTx: null, creatorPct: null, top1: null, top5: null, top10: null, owner: undefined, ownerKnown: false };
  if (tok && tok.holders_count != null) out.holders = parseInt(tok.holders_count, 10) || null;
  else if (kinCount) out.holders = kinCount;
  if (tok) { out.name = tok.name || null; out.symbol = tok.symbol || null; }
  else if (chainTok) { out.name = chainTok.name; out.symbol = chainTok.symbol; out.rpcOnly = true; }
  if (idx && idx.pad) out.pad = idx.pad;
  if (ad) {
    if (typeof ad.is_verified === "boolean") out.verified = ad.is_verified;
    out.proxy = kin ? null : !!(ad.proxy_type || (ad.implementations && ad.implementations.length));
    out.creator = (ad.creator_address_hash || "").toLowerCase() || null;
    out.creationTx = ad.creation_transaction_hash || ad.creation_tx_hash || null;
  }
  if (typeof own === "string" && /^0x[0-9a-f]{64}$/i.test(own)) { out.ownerKnown = true; out.owner = "0x" + own.slice(26).toLowerCase(); }
  const supply = tok ? parseFloat(tok.total_supply) : chainTok && chainTok.supply;
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
      pct.push(p); (out.topList = out.topList || []).push({ a, p });
    }
    pct.sort((x, y) => y - x); if (out.topList) out.topList.sort((x, y) => y.p - x.p);
    if (pct.length) { out.top1 = pct[0]; out.top5 = pct.slice(0, 5).reduce((x, y) => x + y, 0); out.top10 = pct.slice(0, 10).reduce((x, y) => x + y, 0); }
    if (out.creator && out.creatorPct === null && items.length >= 50) out.creatorPct = 0;
  }
  if (out.top10 === null && idx && idx.top10Share !== null) out.top10 = idx.top10Share; // no holder list: the indexer's own top-10 figure
  return out;
}

// Snipers and bundlers from Transfer logs out of the pair/pool, starting at the block where trading began.
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const rpcCall = (cfg, method, params) => get(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => (r && r.result !== undefined ? r.result : null));
const logs = (cfg, token, pair, from, to) => rpcCall(cfg, "eth_getLogs", [{ address: token, topics: [TRANSFER, pad(pair)], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);

/** Which of these addresses are contracts (eth_getCode, batches of 50). */
async function codeSet(cfg, addrs) {
  const out = new Set();
  for (let i = 0; i < addrs.length; i += 50) {
    const part = addrs.slice(i, i + 50);
    const r = await get(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part.map((a, k) => ({ jsonrpc: "2.0", id: k, method: "eth_getCode", params: [a, "latest"] }))) });
    if (!Array.isArray(r)) out.failed = true; // no answer: callers must not read "not in the set" as "is a wallet"
    (Array.isArray(r) ? r : []).forEach((x) => { if (x && typeof x.result === "string" && x.result.length > 2 && part[x.id]) out.add(part[x.id]); else if (!x || typeof x.result !== "string") out.failed = true; });
  }
  return out;
}
async function evmLaunch(chain, token, pairCreatedMs, supply, creationTx, budgetMs = 9000) {
  const cfg = await conf(chain); if (!cfg) return null;
  const dbg = { supply: supply || null, creationTx: creationTx || null }, fail = (why) => ({ traced: false, dbg: Object.assign(dbg, { why }) });
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const origin = cfg.api ? cfg.api.replace(/\/api\/v2$/, "") : null;
  let start = 0;
  if (creationTx) { const tx = await bs(cfg, `/transactions/${creationTx}`); start = parseInt((tx && (tx.block_number != null ? tx.block_number : tx.block)) || 0, 10); }
  if (!(start > 0) && creationTx) { const tx = await rpcCall(cfg, "eth_getTransactionByHash", [creationTx]); start = parseInt((tx && tx.blockNumber) || "0x0", 16) || 0; if (start > 0) dbg.startFrom = "tx"; }
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
  if (!(start > 0) && pairCreatedMs && origin) {
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
  const cap = cfg.logMax || 100000; // some RPCs only answer eth_getLogs over a short block span
  let sz = Math.min(100000, cap);
  for (let b = start; b <= head && left() > 2500;) {
    let L = await tl(b, Math.min(head, b + sz - 1), src);
    if (L === null && sz > 10000) { sz = Math.min(20000, cap); L = await tl(b, Math.min(head, b + sz - 1), src); }
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
  // span = how many blocks after launch count. Pool buyers: only the launch window (a bot that keeps buying and selling
  // would otherwise have the same tokens counted again and again). Distributions: the longer fan-out window.
  const boughtOf = (ws, span) => { const set = new Set(ws); let t = 0; sends.concat(chunkT.filter((x) => x.from !== src)).forEach((x) => { if (set.has(x.to) && x.blk >= launch && x.blk - launch <= span) t += x.amt; }); return supply > 0 ? (t / supply) * 100 : null; };
  const all = Object.keys(by), same = all.filter((a) => by[a].first - launch <= (cfg.bwin || 0));
  // Bundle = one wallet that received tokens at launch and immediately fanned them out to many fresh wallets
  const got = {}; // wallets that received tokens (from the distributor or a mint) -> block
  chunkAll.concat(sends).forEach((x) => { if (got[x.to] === undefined || x.blk < got[x.to]) got[x.to] = x.blk; });
  const fan = {};
  chunkT.forEach((x) => { if (x.from === src || x.blk - first > cfg.fan || x.to === src || DEAD.test(x.to) || x.to === tk || zero.test(x.to)) return; (fan[x.from] = fan[x.from] || { to: new Set(), amt: 0 }); fan[x.from].to.add(x.to); fan[x.from].amt += x.amt; });
  const fans = Object.keys(fan).filter((a) => fan[a].to.size >= 5).sort((a, c) => fan[c].amt - fan[a].amt);
  dbg.fanOut = fans.slice(0, 4).map((a) => a.slice(0, 8) + ":" + fan[a].to.size + ":" + (supply > 0 ? ((fan[a].amt / supply) * 100).toFixed(1) : "?") + "%");
  // Contracts are not buyers: routers, pool managers, lockers and launchpad contracts receive and fan out tokens at launch too.
  const fansTop = fans.slice(0, 4);
  const isC = await codeSet(cfg, [...new Set([src].concat(fansTop, ...fansTop.map((a) => Array.from(fan[a].to)), all))].slice(0, 200)).catch(() => Object.assign(new Set(), { failed: true }));
  dbg.contractsSkipped = isC.size;
  // The distributor is normally a pool or launchpad contract (its recipients are buyers). When it is a plain wallet,
  // the "buyers" are wallets it handed supply to: a distribution, with no snipers to speak of.
  const srcWallet = !isC.failed && !isC.has(src);
  dbg.sourceIsWallet = srcWallet;
  const fanPick = fansTop.find((a) => !isC.has(a)), sameW = same.filter((a) => !isC.has(a)), allW = all.filter((a) => !isC.has(a));
  let bundle = fanPick ? Array.from(fan[fanPick].to).filter((a) => a !== src && !isC.has(a)).slice(0, 60) : srcWallet ? (allW.length >= 2 ? allW.slice(0, 60) : []) : (sameW.length >= 2 ? sameW : []);
  const distribution = !!fanPick || (srcWallet && bundle.length > 0);
  const snipe = srcWallet && !fanPick ? [] : all.filter((a) => !bundle.includes(a) && !isC.has(a));
  const grp = async (ws, span) => {
    if (!ws.length) return null;
    const sel = ws.slice(0, 40);
    const bal = await Promise.all(sel.map((a) => rpcCall(cfg, "eth_call", [{ to: token, data: "0x70a08231" + pad(a).slice(2) }, "latest"]).then((v) => (typeof v === "string" && v.length > 2 ? parseInt(v, 16) : 0)).catch(() => 0)));
    return { wallets: ws.length, boughtPct: boughtOf(ws, span), stillHolding: bal.filter((x) => x > 0).length, heldPct: (supply > 0 ? (bal.reduce((x, y) => x + y, 0) / supply) * 100 : null) };
  };
  const [bundlers, snipers] = await Promise.all([grp(bundle, distribution ? cfg.fan : cfg.win), grp(snipe, cfg.win)]);
  dbg.buyers = all.length; dbg.sameBlock = same.length;
  // diagnostics: first-time receivers from ANY sender (launchpads often fan out through helper contracts)
  const seen = {}, blkCount = {};
  chunkT.forEach((x) => { if (x.to === src || x.to === tk || DEAD.test(x.to) || zero.test(x.to) || seen[x.to] !== undefined) return; seen[x.to] = x.blk; });
  Object.values(seen).forEach((b) => { if (b - first <= 200) blkCount[b - first] = (blkCount[b - first] || 0) + 1; });
  dbg.anyRecv = Object.keys(seen).length;
  dbg.recvByBlockOffset = Object.entries(blkCount).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([k, v]) => k + ":" + v);
  // One wallet handing supply to many wallets at launch is a distribution, not pool buys: say so (the card and the score word it differently).
  if (bundlers) bundlers.kind = distribution ? "distribution" : "bundle";
  return { traced: true, bundlers, snipers, dbg };
}
module.exports = { explorerEvm, evmLaunch, NET, EXPLORER_CHAINS: Object.keys(CFG) };
