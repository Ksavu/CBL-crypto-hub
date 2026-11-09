// CBL trading bot engine: custodial wallets per Telegram user, buy/sell/withdraw on Solana, BNB Chain, Base and Robinhood Chain.
//   Solana: Jupiter Swap V2 (order + execute, needs JUP_API_KEY) — covers pump.fun & other curves.
//   EVM: LI.FI quotes; Four.meme (BNB) and Pons (Robinhood) bonding-curve tokens trade on the launchpad contract directly.
//   Fee: BOT_FEE_BPS (default 100 = 1%), sent as a separate native transfer after a successful trade
//        to BOT_SOL_FEE_ACCOUNT (Solana) / BOT_EVM_FEE_ACCOUNT or EVM_FEE_ACCOUNT (EVM).
const db = require("./db");
const V = require("./vault");

const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const ZERO = "0x0000000000000000000000000000000000000000";
const CH = {
  s: { key: "solana", name: "Solana", nat: "SOL", dec: 9, presets: [0.1, 0.5, 1], reserve: 0.003, exp: "https://solscan.io/tx/" },
  b: { key: "bsc", name: "BNB Chain", id: 56, nat: "BNB", dec: 18, presets: [0.05, 0.1, 0.5], reserve: 0.0008, rpc: () => clean(process.env.BSC_RPC) || "https://bsc-dataseed.binance.org", exp: "https://bscscan.com/tx/" },
  e: { key: "base", name: "Base", id: 8453, nat: "ETH", dec: 18, presets: [0.01, 0.05, 0.1], reserve: 0.0002, rpc: () => clean(process.env.BASE_RPC) || "https://mainnet.base.org", exp: "https://basescan.org/tx/" },
  r: { key: "robinhood", name: "Robinhood", id: 4663, nat: "ETH", dec: 18, presets: [0.01, 0.05, 0.1], reserve: 0.0002, rpc: () => clean(process.env.ROBINHOOD_RPC) || "https://rpc.mainnet.chain.robinhood.com", exp: "https://robinhoodchain.blockscout.com/tx/" },
};
const CODE = { solana: "s", bsc: "b", base: "e", robinhood: "r" };
const feeBps = () => { const b = parseInt(clean(process.env.BOT_FEE_BPS) || "100", 10); return Number.isFinite(b) ? Math.min(Math.max(b, 0), 300) : 100; };
const feeTo = (c) => (c === "s" ? clean(process.env.BOT_SOL_FEE_ACCOUNT) : clean(process.env.BOT_EVM_FEE_ACCOUNT) || clean(process.env.EVM_FEE_ACCOUNT));
const on = () => V.on() && db.on();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class UserErr extends Error {}
const fail = (m) => { throw new UserErr(m); };

async function jfetch(u, opt, ms = 12000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, Object.assign({ signal: c.signal }, opt || {})); let d = null; try { d = await r.json(); } catch (e) {} return { ok: r.ok, s: r.status, d }; }
  catch (e) { return { ok: false, s: 0, d: null }; } finally { clearTimeout(t); }
}

// ---------- accounts ----------
async function getRow(uid) { return ((await db.select("bot_wallets", `tg_id=eq.${uid}&select=*`)) || [])[0] || null; }
async function ensure(uid) {
  const have = await getRow(uid); if (have) return { row: have, created: false };
  await db.insert("bot_wallets", [V.create(uid)], "tg_id");
  return { row: await getRow(uid), created: true };
}
// BonkBot-style settings (stored in bot_wallets.settings)
const DEFAULTS = { slipBuy: 10, slipSell: 10, maxImpact: 25, minPos: 0.5, sort: "val", autoBuy: false, autoAmt: { s: 0.1, b: 0.05, e: 0.01, r: 0.01 },
  presets: { s: [0.1, 0.5, 1], b: [0.05, 0.1, 0.5], e: [0.01, 0.05, 0.1], r: [0.01, 0.05, 0.1] }, sellP: [25, 50, 100], mev: true, prio: "fast", sellConfirm: true,
  autoTp: { on: false, pct: 100, sell: 50 }, autoSl: { on: false, pct: 30, sell: 100 }, bundle: false, bundleTip: 0.001 };
