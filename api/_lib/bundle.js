// Bundles (Solana, like BonkBot): a user's own wallets W1–W5 buy or sell the same token together in ONE Jito bundle —
// all transactions land in the same block or none do. W1 is the main bot wallet; W2–W5 live in bot_subwallets.
//   Swaps: Jupiter Swap API (quote + swap, raw transactions we sign). The Jito tip is added to W1's swap transaction.
//   Fee: BOT_FEE_BPS of the total, one transfer from W1 after the bundle lands.
const db = require("./db");
const V = require("./vault");
const T = require("./trade");
const { b58enc } = require("./devstats");
const X = T._;

const MAX = 5;
const JITO = () => X.clean(process.env.JITO_URL) || "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wallets(uid) {
  const row = await T.getRow(uid); if (!row) X.fail("Open /trade first.");
  const subs = (await db.select("bot_subwallets", `tg_id=eq.${uid}&select=*&order=idx.asc`)) || [];
  return { row, list: [{ idx: 1, pub: row.sol_pub, seed: () => V.solSeed(row) }, ...subs.map((s) => ({ idx: s.idx, pub: s.sol_pub, seed: () => V.subSeed(s) }))] };
}
async function addWallet(uid) {
  const { list } = await wallets(uid);
  if (list.length >= MAX) X.fail(`You already have ${MAX} wallets.`);
  const used = new Set(list.map((w) => w.idx)); let idx = 2; while (used.has(idx)) idx++;
  await db.insert("bot_subwallets", [V.createSub(uid, idx)]);
  return idx;
}
async function balances(uid) { const { list } = await wallets(uid); return Promise.all(list.map(async (w) => ({ idx: w.idx, pub: w.pub, bal: await X.solBal(w.pub).catch(() => null) }))); }

async function solSendSeed(seed, to, lamports) {
  const bh = (await X.srpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  return X.srpc("sendTransaction", [V.solTransferTx(seed, to, lamports, bh), { encoding: "base64", preflightCommitment: "confirmed" }]);
}

async function metis(pub, inMint, outMint, amount, slipPct, tip) {
  const key = X.clean(process.env.JUP_API_KEY), base = key ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1", h = key ? { "x-api-key": key } : {};
  const q = await X.jfetch(`${base}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${Math.round(slipPct * 100)}`, { headers: h }, 12000);
  if (!q.ok || !q.d || !q.d.outAmount) X.fail("No route for this token right now" + (q.d && q.d.error ? ": " + String(q.d.error).slice(0, 100) : "."));
  const body = { quoteResponse: q.d, userPublicKey: pub, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true };
  if (tip > 0) body.prioritizationFeeLamports = { jitoTipLamports: Number(tip) };
  const s = await X.jfetch(`${base}/swap`, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, h), body: JSON.stringify(body) }, 15000);
  if (!s.ok || !s.d || !s.d.swapTransaction) X.fail("Jupiter could not build the swap" + (s.d && s.d.error ? ": " + String(s.d.error).slice(0, 100) : "."));
  return { tx: s.d.swapTransaction, out: BigInt(q.d.outAmount), impact: Number(q.d.priceImpactPct) };
}
const sigOf = (b64) => { const b = Buffer.from(b64, "base64"), [, l] = V.cu16(b, 0); return b58enc(b.subarray(l, l + 64)); };

/** Send signed txs as one Jito bundle and wait until they confirm (atomic: all or nothing). */
async function sendBundle(txs) {
  const r = await X.jfetch(JITO(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [txs, { encoding: "base64" }] }) }, 12000);
  if (!r.ok || !r.d || r.d.error) X.fail("Jito rejected the bundle" + (r.d && r.d.error ? ": " + String(r.d.error.message || r.d.error).slice(0, 120) : ". Try again in a few seconds."));
  const sigs = txs.map(sigOf);
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const st = await X.srpc("getSignatureStatuses", [sigs]).catch(() => null);
    const v = (st && st.value) || [];
    if (v.some((x) => x && x.err)) X.fail("The bundle failed on-chain (nothing or only fees were spent). Try again with higher slippage.");
    if (v.length === sigs.length && v.every((x) => x && (x.confirmationStatus === "confirmed" || x.confirmationStatus === "finalized"))) return { bundleId: r.d.result, sigs };
  }
  X.fail("The bundle didn't land in time, so nothing was bought or sold. Try again or raise the bundle tip in 👛 Wallet.");
}

