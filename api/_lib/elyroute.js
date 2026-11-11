// Elysium trading for CBL Bartender: finds a route for a token and trades it through the CBL swap router
// (contracts/CblSwapRouter.sol, deployed once; its address goes in ELYSIUM_ROUTER).
//   Route = the token's deepest pools on DexScreener (Uniswap v4 and forks, v3 style, v2 style). A pool quoted in another
//   token (KNTQ, USDC, ...) gets a first hop from HYPE into that token. Every candidate is quoted with a static call from
//   the user's own wallet and the best one is used, so a route that cannot work is never sent.
//   Fee: taken by the router inside the same transaction (HYPE in on buys, HYPE out on sells).
const ELY = require("./elysium"), P = require("./tokenprobe");

const ZERO = P.ZERO, WHYPE = ELY.WHYPE.toLowerCase();
const HOP = "tuple(uint8 kind,address pool,address tokenIn,address tokenOut,uint24 fee,int24 tickSpacing,address hooks)[]";
const ABI = [
  `function buy(${HOP} hops,uint256 minOut,address to,uint256 deadline,uint256 feeBps) payable returns (uint256)`,
  `function sell(${HOP} hops,uint256 amountIn,uint256 minOut,address to,uint256 deadline,uint256 feeBps) returns (uint256)`,
  "function WNATIVE() view returns (address)", "function feeRecipient() view returns (address)",
];
const ERC = ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const router = () => { const a = String(process.env.ELYSIUM_ROUTER || "").trim().replace(/^["']|["']$/g, ""); return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null; };
const on = () => !!router();
const isNative = (a) => a === ZERO || a === WHYPE;
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

async function dsPairs(token) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 6000);
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + token, { signal: c.signal, headers: { accept: "application/json" } }), j = r.ok ? await r.json().catch(() => null) : null;
    return ((j && j.pairs) || []).filter((p) => p.chainId === ELY.KEY && p.pairAddress).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  } catch (e) { return []; } finally { clearTimeout(t); }
}
// Ways to swap `from` -> `to` on one DexScreener pair. Empty when the pair cannot be used (unknown v4 key, wrong tokens).
function hopsFor(pair, from, to, pools) {
  const id = String(pair.pairAddress).toLowerCase(), labels = (pair.labels || []).map((x) => String(x).toLowerCase());
  const known = (pools || []).find((p) => String(p.pool || "").toLowerCase() === id);
  if (id.length === 66) {
    if (!known) return [];
    const c0 = String(known.token0).toLowerCase(), c1 = String(known.token1).toLowerCase(), k = { currency0: c0, currency1: c1, fee: Number(known.fee), hooks: String(known.hooks || ZERO).toLowerCase() };
    // the pool's own currencies decide: its native side is address(0), never the wrapper
    const a = isNative(from) ? (c0 === ZERO ? ZERO : c0 === WHYPE || c1 === WHYPE ? WHYPE : null) : from, b = isNative(to) ? (c0 === ZERO ? ZERO : c0 === WHYPE || c1 === WHYPE ? WHYPE : null) : to;
    if (a === null || b === null || ![c0, c1].includes(a) || ![c0, c1].includes(b) || a === b) return [];
    const ts = P.findTickSpacing(k, id); if (ts === null) return [];
    return [{ kind: 4, pool: String(known.dex).toLowerCase(), tokenIn: a, tokenOut: b, fee: k.fee, tickSpacing: ts, hooks: k.hooks }];
  }
  if (id.length !== 42) return [];
  const pb = String(pair.baseToken && pair.baseToken.address).toLowerCase(), pq = String(pair.quoteToken && pair.quoteToken.address).toLowerCase();
  const side = (x) => (x === ZERO ? WHYPE : x), a = isNative(from) ? WHYPE : from, b = isNative(to) ? WHYPE : to;
  if (![side(pb), side(pq)].includes(a) || ![side(pb), side(pq)].includes(b) || a === b) return [];
  const mk = (kind, fee) => ({ kind, pool: id, tokenIn: a, tokenOut: b, fee, tickSpacing: 0, hooks: ZERO });
  const ver = labels.includes("v2") ? 2 : labels.includes("v3") ? 3 : known && String(known.version) === "v2" ? 2 : known && String(known.version) === "v3" ? 3 : 0;
  const v2 = [mk(2, 0), mk(2, 10000)]; // 0.3% pairs first, then 1% forks; the static call tells which one the pair accepts
  return ver === 2 ? v2 : ver === 3 ? [mk(3, 0)] : [mk(3, 0)].concat(v2);
}
const flip = (hops) => hops.slice().reverse().map((h) => Object.assign({}, h, { tokenIn: h.tokenOut, tokenOut: h.tokenIn }));
const tuple = (hops) => hops.map((h) => [h.kind, h.pool, h.tokenIn, h.tokenOut, h.fee, h.tickSpacing, h.hooks]);
const verName = (h) => (h.kind === 4 ? "v4" : h.kind === 3 ? "v3" : "v2");