function settings(row) {
  const s = Object.assign({}, DEFAULTS, (row && row.settings) || {});
  if (row && row.settings && row.settings.slip && !row.settings.slipBuy) s.slipBuy = s.slipSell = row.settings.slip; // old single slippage
  s.presets = Object.assign({}, DEFAULTS.presets, s.presets || {}); s.autoAmt = Object.assign({}, DEFAULTS.autoAmt, s.autoAmt || {});
  s.autoTp = Object.assign({}, DEFAULTS.autoTp, s.autoTp || {}); s.autoSl = Object.assign({}, DEFAULTS.autoSl, s.autoSl || {});
  return s;
}
const PRIO = { normal: 100n, fast: 125n, turbo: 160n }; // EVM gas price multiplier (%)
const MEV_RPC = { b: () => clean(process.env.BSC_MEV_RPC) || "https://bscrpc.pancakeswap.finance" }; // PancakeSwap MEV Guard (private mempool)
async function saveSettings(uid, s) { await db.patch("bot_wallets", `tg_id=eq.${uid}`, { settings: s }); }
/** One trade at a time per user (Telegram may deliver taps in parallel). */
async function lock(uid) {
  const now = new Date().toISOString(), until = new Date(Date.now() + 70000).toISOString();
  const r = await fetch(clean(process.env.SUPABASE_URL).replace(/\/$/, "") + `/rest/v1/bot_wallets?tg_id=eq.${uid}&or=(busy_until.is.null,busy_until.lt.${encodeURIComponent(now)})`, {
    method: "PATCH", headers: dbHeaders({ Prefer: "return=representation" }), body: JSON.stringify({ busy_until: until }) }).then((x) => x.json()).catch(() => []);
  return Array.isArray(r) && r.length > 0;
}
const unlock = (uid) => db.patch("bot_wallets", `tg_id=eq.${uid}`, { busy_until: null }).catch(() => {});
function dbHeaders(extra) { const key = process.env.SUPABASE_SERVICE_KEY; return Object.assign({ apikey: key, "content-type": "application/json" }, key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}, extra || {}); }
async function record(t) { await db.insert("bot_trades", [t]).catch((e) => console.error("trade record", e.message)); }

