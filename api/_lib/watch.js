// Watchlist logic: store watches, take snapshots, compare snapshots and produce alerts.
const db = require("./db");
const { runScan, detect } = require("./scanner");
const { deployerBalance } = require("./deep");

const MAX_WATCH = 10;
const norm = (ca) => (/^(0x|terra1)/i.test(ca) ? ca.toLowerCase() : ca);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const COOLDOWN = 3 * 3600e3, REF_WINDOW = 60 * 60e3;

function snapOf(cur, prev, deepInfo) {
  const now = Date.now();
  const liq = cur.market ? num(cur.market.liquidity) : null, price = cur.market ? num(cur.market.price) : null;
  const ref = prev && prev.ref && now - prev.ref.t < REF_WINDOW ? prev.ref : { price, liq, t: now };
  return {
    address: norm(cur.address), chain: cur.chain, score: cur.score, flags: cur.flags || {}, liquidity: liq, price,
    ref, deployer: (deepInfo && deepInfo.deployer) || (prev && prev.deployer) || null,
    deployer_amt: deepInfo && deepInfo.deployerAmt != null ? String(deepInfo.deployerAmt) : prev ? prev.deployer_amt : null,
    supply: (deepInfo && deepInfo.supply) || (prev && prev.supply) || null,
    alerted: (prev && prev.alerted) || {}, checked_at: new Date().toISOString(),
  };
}

// Compare the stored snapshot with a fresh scan. Returns { alerts: [{kind, sev, text}], next: snapshot }
async function evaluate(prev, cur) {
  const A = [], now = Date.now(), al = { ...(prev.alerted || {}) };
  const add = (kind, sev, text) => { if (now - (al[kind] || 0) < COOLDOWN) return; al[kind] = now; A.push({ kind, sev, text }); };
  const pf = prev.flags || {}, cf = cur.flags || {};
  if (cur.chain === "terraclassic") {
    if (!pf.admin && cf.admin) add("admin", "critical", "The contract now has an admin. It can be migrated to new code.");
    if (pf.mint === false && cf.mint === true) add("mint", "critical", "New tokens can be minted again.");
  } else if (cur.chain === "solana") {
    if (pf.mint === false && cf.mint === true) add("mint", "critical", "Mint authority is active again. New tokens can be created.");
    if (pf.freeze === false && cf.freeze === true) add("freeze", "critical", "Freeze authority is active. Wallets can be frozen.");
  } else {
    if (pf.honeypot === false && cf.honeypot === true) add("honeypot", "critical", "Now flagged as a honeypot. Selling may be blocked.");
    if (num(cf.sellTax) !== null && num(pf.sellTax) !== null && cf.sellTax - pf.sellTax >= 10 && cf.sellTax >= 15)
      add("tax", "high", `Sell tax rose from ${pf.sellTax.toFixed(1)}% to ${cf.sellTax.toFixed(1)}%.`);
    if (pf.owner && cf.owner && pf.owner !== cf.owner) add("owner", "medium", "Contract owner changed.");
  }
  const liq = cur.market ? num(cur.market.liquidity) : null, price = cur.market ? num(cur.market.price) : null;
  const ref = prev.ref || {};
  if (liq !== null && num(ref.liq) > 1000 && liq <= ref.liq * 0.5)
    add("liq", liq <= ref.liq * 0.2 ? "critical" : "high", `Liquidity dropped ${Math.round((1 - liq / ref.liq) * 100)}% in the last hour ($${Math.round(ref.liq).toLocaleString("en-US")} to $${Math.round(liq).toLocaleString("en-US")}).`);
  if (price !== null && num(ref.price) > 0 && price <= ref.price * 0.6)
    add("price", "high", `Price fell ${Math.round((1 - price / ref.price) * 100)}% in the last hour.`);
  if (typeof cur.score === "number" && typeof prev.score === "number" && prev.score - cur.score >= 20)
    add("score", "medium", `Risk score dropped from ${prev.score} to ${cur.score}.`);

  let depAmt = prev.deployer_amt;
  if (cur.chain === "solana" && prev.deployer && prev.deployer_amt && prev.deployer_amt !== "0" && process.env.HELIUS_API_KEY) {
    const now2 = await deployerBalance(cur.address, prev.deployer).catch(() => null);
    if (now2 !== null) {
      const base = Number(prev.deployer_amt);
      if (base > 0 && now2 <= base * 0.5) {
        const pct = Math.round((1 - now2 / base) * 100);
        add("dev", pct >= 90 ? "critical" : "high", `Deployer sold ${pct}% of their tokens.`);
        depAmt = String(now2); // new baseline after alerting
      }
    }
  }
  const next = snapOf(cur, prev, null);
  next.alerted = al; next.deployer_amt = depAmt;
  if (A.some((a) => a.kind === "liq" || a.kind === "price")) next.ref = { price, liq, t: now };
  return { alerts: A, next };
}

async function addWatch(userId, ca, chainSel) {
  const addr = norm(ca);
  const mine = await db.select("watches", `user_id=eq.${userId}&select=address`);
  if (mine.some((w) => w.address === addr)) return { dup: true };
  if (mine.length >= MAX_WATCH) return { full: true, max: MAX_WATCH };
  const full = await runScan(ca, chainSel || "auto");                 // card info + deployer (cached when just scanned)
  const base = await runScan(ca, chainSel || "auto", { fresh: true, noDeep: true }); // baseline without deep so later comparisons match
  await db.insert("watches", [{ user_id: userId, address: addr, chain: full.chain, name: full.token.name, symbol: full.token.symbol }]);
  const d = full.deep || {};
  await db.insert("snapshots", [snapOf(base, null, { deployer: d.deployer, deployerAmt: d.deployerAmt, supply: d.supply })], "address");
  return { ok: true, res: full };
}
async function removeWatch(userId, ca) {
  const addr = norm(ca);
  await db.del("watches", `user_id=eq.${userId}&address=eq.${db.enc(addr)}`);
  const left = await db.select("watches", `address=eq.${db.enc(addr)}&select=user_id&limit=1`);
  if (!left.length) await db.del("snapshots", `address=eq.${db.enc(addr)}`);
}
const listWatches = (userId) => db.select("watches", `user_id=eq.${userId}&select=address,chain,name,symbol&order=created_at.asc`);

module.exports = { addWatch, removeWatch, listWatches, evaluate, snapOf, norm, MAX_WATCH };
