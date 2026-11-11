// Buy -> wallet transfer -> sell rehearsal for one token on one pool, done with a single eth_call.
// The call carries the creation code of contracts/CblTokenProbe.sol; its constructor runs the rehearsal against the
// live pool and returns the measurements. Nothing is deployed, signed or paid: every state change is rolled back.
// Works on Uniswap v4 (PoolManager and forks), v3 and v2 style pools on any EVM chain whose RPC allows eth_call without "to".
// Used for Elysium and Robinhood Chain, which GoPlus and honeypot.is do not cover.
const { AbiCoder, keccak256 } = require("ethers");
const INITCODE = require("./tokenprobe.json").bytecode;
const coder = AbiCoder.defaultAbiCoder();
const ZERO = "0x0000000000000000000000000000000000000000", MAGIC = 0xcb1cb1cb1n;
const KEY_T = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const RES_T = "tuple(uint256 magic,uint256 failAt,uint256 quoteIn,uint256 buyOut,uint256 buyGot,uint256 xferSent,uint256 xferGot,uint256 sellSent,uint256 sellPaid,uint256 quoteOut,bytes err)";
const STEP = { 1: "buy", 2: "receive", 3: "transfer", 4: "toPool", 5: "sell", 99: "noCallback" };

const poolId = (k) => keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
/** v4 pool ids hash the tick spacing too; indexers often omit it. Find the one that reproduces the id (common values first). */
function findTickSpacing(k, id) {
  const want = String(id).toLowerCase(), common = [60, 200, 10, 1, 100, 50, 20, 2, 5, 120, 400, 1000, 2000];
  for (const ts of common) if (poolId(Object.assign({}, k, { tickSpacing: ts })).toLowerCase() === want) return ts;
  for (let ts = 1; ts <= 32767; ts++) if (!common.includes(ts) && poolId(Object.assign({}, k, { tickSpacing: ts })).toLowerCase() === want) return ts;
  return null;
}
function callData(o) {
  const key = o.key || { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };
  return INITCODE + coder.encode(["uint8", "address", KEY_T, "address", "bool", "uint256"], [o.mode, o.pool, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], o.token, !!o.tokenIs0, BigInt(o.amount)]).slice(2);
}
function decode(hex) {
  if (typeof hex !== "string" || hex.length < 2 + 64 * 11) return null;
  try {
    const r = coder.decode([RES_T], hex)[0];
    if (r.magic !== MAGIC) return null;
    return { failAt: Number(r.failAt), quoteIn: r.quoteIn, buyOut: r.buyOut, buyGot: r.buyGot, xferSent: r.xferSent, xferGot: r.xferGot, sellSent: r.sellSent, sellPaid: r.sellPaid, quoteOut: r.quoteOut, err: r.err };
  } catch (e) { return null; }
}
// Revert text of a failed step, when it is a plain Error(string)
function errText(err) {
  try { if (typeof err === "string" && err.startsWith("0x08c379a0")) return String(coder.decode(["string"], "0x" + err.slice(10).padEnd(64 * 3, "0"))[0]).replace(/[^\x20-\x7e]/g, "").slice(0, 60); } catch (e) {}
  return null;
}
const pct = (lost, of) => (of > 0n ? Number((lost * 100000n) / of) / 1000 : null);
/** Turn raw measurements into findings. honeypot: true = selling fails, false = a full sell worked, null = could not tell. */
function interpret(r, mode) {
  if (!r) return null;
  const o = { mode, step: r.failAt ? STEP[r.failAt] || "unknown" : null, honeypot: null, reason: null, buyTax: null, sellTax: null, transferTax: null, poolCost: null, error: errText(r.err) };
  if (r.buyOut > 0n && r.buyGot > 0n) o.buyTax = pct(r.buyOut - (r.buyGot > r.buyOut ? r.buyOut : r.buyGot), r.buyOut);
  if (r.xferSent > 0n && r.failAt !== 3) o.transferTax = pct(r.xferSent - (r.xferGot > r.xferSent ? r.xferSent : r.xferGot), r.xferSent);
  if (r.sellSent > 0n && r.sellPaid > 0n) o.sellTax = pct(r.sellSent - (r.sellPaid > r.sellSent ? r.sellSent : r.sellPaid), r.sellSent);
  // v4 only: what a buy plus a sell costs in the pool itself (pool fee twice, hook fees, price impact), with the token's own
  // taxes and the part set aside for the wallet transfer taken out: quote back per token sold vs quote paid per token bought.
  if (mode === 4 && r.quoteIn > 0n && r.quoteOut > 0n && r.sellPaid > 0n && r.buyOut > 0n) {
    const back = r.quoteOut * r.buyOut, paid = r.quoteIn * r.sellPaid;
    o.poolCost = pct(paid - (back > paid ? paid : back), paid);
  }
  if (r.failAt === 4) { o.honeypot = true; o.reason = "Tokens could not be sent to the pool in a test sale" + (o.error ? ` ("${o.error}")` : ""); }
  else if (r.failAt === 5) { o.honeypot = true; o.reason = "The pool rejected a test sale" + (o.error ? ` ("${o.error}")` : ""); }
  else if (r.failAt === 0) o.honeypot = false;
  // failAt 1 / 2 (could not buy) and 3 (wallet transfer refused) say nothing certain about selling: left as null for the caller to word
  return o;
}
async function ethCall(rpc, data, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 5000);
  try {
    const r = await fetch(rpc, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ data }, "latest"] }) });
    const j = await r.json().catch(() => null);
    if (j && typeof j.result === "string") return { hex: j.result };
    return { hex: null, error: j && j.error ? String(j.error.message || "").slice(0, 120) : "http " + r.status };
  } catch (e) { return { hex: null, error: String((e && e.message) || e).slice(0, 80) }; } finally { clearTimeout(t); }
}
/** One rehearsal. o: { mode: 4|3|2, pool, key?, token, tokenIs0, amount }. Returns { raw, findings } or { error }. */
async function probe(rpc, o, ms) {
  const res = await ethCall(rpc, callData(o), ms), raw = decode(res.hex);
  if (!raw) return { error: res.error || "no measurements returned", findings: null };
  return { raw, findings: interpret(raw, o.mode) };
}
async function rpcCall(rpc, to, data) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
  try { const r = await fetch(rpc, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) }); const j = await r.json().catch(() => null); return j && typeof j.result === "string" ? j.result : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