// ---------- Solana ----------
const solRpcUrl = () => (clean(process.env.HELIUS_API_KEY) ? "https://mainnet.helius-rpc.com/?api-key=" + clean(process.env.HELIUS_API_KEY) : "https://api.mainnet-beta.solana.com");
async function srpc(method, params, ms) {
  const r = await jfetch(solRpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, ms || 10000);
  if (r.d && r.d.error) throw new Error(r.d.error.message || "Solana RPC error");
  return r.d ? r.d.result : undefined;
}
const solBal = async (a) => BigInt(((await srpc("getBalance", [a, { commitment: "confirmed" }])) || {}).value || 0);
async function solTokens(owner, mint) {
  const progs = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"], out = new Map();
  const res = await Promise.all(progs.map((p) => srpc("getTokenAccountsByOwner", [owner, mint ? { mint } : { programId: p }, { encoding: "jsonParsed", commitment: "confirmed" }]).catch(() => null)));
  for (const r of mint ? res.slice(0, 1) : res) for (const a of ((r && r.value) || [])) {
    const i = a.account.data.parsed.info, t = i.tokenAmount, prev = out.get(i.mint);
    const raw = BigInt(t.amount) + (prev ? prev.raw : 0n);
    out.set(i.mint, { mint: i.mint, raw, dec: t.decimals });
  }
  return [...out.values()].filter((x) => x.raw > 0n);
}
async function jup(path, opt) {
  const key = clean(process.env.JUP_API_KEY); if (!key) fail("Solana trading is not switched on yet (JUP_API_KEY).");
  const r = await jfetch("https://api.jup.ag/swap/v2" + path, Object.assign({}, opt, { headers: Object.assign({ "x-api-key": key, "content-type": "application/json" }, (opt && opt.headers) || {}) }), 25000);
  if (!r.d) fail("Jupiter did not answer. Try again.");
  if (!r.ok) fail(String(r.d.error || r.d.message || "Jupiter error").slice(0, 160));
  return r.d;
}
async function solSwap(row, inMint, outMint, amount, st) {
  const seed = V.solSeed(row);
  const o = await jup(`/order?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&taker=${row.sol_pub}`);
  if (!o.transaction) fail(o.errorMessage || "No route found for this token right now.");
  checkImpact(impactPct(o.inUsdValue, o.outUsdValue), st);
  const signed = V.solSignTx(o.transaction, seed);
  const x = await jup("/execute", { method: "POST", body: JSON.stringify({ signedTransaction: signed, requestId: o.requestId }) });
  if (x.status !== "Success") fail("Swap failed" + (x.error ? ": " + String(x.error).slice(0, 120) : "") + (x.signature ? `\n${CH.s.exp}${x.signature}` : ""));
  return { sig: x.signature, out: BigInt(x.outputAmountResult || o.outAmount || 0), inUsed: BigInt(x.inputAmountResult || amount) };
}
async function solSend(row, to, lamports) {
  const bh = (await srpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  const tx = V.solTransferTx(V.solSeed(row), to, lamports, bh);
  return srpc("sendTransaction", [tx, { encoding: "base64", preflightCommitment: "confirmed" }]);
}
async function solDecimals(mint) {
  const r = await srpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const d = r && r.value && r.value.data && r.value.data.parsed && r.value.data.parsed.info && r.value.data.parsed.info.decimals;
  if (typeof d !== "number") fail("That is not a Solana token address.");
  return d;
}

// ---------- EVM ----------
const provs = {};
function prov(c) { const e = V.ethers(); return (provs[c] = provs[c] || new e.JsonRpcProvider(CH[c].rpc(), CH[c].id, { staticNetwork: true })); }
const mevProvs = {};
function signer(row, c, st) {
  const e = V.ethers(); let p = prov(c);
  if (st && st.mev && MEV_RPC[c]) p = mevProvs[c] = mevProvs[c] || new e.JsonRpcProvider(MEV_RPC[c](), CH[c].id, { staticNetwork: true });
  return new e.Wallet(V.evmPk(row), p);
}
async function gasOv(c, st) {
  const m = PRIO[(st && st.prio) || "fast"] || 125n, fd = await prov(c).getFeeData();
  if (fd.maxFeePerGas && fd.maxPriorityFeePerGas && c !== "b") return { maxPriorityFeePerGas: fd.maxPriorityFeePerGas * m / 100n, maxFeePerGas: fd.maxFeePerGas * m / 100n + fd.maxPriorityFeePerGas };
  return fd.gasPrice ? { gasPrice: fd.gasPrice * m / 100n } : {};
}
const impactPct = (inUsd, outUsd) => (Number(inUsd) > 0 && Number(outUsd) >= 0 ? (1 - Number(outUsd) / Number(inUsd)) * 100 : null);
function checkImpact(imp, st) { if (imp != null && st && st.maxImpact > 0 && imp > st.maxImpact) fail(`Price impact is about ${imp.toFixed(1)}%, above your max of ${st.maxImpact}%. Trade a smaller amount or raise Max price impact in /settings.`); }
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const erc = (c, ca, s) => new (V.ethers().Contract)(ca, ERC20, s || prov(c));
async function evmTokenBal(c, ca, who) { const t = erc(c, ca); const [b, d] = await Promise.all([t.balanceOf(who), t.decimals().catch(() => 18)]); return { raw: b, dec: Number(d) }; }
async function waitTx(tx, c) {
  const rc = await prov(c).waitForTransaction(tx.hash, 1, 45000).catch(() => null); // read the receipt from the normal RPC (MEV RPCs may not serve it)
  if (!rc) fail(`Still pending. Check it here:\n${CH[c].exp}${tx.hash}`);
  if (rc.status === 0) fail(`The transaction failed on-chain:\n${CH[c].exp}${tx.hash}`);
  return rc;
}
async function lifi(c, from, to, amount, addr, slip) {
  const q = new URLSearchParams({ fromChain: CH[c].id, toChain: CH[c].id, fromToken: from, toToken: to, fromAmount: String(amount), fromAddress: addr, slippage: String(slip / 100), integrator: clean(process.env.LIFI_INTEGRATOR) || "cbl", order: "CHEAPEST" });
  const h = { accept: "application/json" }, k = clean(process.env.LIFI_API_KEY); if (k) h["x-lifi-api-key"] = k;
  const r = await jfetch("https://li.quest/v1/quote?" + q, { headers: h }, 25000);
  if (!r.ok || !r.d || !r.d.transactionRequest) fail(r.d && r.d.message ? "No route: " + String(r.d.message).slice(0, 140) : "No route found for this token right now.");
  return r.d;
}

// Four.meme (BNB) and Pons (Robinhood) bonding curves: same contracts CBL Swap uses on the website.
const H3 = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034", PONS_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const H3ABI = ["function getTokenInfo(address) view returns (uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)", "function tryBuy(address,uint256,uint256) view returns (address tokenManager,address quote,uint256 estimatedAmount,uint256 estimatedCost,uint256 estimatedFee,uint256 amountMsgValue,uint256 amountApproval,uint256 amountFunds)", "function trySell(address,uint256) view returns (address tokenManager,address quote,uint256 funds,uint256 fee)"];
const FMABI = ["function buyTokenAMAP(address,uint256,uint256) payable", "function sellToken(uint256,address,uint256,uint256)", "function sellToken(address,uint256)", "function purchaseTokenAMAP(address,uint256,uint256) payable", "function saleToken(address,uint256)"];
const PFABI = ["function getLaunchedToken(address) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"];
const PCABI = ["function quoteReserve() view returns (uint256)", "function tokenReserve() view returns (uint256)", "function reservedTokens() view returns (uint256)", "function feeBps() view returns (uint256)", "function creatorTaxBps() view returns (uint256)", "function currentSnipeTaxBps(address) view returns (uint256)", "function isNativeQuote() view returns (bool)", "function graduated() view returns (bool)", "function buy(uint256,uint256,address) payable returns (uint256)", "function sell(uint256,uint256,address) returns (uint256)"];
async function curveOf(c, ca) {
  const e = V.ethers(), C = (a, abi) => new e.Contract(a, abi, prov(c));
  try {
    if (c === "b") {
      const i = await C(H3, H3ABI).getTokenInfo(ca);
      if (!i || i.tokenManager === ZERO || i.liquidityAdded || i.quote !== ZERO) return null;
      const v = Number(i.version); return v === 1 || v === 2 ? { pad: "Four.meme", v, tm: i.tokenManager } : null;
    }
    if (c === "r") {
      const L = await C(PONS_FACTORY, PFABI).getLaunchedToken(ca);
      if (!L || !L.exists || Number(L.phase) === 2 || L.curve === ZERO) return null;
      const cu = C(L.curve, PCABI); if (!(await cu.isNativeQuote()) || (await cu.graduated())) return null;
      return { pad: "Pons", curve: L.curve };
    }
  } catch (e) {}
  return null;
}
/** Pons launch info for the scanner: curve contract, dev, progress to graduation. null if not a Pons token. */
async function ponsInfo(ca) {
  const e = V.ethers(), C = (a, abi) => new e.Contract(a, abi, prov("r"));
  const facs = [PONS_FACTORY, "0x3711cea4feade896c913c68f01eda97cb06d1a42", "0xe33e9e479df8802cb0866d5d05258bec4cf62948", "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb"];
  for (const f of facs) {
    try {
      const L = await C(f, PFABI).getLaunchedToken(ca);
      if (!L || !L.exists || L.curve === ZERO) continue;
      const cu = C(L.curve, PCABI);
      const [q, grad] = await Promise.all([cu.quoteReserve().catch(() => null), cu.graduated().catch(() => Number(L.phase) === 2)]);
      const th = BigInt(L.graduationThreshold || 0n);
      const progress = grad ? 100 : q != null && th > 0n ? Math.min(100, Number(BigInt(q) * 10000n / th) / 100) : null;
      return { factory: f.toLowerCase(), curve: String(L.curve).toLowerCase(), deployer: String(L.deployer).toLowerCase(), graduated: !!grad, progress, quoteEth: q != null ? Number(q) / 1e18 : null };
    } catch (err) { /* not from this factory */ }
  }
  return null;
}
async function ponsState(c, cu, me) {
  const C = new (V.ethers().Contract)(cu, PCABI, prov(c));
  const r = await Promise.all([C.quoteReserve(), C.tokenReserve(), C.reservedTokens(), C.feeBps(), C.creatorTaxBps(), C.currentSnipeTaxBps(me).catch(() => 0n)]);
  return { q: r[0], t: r[1], rs: r[2], f: r[3], tx: r[4], sn: r[5] };
}
function ponsBuyOut(S, w) {
  let sn = S.sn; if (sn > 0n) { const cl = 9900n - S.f - S.tx; if (sn > cl) sn = cl; }
  const net = w - w * S.f / 10000n - w * S.tx / 10000n - w * sn / 10000n; if (net <= 0n || S.q <= 0n || S.t <= S.rs) fail("Amount too small for this curve.");
  const sc = net * 10000n, out = sc * S.t / (S.q * 10000n + sc), cap = S.t - S.rs; return out > cap ? cap : out;
}
function ponsSellOut(S, a) { const sc = a * 10000n, g = sc * S.q / (S.t * 10000n + sc); return g - g * S.f / 10000n - g * S.tx / 10000n; }

async function evmBuy(row, c, ca, wei, st) {
  const slip = st.slipBuy, s = signer(row, c, st), me = row.evm_addr, cv = await curveOf(c, ca), sb = BigInt(Math.round(slip * 100)), e = V.ethers(), g = await gasOv(c, st);
  let tx, route;
  if (cv && cv.pad === "Four.meme") {
    const r = await new e.Contract(H3, H3ABI, prov(c)).tryBuy(ca, 0, wei);
    const min = r.estimatedAmount * (10000n - sb) / 10000n, M = new e.Contract(cv.tm, FMABI, s), fn = cv.v === 1 ? "purchaseTokenAMAP(address,uint256,uint256)" : "buyTokenAMAP(address,uint256,uint256)";
    const val = r.amountMsgValue > 0n ? r.amountMsgValue : wei, funds = r.amountFunds > 0n ? r.amountFunds : wei;
    await M[fn].staticCall(ca, funds, min, { value: val }); tx = await M[fn](ca, funds, min, { value: val, ...g }); route = "Four.meme curve";
  } else if (cv && cv.pad === "Pons") {
    const out = ponsBuyOut(await ponsState(c, cv.curve, me), wei), P = new e.Contract(cv.curve, PCABI, s), min = out * (10000n - sb) / 10000n;
    await P.buy.staticCall(wei, min, me, { value: wei }); tx = await P.buy(wei, min, me, { value: wei, ...g }); route = "Pons curve";
  } else {
    const q = await lifi(c, ZERO, ca, wei, me, slip), t = q.transactionRequest;
    checkImpact(q.estimate && impactPct(q.estimate.fromAmountUSD, q.estimate.toAmountUSD), st);
    tx = await s.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value || 0), gasLimit: t.gasLimit ? BigInt(t.gasLimit) * 12n / 10n : undefined, ...g });
    route = (q.toolDetails && q.toolDetails.name) || q.tool || "LI.FI";
  }
  await waitTx(tx, c);
  return { hash: tx.hash, route };
}
async function evmSell(row, c, ca, amt, st) {
  const slip = st.slipSell, s = signer(row, c, st), me = row.evm_addr, cv = await curveOf(c, ca), sb = BigInt(Math.round(slip * 100)), e = V.ethers(), g = await gasOv(c, st);
  const approve = async (spender) => { const al = await erc(c, ca).allowance(me, spender); if (al < amt) await waitTx(await erc(c, ca, s).approve(spender, e.MaxUint256, g), c); };
  let tx, est, route;
  if (cv && cv.pad === "Four.meme") {
    const r = await new e.Contract(H3, H3ABI, prov(c)).trySell(ca, amt); est = r.funds > r.fee ? r.funds - r.fee : r.funds;
    await approve(cv.tm);
    const M = new e.Contract(cv.tm, FMABI, s), min = est * (10000n - sb) / 10000n;
    if (cv.v === 1) tx = await M["saleToken(address,uint256)"](ca, amt, g);
    else { let four = true; try { await M["sellToken(uint256,address,uint256,uint256)"].staticCall(0, ca, amt, min); } catch (x) { four = false; await M["sellToken(address,uint256)"].staticCall(ca, amt); }
      tx = four ? await M["sellToken(uint256,address,uint256,uint256)"](0, ca, amt, min, g) : await M["sellToken(address,uint256)"](ca, amt, g); }
    route = "Four.meme curve";
  } else if (cv && cv.pad === "Pons") {
    est = ponsSellOut(await ponsState(c, cv.curve, me), amt); await approve(cv.curve);
    const P = new e.Contract(cv.curve, PCABI, s), min = est * (10000n - sb) / 10000n;
    await P.sell.staticCall(amt, min, me); tx = await P.sell(amt, min, me, g); route = "Pons curve";
  } else {
    let q = await lifi(c, ca, ZERO, amt, me, slip);
    if (q.estimate && q.estimate.approvalAddress) { await approve(q.estimate.approvalAddress); q = await lifi(c, ca, ZERO, amt, me, slip); }
    const t = q.transactionRequest; est = BigInt((q.estimate && q.estimate.toAmountMin) || (q.estimate && q.estimate.toAmount) || 0);
    checkImpact(q.estimate && impactPct(q.estimate.fromAmountUSD, q.estimate.toAmountUSD), st);
    tx = await s.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value || 0), gasLimit: t.gasLimit ? BigInt(t.gasLimit) * 12n / 10n : undefined, ...g });
    route = (q.toolDetails && q.toolDetails.name) || q.tool || "LI.FI";
  }
  await waitTx(tx, c);
  return { hash: tx.hash, out: est, route };
}
async function evmSend(row, c, to, wei) { const tx = await signer(row, c).sendTransaction({ to, value: wei }); await waitTx(tx, c); return tx.hash; }