/** Candidate routes HYPE -> token, best pools first. Each: { buy: hops, sell: hops, label, pair }. */
async function routes(token) {
  const t = String(token).toLowerCase();
  const [pairs, idx] = await Promise.all([dsPairs(t), ELY.indexToken(t).catch(() => null)]);
  const pools = (idx && idx.pools) || [], out = [], conn = new Map();
  for (const pair of pairs.slice(0, 4)) {
    const id = String(pair.pairAddress).toLowerCase(), known = pools.find((p) => String(p.pool || "").toLowerCase() === id);
    const pb = String(pair.baseToken && pair.baseToken.address).toLowerCase(), pq = String(pair.quoteToken && pair.quoteToken.address).toLowerCase();
    let other = id.length === 66 ? (known ? (String(known.token0).toLowerCase() === t ? String(known.token1).toLowerCase() : String(known.token0).toLowerCase()) : null) : pb === t ? pq : pb;
    if (other === null || !isAddr(other) || other === t) continue;
    const dex = String(pair.dexId || "pool").replace(/^0x.*/, "pool"), sym = pb === t ? pair.quoteToken && pair.quoteToken.symbol : pair.baseToken && pair.baseToken.symbol;
    if (isNative(other)) {
      for (const h of hopsFor(pair, ZERO, t, pools)) out.push({ buy: [h], sell: flip([h]), label: `${dex} ${verName(h)}`, pair });
      continue;
    }
    // quoted in another token: first hop HYPE -> that token, on its own deepest HYPE pools
    if (!conn.has(other)) {
      const [cp, ci] = await Promise.all([dsPairs(other), ELY.indexToken(other).catch(() => null)]), cpools = (ci && ci.pools) || [], list = [];
      for (const p2 of cp.slice(0, 6)) { const hs = hopsFor(p2, ZERO, other, cpools); if (hs.length) list.push(hs); if (list.length >= 2) break; }
      conn.set(other, list);
    }
    const second = hopsFor(pair, other, t, pools);
    for (const firsts of conn.get(other)) for (const h1 of firsts) for (const h2 of second) out.push({ buy: [h1, h2], sell: flip([h1, h2]), label: `${dex} ${verName(h2)} via ${sym || "another token"}`, pair });
  }
  return { list: out.slice(0, 8), pools, pairs };
}

const deadline = () => Math.floor(Date.now() / 1000) + 300;
async function best(list, quote) {
  const res = await Promise.all(list.map((c) => quote(c).then((out) => ({ c, out }), () => null)));
  return res.filter((x) => x && x.out > 0n).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))[0] || null;
}

/**
 * Buy with `value` wei of HYPE (fee included). o: { ethers, signer, me, token, value, slipBps, feeBps, gas, fail, checkImpact }.
 * Returns { tx, route, out } once the transaction is sent.
 */
