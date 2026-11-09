// CBL Bartender referrals: invite link t.me/<bot>?start=ref_<id>. The inviter earns REF_SHARE_PCT (default 25%)
// of the trading fees their invitees pay, per coin. Earnings build up; the inviter taps 💰 Claim.
//   Payout goes to the inviter's own Bartender wallet, from a payout hot wallet:
//     REF_PAYOUT_SOL_KEY (base58 private key, Phantom export format) and REF_PAYOUT_EVM_KEY (0x… private key).
//   Keep only a small float in those wallets and top them up from your fee wallet.
//   Without a payout key for a coin, the claim is queued and admins (ADMIN_IDS) get a DM; pay it, then /refpaid <id> <tx>.
const db = require("./db");
const T = require("./trade");
const V = require("./vault");
const { b58dec } = require("./devstats");
const X = T._;

const KEY = { s: "solana", b: "bsc", e: "base", r: "robinhood" };
const CODE = { solana: "s", bsc: "b", base: "e", robinhood: "r" };
const MIN = { s: "0.01", b: "0.002", e: "0.0005", r: "0.0005" }; // smallest claim per coin
const share = () => Math.min(50, Math.max(0, Number(process.env.REF_SHARE_PCT) || 25));
const env = (k) => X.clean(process.env[k]);

/** Called on /start ref_<id>. Only brand-new users (no wallet yet, no inviter yet) can be referred. */
async function attach(uid, refBy) {
  refBy = Number(refBy);
  if (!refBy || refBy === Number(uid)) return false;
  if (await T.getRow(uid)) return false;
  if (!(await T.getRow(refBy))) return false;
  const have = await db.select("bot_refs", `tg_id=eq.${uid}&select=tg_id`).catch(() => []);
  if (have && have.length) return false;
  await db.insert("bot_refs", [{ tg_id: Number(uid), ref_by: refBy }]).catch(() => {});
  return true;
}

/** Totals for an inviter: invited count, earned / claimed / available per coin (smallest units, BigInt). */
async function stats(uid) {
  const refs = (await db.select("bot_refs", `ref_by=eq.${uid}&select=tg_id,created_at`).catch(() => [])) || [];
  const since = {}; refs.forEach((r) => { since[r.tg_id] = Date.parse(r.created_at) || 0; });
  const earned = { s: 0n, b: 0n, e: 0n, r: 0n }, claimed = { s: 0n, b: 0n, e: 0n, r: 0n };
  let trades = 0;
  for (let i = 0; i < refs.length; i += 100) {
    const ids = refs.slice(i, i + 100).map((r) => r.tg_id).join(",");
    const rows = (await db.select("bot_trades", `tg_id=in.(${ids})&select=tg_id,chain,fee_raw,created_at&limit=10000`).catch(() => [])) || [];
    for (const t of rows) {
      const c = CODE[t.chain]; if (!c || Date.parse(t.created_at) < since[t.tg_id]) continue;
      earned[c] += BigInt(t.fee_raw || "0") * BigInt(Math.round(share() * 100)) / 10000n; trades++;
    }
  }
  const cl = (await db.select("bot_ref_claims", `tg_id=eq.${uid}&status=neq.failed&select=chain,amount_raw`).catch(() => [])) || [];
  cl.forEach((x) => { const c = CODE[x.chain]; if (c) claimed[c] += BigInt(x.amount_raw || "0"); });
  const avail = {}; Object.keys(earned).forEach((c) => { avail[c] = earned[c] > claimed[c] ? earned[c] - claimed[c] : 0n; });
  return { invited: refs.length, trades, earned, claimed, avail, share: share() };
}

const solSeedFromEnv = () => { const k = env("REF_PAYOUT_SOL_KEY"); if (!k) return null; const b = b58dec(k); return b.length === 64 || b.length === 32 ? Buffer.from(b.subarray(0, 32)) : null; };
async function payout(c, to, amt) {
  if (c === "s") {
    const seed = solSeedFromEnv(); if (!seed) return null;
    const bh = (await X.srpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
    return X.srpc("sendTransaction", [V.solTransferTx(seed, to, amt, bh), { encoding: "base64", preflightCommitment: "confirmed" }]);
  }
  const k = env("REF_PAYOUT_EVM_KEY"); if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return null;
  const w = new (V.ethers().Wallet)(k, X.prov(c)), tx = await w.sendTransaction({ to, value: amt });
  await X.waitTx(tx, c); return tx.hash;
}

/** Claim everything available for one coin. Returns { amt, tx } (paid now) or { amt, queued: id }. */
async function claim(uid, c, notifyAdmins) {
  if (!KEY[c]) X.fail("Unknown coin.");
  const row = await T.getRow(uid); if (!row) X.fail("Open /trade first.");
  if (!(await X.lock(uid))) X.fail("Another transaction is still running. Wait a few seconds.");
  try {
    const s = await stats(uid), amt = s.avail[c];
    if (amt < X.toUnits(MIN[c], T.CH[c].dec)) X.fail(`Minimum claim is ${MIN[c]} ${T.CH[c].nat}. You have ${T.fromUnits(amt, T.CH[c].dec)}.`);
    const to = c === "s" ? row.sol_pub : row.evm_addr;
    const ins = await db.insertRet("bot_ref_claims", [{ tg_id: uid, chain: KEY[c], amount_raw: amt.toString(), status: "sending" }]).catch(() => null);
    const id = ins && ins[0] && ins[0].id;
    let tx = null;
    try { tx = await payout(c, to, amt); }
    catch (e) { if (id) await db.patch("bot_ref_claims", "id=eq." + id, { status: "failed" }).catch(() => {}); X.fail("Payout failed, nothing was sent. Try again later."); }
    if (tx) { if (id) await db.patch("bot_ref_claims", "id=eq." + id, { status: "paid", tx }).catch(() => {}); return { amt, c, tx }; }
    if (id) await db.patch("bot_ref_claims", "id=eq." + id, { status: "pending" }).catch(() => {});
    if (notifyAdmins) await notifyAdmins(`💰 <b>Referral claim #${id}</b>\nUser <code>${uid}</code> · <b>${T.fromUnits(amt, T.CH[c].dec)} ${T.CH[c].nat}</b> on ${T.CH[c].name}\nPay to: <code>${to}</code>\nThen: <code>/refpaid ${id} &lt;tx&gt;</code>`);
    return { amt, c, queued: id };
  } finally { await X.unlock(uid); }
}

async function markPaid(id, tx) {
  const r = await db.select("bot_ref_claims", `id=eq.${Number(id)}&select=*`).catch(() => []);
  const cl = r && r[0]; if (!cl) X.fail("No claim with that id.");
  await db.patch("bot_ref_claims", "id=eq." + cl.id, { status: "paid", tx: String(tx || "").slice(0, 120) || null });
  return cl;
}

module.exports = { attach, stats, claim, markPaid, MIN, CODE, KEY, share };