// ---------- public API ----------
const toUnits = (x, dec) => { const s = String(x).trim(); if (!/^\d*\.?\d+$/.test(s)) fail("Enter a number, e.g. 0.25"); const [a, b = ""] = s.split("."); return BigInt(a || "0") * 10n ** BigInt(dec) + BigInt((b + "0".repeat(dec)).slice(0, dec) || "0"); };
const fromUnits = (v, dec, dp = 4) => { const n = Number(v) / 10 ** dec; return n >= 1 ? n.toFixed(Math.min(dp, 4)).replace(/\.?0+$/, "") : n.toPrecision(dp).replace(/\.?0+$/, ""); };

async function nativeBal(row, c) { return c === "s" ? solBal(row.sol_pub) : prov(c).getBalance(row.evm_addr); }

/** Buy `amount` (native units, e.g. "0.1" SOL) of token `ca` on chain code `c`. Fee is taken from the amount. */
async function buy(uid, c, ca, amount) {
  if (!CH[c]) fail("Unsupported chain");
  const row = await getRow(uid); if (!row) fail("Open /trade first to create your wallet.");
  const st = settings(row), total = toUnits(amount, CH[c].dec), bps = BigInt(feeBps()), to = feeTo(c), fee = to ? total * bps / 10000n : 0n, swapIn = total - fee;
  if (swapIn <= 0n) fail("Amount too small.");
  const bal = await nativeBal(row, c), need = total + toUnits(CH[c].reserve, CH[c].dec);
  if (bal < need) fail(`Not enough ${CH[c].nat}. You have ${fromUnits(bal, CH[c].dec)} ${CH[c].nat}; this buy needs about ${fromUnits(need, CH[c].dec)} incl. fee and gas.\nDeposit to your ${CH[c].name} address in /trade.`);
  if (!(await lock(uid))) fail("Another trade is still running. Wait a few seconds.");
  try {
    let res, out = 0n, dec = 0;
    if (c === "s") { dec = await solDecimals(ca); const r = await solSwap(row, SOL_MINT, ca, swapIn, st); res = { hash: r.sig, route: "Jupiter" }; out = r.out; }
    else { const before = await evmTokenBal(c, ca, row.evm_addr); res = await evmBuy(row, c, ca, swapIn, st); const after = await evmTokenBal(c, ca, row.evm_addr); dec = after.dec; out = after.raw - before.raw; }
    let feeHash = null;
    if (fee > 0n) { try { feeHash = c === "s" ? await solSend(row, to, fee) : await evmSend(row, c, to, fee); } catch (e) { console.error("fee transfer failed", e.message); } }
    await record({ tg_id: uid, chain: CH[c].key, token: c === "s" ? ca : ca.toLowerCase(), side: "buy", native_raw: total.toString(), token_raw: out.toString(), decimals: dec, tx: res.hash, fee_raw: feeHash ? fee.toString() : "0" });
    return { ok: true, c, ca, hash: res.hash, route: res.route, spent: total, fee: feeHash ? fee : 0n, out, dec };
  } finally { await unlock(uid); }
}