/**
 * Rehearsal on the pair a scan already picked. o: { rpc, token, pair (DexScreener pair), wnative?, pools? }.
 * pools = [{ pool, version, dex, token0, token1, fee, hooks }] from an indexer; needed for v4 pools (their id is a hash of the pool key).
 * Returns { findings, pool } or { findings: null, why }.
 */
async function probePair(o) {
  const low = String(o.token).toLowerCase(), pair = o.pair, wn = o.wnative ? String(o.wnative).toLowerCase() : null;
  if (!pair || !pair.pairAddress) return { findings: null, why: "no pool" };
  const id = String(pair.pairAddress).toLowerCase(), labels = (pair.labels || []).map((x) => String(x).toLowerCase());
  const decimals = async (a) => { if (!a || a === ZERO || a === wn) return 18; const h = await rpcCall(o.rpc, a, "0x313ce567"); const n = h && h.length > 2 ? parseInt(h, 16) : NaN; return n >= 0 && n <= 36 ? n : null; };
  const units = (x, dec) => (x > 0 && Number.isFinite(x) ? (BigInt(Math.max(1, Math.floor(x * 1e9))) * 10n ** BigInt(dec)) / 1000000000n : 0n);
  // about $1 of the quote token, less on thin pools so the rehearsal itself barely moves the price
  const liq = Number(pair.liquidity && pair.liquidity.usd) || 0, usd = Math.min(1, Math.max(0.05, liq / 2000));
  const priceUsd = parseFloat(pair.priceUsd), priceNative = parseFloat(pair.priceNative), quoteUsd = priceUsd > 0 && priceNative > 0 ? priceUsd / priceNative : null;
  const known = (o.pools || []).find((p) => String(p.pool || "").toLowerCase() === id);
  if (id.length === 66) { // Uniswap v4 style
    if (!known) return { findings: null, why: "pool key unknown" };
    const k = { currency0: String(known.token0).toLowerCase(), currency1: String(known.token1).toLowerCase(), fee: Number(known.fee), hooks: String(known.hooks || ZERO).toLowerCase() };
    if (![k.currency0, k.currency1].includes(low)) return { findings: null, why: "pool does not hold this token" };
    k.tickSpacing = findTickSpacing(k, id);
    if (k.tickSpacing === null) return { findings: null, why: "pool key does not match its id" };
    const quote = k.currency0 === low ? k.currency1 : k.currency0, dec = await decimals(quote);
    if (dec === null || !quoteUsd) return { findings: null, why: "quote price unknown" };
    const r = await probe(o.rpc, { mode: 4, pool: String(known.dex).toLowerCase(), key: k, token: low, tokenIs0: k.currency0 === low, amount: units(usd / quoteUsd, dec) }, 5000);
    return { findings: r.findings, why: r.error, pool: { version: "v4", id, manager: String(known.dex).toLowerCase(), hooks: k.hooks !== ZERO } };
  }
  if (id.length !== 42) return { findings: null, why: "unknown pool type" };
  const quote = String((pair.quoteToken && pair.quoteToken.address) || "").toLowerCase(), q = /^0x[0-9a-f]{40}$/.test(quote) && quote !== ZERO ? quote : wn;
  if (!q || q === low) return { findings: null, why: "quote token unknown" };
  const tokenIs0 = BigInt(low) < BigInt(q), ver = labels.includes("v2") ? "v2" : labels.includes("v3") ? "v3" : known && /^v[23]$/.test(String(known.version)) ? known.version : null;
  const v3 = async () => { const dec = await decimals(q); if (dec === null || !quoteUsd) return { findings: null, error: "quote price unknown" }; return probe(o.rpc, { mode: 3, pool: id, token: low, tokenIs0, amount: units(usd / quoteUsd, dec) }, 5000); };
  const v2 = async () => { const dec = await decimals(low); if (dec === null || !(priceUsd > 0)) return { findings: null, error: "token price unknown" }; return probe(o.rpc, { mode: 2, pool: id, token: low, tokenIs0, amount: units(usd / priceUsd, dec) }, 5000); };
  let r = ver === "v2" ? await v2() : await v3(), used = ver === "v2" ? "v2" : "v3";
  if (!r.findings && !ver) { r = await v2(); used = "v2"; } // unlabelled pool: a v2 pair does not answer a v3 swap
  return { findings: r.findings, why: r.error, pool: { version: used, address: id } };
}
/** Self test on any chain DexScreener covers: the token's deepest pair there, then the rehearsal. */
async function diagPair(dsChain, rpc, token) {
  const t = String(token || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return { error: "add &probe=<token address>" };
  let pairs = [];
  try { const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + t, { headers: { accept: "application/json" } }); pairs = ((await r.json()) || {}).pairs || []; } catch (e) {}
  const pair = pairs.filter((p) => p.chainId === dsChain && String(p.baseToken && p.baseToken.address).toLowerCase() === t).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
  if (!pair) return { token: t, error: "no pair for this token on " + dsChain + " at DexScreener" };
  const t0 = Date.now(), r = await probePair({ rpc, token: t, pair }).catch((e) => ({ findings: null, why: String(e && e.message).slice(0, 120) }));
  return { token: t, symbol: pair.baseToken.symbol, pair: { id: pair.pairAddress, dex: pair.dexId, labels: pair.labels || [], quote: pair.quoteToken && pair.quoteToken.symbol, liquidityUsd: pair.liquidity && pair.liquidity.usd }, ms: Date.now() - t0, pool: r.pool || null, findings: r.findings, why: r.findings ? undefined : r.why };
}
module.exports = { probe, probePair, diagPair, callData, decode, interpret, poolId, findTickSpacing, ZERO };