async function buy(o) {
  const e = o.ethers, R = new e.Contract(router(), ABI, o.signer), found = await routes(o.token);
  if (!found.list.length) o.fail("No tradable pool found for this token on Elysium yet.");
  const pick = await best(found.list, (c) => R.buy.staticCall(tuple(c.buy), 0, o.me, deadline(), o.feeBps, { value: o.value }));
  if (!pick) o.fail("This token cannot be bought right now: every route failed in a test run. The pool may be paused, empty or restricted.");
  // a test sale on the same pool first: do not buy what cannot be sold
  const pr = await P.probePair({ rpc: ELY.rpc(), token: o.token, pair: pick.c.pair, wnative: WHYPE, pools: found.pools }).catch(() => null);
  if (pr && pr.findings && pr.findings.honeypot === true) o.fail("Buy blocked: a test sale of this token failed, so you could not sell it afterwards (honeypot).");
  // price impact: compare with the rate for a 50x smaller buy
  const small = o.value / 50n;
  if (small > 0n && o.checkImpact) {
    const s = await R.buy.staticCall(tuple(pick.c.buy), 0, o.me, deadline(), o.feeBps, { value: small }).catch(() => 0n);
    if (s > 0n) o.checkImpact(Math.max(0, 100 - Number((pick.out * small * 100000n) / (s * o.value)) / 1000));
  }
  const min = (pick.out * (10000n - o.slipBps)) / 10000n;
  const tx = await R.buy(tuple(pick.c.buy), min, o.me, deadline(), o.feeBps, Object.assign({ value: o.value }, o.gas || {}));
  return { tx, route: pick.c.label, out: pick.out };
}

/**
 * Sell `amount` (raw units) of the token for HYPE. o: { ethers, signer, me, token, amount, slipBps, feeBps, gas, fail, checkImpact, wait }.
 * Returns { tx, route, out (HYPE the user receives, after the fee), fee }.
 */
async function sell(o) {
  const e = o.ethers, addr = router(), R = new e.Contract(addr, ABI, o.signer), T = new e.Contract(o.token, ERC, o.signer), found = await routes(o.token);
  if (!found.list.length) o.fail("No tradable pool found for this token on Elysium.");
  if ((await T.allowance(o.me, addr)) < o.amount) await o.wait(await T.approve(addr, e.MaxUint256, o.gas || {}));
  const pick = await best(found.list, (c) => R.sell.staticCall(tuple(c.sell), o.amount, 0, o.me, deadline(), o.feeBps));
  if (!pick) o.fail("This token cannot be sold right now: every route failed in a test run. If this keeps happening the token may block sells.");
  const small = o.amount / 50n;
  if (small > 0n && o.checkImpact) {
    const s = await R.sell.staticCall(tuple(pick.c.sell), small, 0, o.me, deadline(), o.feeBps).catch(() => 0n);
    if (s > 0n) o.checkImpact(Math.max(0, 100 - Number((pick.out * small * 100000n) / (s * o.amount)) / 1000));
  }
  const min = (pick.out * (10000n - o.slipBps)) / 10000n, fb = BigInt(o.feeBps);
  const tx = await R.sell(tuple(pick.c.sell), o.amount, min, o.me, deadline(), o.feeBps, o.gas || {});
  return { tx, route: pick.c.label, out: pick.out, fee: fb > 0n && fb < 10000n ? (pick.out * fb) / (10000n - fb) : 0n };
}

/** Health check for /api/scan?chaindiag=elysium: is the router set, deployed, and wired to the right wrapper? */
async function diag(ethers) {
  const addr = router();
  if (!addr) {
    const sym = await new ethers.Contract(WHYPE, ["function symbol() view returns (string)"], new ethers.JsonRpcProvider(ELY.rpc(), ELY.ID, { staticNetwork: true })).symbol().catch(() => null);
    return { configured: false, wrapper: WHYPE, wrapperSymbol: sym, hint: "Set ELYSIUM_ROUTER to the deployed CblSwapRouter address to switch Elysium trading on (contracts/DEPLOY.md)." };
  }
  try {
    const p = new ethers.JsonRpcProvider(ELY.rpc(), ELY.ID, { staticNetwork: true }), R = new ethers.Contract(addr, ABI, p);
    const [code, wn, to, sym] = await Promise.all([p.getCode(addr), R.WNATIVE().catch(() => null), R.feeRecipient().catch(() => null), new ethers.Contract(WHYPE, ["function symbol() view returns (string)"], p).symbol().catch(() => null)]);
    return { configured: true, router: addr, deployed: code.length > 2, wrapperOk: !!wn && wn.toLowerCase() === WHYPE, wrapper: WHYPE, wrapperSymbol: sym, feeRecipient: to };
  } catch (err) { return { configured: true, router: addr, error: String(err && err.message).slice(0, 120) }; }
}

module.exports = { on, router, routes, buy, sell, diag, hopsFor, flip, tuple, ABI };