/** Sell `pct` percent (1–100) of the token balance. Fee is taken from the proceeds. */
async function sell(uid, c, ca, pct) {
  if (!CH[c]) fail("Unsupported chain");
  pct = Math.min(100, Math.max(1, Math.round(Number(pct) || 0))); if (!pct) fail("Choose a percentage.");
  const row = await getRow(uid); if (!row) fail("Open /trade first to create your wallet.");
  const st = settings(row);
  let bal, dec;
  if (c === "s") { const t = (await solTokens(row.sol_pub, ca))[0]; bal = t ? t.raw : 0n; dec = t ? t.dec : 0; }
  else { const t = await evmTokenBal(c, ca, row.evm_addr); bal = t.raw; dec = t.dec; }
  if (bal <= 0n) fail("You don't hold this token in your CBL wallet.");
  const amt = pct === 100 ? bal : bal * BigInt(pct) / 100n;
  const gas = await nativeBal(row, c); if (gas < toUnits(CH[c].reserve / 2, CH[c].dec)) fail(`You need a little ${CH[c].nat} for gas. Deposit some first.`);
  if (!(await lock(uid))) fail("Another trade is still running. Wait a few seconds.");
  try {
    let res, out;
    if (c === "s") { const r = await solSwap(row, ca, SOL_MINT, amt, st); res = { hash: r.sig, route: "Jupiter" }; out = r.out; }
    else { res = await evmSell(row, c, ca, amt, st); out = res.out; }
    const to = feeTo(c), fee = to ? out * BigInt(feeBps()) / 10000n : 0n; let feeHash = null;
    if (fee > 0n) { try { feeHash = c === "s" ? await solSend(row, to, fee) : await evmSend(row, c, to, fee); } catch (e) { console.error("fee transfer failed", e.message); } }
    await record({ tg_id: uid, chain: CH[c].key, token: c === "s" ? ca : ca.toLowerCase(), side: "sell", native_raw: (out - (feeHash ? fee : 0n)).toString(), token_raw: amt.toString(), decimals: dec, tx: res.hash, fee_raw: feeHash ? fee.toString() : "0" });
    return { ok: true, c, ca, hash: res.hash, route: res.route, sold: amt, dec, out: out - (feeHash ? fee : 0n), fee: feeHash ? fee : 0n, pct };
  } finally { await unlock(uid); }
}