/** Buy `amount` SOL in total, split evenly across all wallets that have enough SOL. */
async function buy(uid, ca, amount) {
  const { row, list } = await wallets(uid), st = T.settings(row);
  if (list.length < 2) X.fail("Add at least one more wallet in 👛 Wallet to use bundles.");
  const total = X.toUnits(amount, 9), tip = X.toUnits(st.bundleTip || 0.001, 9), to = X.feeTo("s"), fee = to ? total * BigInt(T.feeBps()) / 10000n : 0n;
  const per = (total - fee) / BigInt(list.length), reserve = 3000000n;
  const bals = await Promise.all(list.map((w) => X.solBal(w.pub)));
  const short = list.filter((w, i) => bals[i] < per + reserve + (i === 0 ? tip + fee : 0n)).map((w) => "W" + w.idx);
  if (short.length) X.fail(`Not enough SOL in ${short.join(", ")} for ${T.fromUnits(per, 9)} SOL each (+ gas${fee || tip ? ", tip and fee on W1" : ""}). Use 💸 Spread SOL in 👛 Wallet.`);
  if (!(await X.lock(uid))) X.fail("Another trade is still running. Wait a few seconds.");
  try {
    const dec = await X.solDecimals(ca);
    const built = await Promise.all(list.map((w, i) => metis(w.pub, X.SOL_MINT, ca, per, st.slipBuy, i === 0 ? tip : 0n)));
    const signed = built.map((b, i) => V.solSignTx(b.tx, list[i].seed()));
    const res = await sendBundle(signed);
    if (fee > 0n) await solSendSeed(list[0].seed(), to, fee).catch((e) => console.error("bundle fee", e.message));
    const share = fee / BigInt(list.length);
    for (let i = 0; i < list.length; i++) await X.record({ tg_id: uid, chain: "solana", token: ca, side: "buy", native_raw: (per + share).toString(), token_raw: built[i].out.toString(), decimals: dec, tx: res.sigs[i], fee_raw: share.toString(), wallet: list[i].idx });
    return { n: list.length, per, total, fee, out: built.reduce((a, b) => a + b.out, 0n), dec, sigs: res.sigs, route: "Jupiter · Jito bundle" };
  } finally { await X.unlock(uid); }
}

/** Sell `pct`% of the token from every wallet that holds it, in one bundle. */
async function sell(uid, ca, pct) {
  const { row, list } = await wallets(uid), st = T.settings(row);
  pct = Math.min(100, Math.max(1, Math.round(Number(pct) || 0)));
  const holds = (await Promise.all(list.map(async (w) => { const t = (await X.solTokens(w.pub, ca))[0]; return t && t.raw > 0n ? { w, raw: t.raw, dec: t.dec } : null; }))).filter(Boolean);
  if (!holds.length) X.fail("None of your wallets hold this token.");
  if (!(await X.lock(uid))) X.fail("Another trade is still running. Wait a few seconds.");
  try {
    const tip = X.toUnits(st.bundleTip || 0.001, 9);
    const amts = holds.map((h) => (pct === 100 ? h.raw : h.raw * BigInt(pct) / 100n));
    const built = await Promise.all(holds.map((h, i) => metis(h.w.pub, ca, X.SOL_MINT, amts[i], st.slipSell, i === 0 ? tip : 0n)));
    const res = await sendBundle(built.map((b, i) => V.solSignTx(b.tx, holds[i].w.seed())));
    const outAll = built.reduce((a, b) => a + b.out, 0n), to = X.feeTo("s"), fee = to ? outAll * BigInt(T.feeBps()) / 10000n : 0n;
    if (fee > 0n) await solSendSeed(holds[0].w.seed(), to, fee).catch((e) => console.error("bundle fee", e.message));
    const share = fee / BigInt(holds.length);
    for (let i = 0; i < holds.length; i++) await X.record({ tg_id: uid, chain: "solana", token: ca, side: "sell", native_raw: (built[i].out - share).toString(), token_raw: amts[i].toString(), decimals: holds[i].dec, tx: res.sigs[i], fee_raw: share.toString(), wallet: holds[i].w.idx });
    return { n: holds.length, out: outAll - fee, fee, sold: amts.reduce((a, b) => a + b, 0n), dec: holds[0].dec, sigs: res.sigs, pct, route: "Jupiter · Jito bundle" };
  } finally { await X.unlock(uid); }
}

/** Send `each` SOL from W1 to every other wallet. */
async function spread(uid, each) {
  const { list } = await wallets(uid); if (list.length < 2) X.fail("Add a wallet first.");
  const amt = X.toUnits(each, 9), need = amt * BigInt(list.length - 1) + 20000n, bal = await X.solBal(list[0].pub);
  if (bal < need) X.fail(`W1 has ${T.fromUnits(bal, 9)} SOL; sending ${T.fromUnits(amt, 9)} to ${list.length - 1} wallet(s) needs about ${T.fromUnits(need, 9)}.`);
  if (!(await X.lock(uid))) X.fail("Another transaction is still running.");
  try { const out = []; for (const w of list.slice(1)) out.push(await solSendSeed(list[0].seed(), w.pub, amt)); return { n: out.length, amt }; }
  finally { await X.unlock(uid); }
}
/** Move all SOL from W2–W5 back to W1 (leaves a tiny amount for fees). */
async function collect(uid) {
  const { list } = await wallets(uid); if (list.length < 2) X.fail("You only have one wallet.");
  if (!(await X.lock(uid))) X.fail("Another transaction is still running.");
  try {
    let total = 0n;
    for (const w of list.slice(1)) { const b = await X.solBal(w.pub); if (b > 10000n) { await solSendSeed(w.seed(), list[0].pub, b - 5000n); total += b - 5000n; } }
    return { total };
  } finally { await X.unlock(uid); }
}
async function exportKeys(uid) { const { list } = await wallets(uid); return list.slice(1).map((w) => ({ idx: w.idx, pub: w.pub, key: V.solExport(w.seed()) })); }

module.exports = { MAX, wallets, addWallet, balances, buy, sell, spread, collect, exportKeys, sigOf };