/** Send native coin out. amount: number string or "all". */
async function withdraw(uid, c, amount, to) {
  const row = await getRow(uid); if (!row) fail("Open /trade first.");
  if (c === "s") { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) fail("That is not a Solana address."); }
  else if (!/^0x[a-fA-F0-9]{40}$/.test(to)) fail("That is not an EVM (0x…) address.");
  const bal = await nativeBal(row, c);
  let amt;
  if (/^all$/i.test(amount)) {
    if (c === "s") amt = bal - 5000n;
    else { const fd = await prov(c).getFeeData(), gp = fd.maxFeePerGas || fd.gasPrice || 0n; amt = bal - gp * 21000n * 13n / 10n; }
  } else amt = toUnits(amount, CH[c].dec);
  if (amt <= 0n || amt > bal) fail(`Not enough ${CH[c].nat}. Balance: ${fromUnits(bal, CH[c].dec)}`);
  if (!(await lock(uid))) fail("Another transaction is still running. Wait a few seconds.");
  try {
    const hash = c === "s" ? await solSend(row, to, amt) : await evmSend(row, c, to, amt);
    return { hash, amt, c, to };
  } finally { await unlock(uid); }
}

async function balances(row) {
  const out = {};
  await Promise.all(Object.keys(CH).map(async (c) => { try { out[c] = await nativeBal(row, c); } catch (e) { out[c] = null; } }));
  return out;
}

async function dsPrices(chain, cas) {
  const m = {};
  for (let i = 0; i < cas.length; i += 30) {
    const r = await jfetch(`https://api.dexscreener.com/tokens/v1/${chain}/${cas.slice(i, i + 30).join(",")}`, null, 8000);
    for (const p of (Array.isArray(r.d) ? r.d : [])) {
      const a = String(p.baseToken && p.baseToken.address), k = chain === "solana" ? a : a.toLowerCase(), liq = (p.liquidity && p.liquidity.usd) || 0;
      if (!m[k] || liq > m[k].liq) m[k] = { liq, sym: p.baseToken.symbol, pn: Number(p.priceNative) || 0, pu: Number(p.priceUsd) || 0, url: p.url };
    }
  }
  return m;
}

/** Positions: current holdings + PnL from the bot's own trade history. */
async function positions(uid) {
  const row = await getRow(uid); if (!row) return { row: null, list: [] };
  const trades = (await db.select("bot_trades", `tg_id=eq.${uid}&select=chain,token,side,native_raw,token_raw,decimals,created_at&order=created_at.asc&limit=2000`)) || [];
  const agg = new Map();
  for (const t of trades) {
    const k = t.chain + "|" + t.token, a = agg.get(k) || { chain: t.chain, token: t.token, spent: 0n, got: 0n, dec: t.decimals };
    if (t.side === "buy") a.spent += BigInt(t.native_raw); else a.got += BigInt(t.native_raw);
    agg.set(k, a);
  }
  // Solana holdings across the main wallet and any bundle wallets (W2–W5)
  const subs = (await db.select("bot_subwallets", `tg_id=eq.${uid}&select=sol_pub`).catch(() => [])) || [];
  const solAll = await Promise.all([row.sol_pub, ...subs.map((x) => x.sol_pub)].map((a) => solTokens(a).catch(() => [])));
  const sm = new Map(); solAll.flat().forEach((t) => { const p = sm.get(t.mint); sm.set(t.mint, { mint: t.mint, dec: t.dec, raw: (p ? p.raw : 0n) + t.raw }); });
  const sol = [...sm.values()];
  for (const t of sol) if (!agg.has("solana|" + t.mint)) agg.set("solana|" + t.mint, { chain: "solana", token: t.mint, spent: 0n, got: 0n, dec: t.dec });
  const list = [...agg.values()];
  await Promise.all(list.map(async (p) => {
    if (p.chain === "solana") { const t = sol.find((x) => x.mint === p.token); p.raw = t ? t.raw : 0n; p.dec = t ? t.dec : p.dec; }
    else { try { const c = CODE[p.chain], b = await evmTokenBal(c, p.token, row.evm_addr); p.raw = b.raw; p.dec = b.dec; } catch (e) { p.raw = 0n; } }
  }));
  const by = {}; list.forEach((p) => (by[p.chain] = by[p.chain] || []).push(p.token));
  const px = {}; await Promise.all(Object.entries(by).map(async ([ch, cas]) => Object.assign(px, ...Object.entries(await dsPrices(ch, cas)).map(([k, v]) => ({ [ch + "|" + k]: v })))));
  for (const p of list) {
    const q = px[p.chain + "|" + p.token], natDec = CH[CODE[p.chain]].dec, amt = Number(p.raw) / 10 ** p.dec;
    p.sym = q ? q.sym : null; p.url = q ? q.url : null; p.priceUsd = q ? q.pu : null;
    p.valueNat = q ? amt * q.pn : null; p.valueUsd = q ? amt * q.pu : null;
    const spent = Number(p.spent) / 10 ** natDec, got = Number(p.got) / 10 ** natDec;
    p.spentNat = spent; p.gotNat = got;
    p.pnlNat = p.spent > 0n && p.valueNat != null ? p.valueNat + got - spent : null;
    p.pnlPct = p.pnlNat != null && spent > 0 ? p.pnlNat / spent * 100 : null;
  }
  return { row, list: list.filter((p) => p.raw > 0n || p.spent > 0n).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)) };
}

/** One token: holdings + PnL for the trade panel. */
async function tokenView(uid, c, ca) {
  const { list } = await positions(uid);
  const k = c === "s" ? ca : ca.toLowerCase();
  return list.find((p) => p.chain === CH[c].key && p.token === k) || null;
}

// internals shared with bundle.js
module.exports._ = { srpc, solTokens, solBal, solDecimals, jfetch, lock, unlock, record, feeTo, fail, toUnits, SOL_MINT, clean };
Object.assign(module.exports, { DEFAULTS, on, CH, CODE, getRow, ensure, settings, saveSettings, buy, sell, withdraw, balances, positions, tokenView, nativeBal, fromUnits, toUnits, feeBps, UserErr, curveOf, ponsInfo });
