const { deepChecks } = require("./deep");
// CBL risk scoring. Pure functions, no network. Input: normalized API data. Output: score + reasons.
const N = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const pc = (x) => { const n = N(x); return n === null ? null : n * 100; };
const DEAD = /^(0x0{40}|0x0{39}1|0x[0d]*dead[0-9a-f]*)$/i;
const PTS = { critical: 100, high: 25, medium: 10, low: 4, info: 0, ok: 0 };

function analyze(i) {
  const R = [];
  const add = (sev, title, detail) => R.push({ sev, title, detail: detail || "" });
  const { kind, pair, gp, hp, rc } = i;
  const hasSec = !!(gp && Object.keys(gp).length) || !!hp || !!rc || !!i.deep || !!i.ex;

  if (kind === "evm") {
    if (gp && Object.keys(gp).length) evmGoPlus(gp, hp, add);
    if (hp) evmHoneypot(hp, gp, add);
    if (i.ex && !(gp && Object.keys(gp).length)) evmExplorer(i.ex, hp, add);
  } else {
    if (gp && Object.keys(gp).length) solGoPlus(gp, add, !!i.deep);
    if (rc && rc.risks) {
      rc.risks.slice(0, 8).forEach((r) =>
        add(r.level === "danger" ? "high" : r.level === "warn" ? "medium" : "info", r.name, r.description));
      const bc = pair && /pump/i.test(pair.dexId || "") && !(pair.liquidity && pair.liquidity.usd);
      if (bc) add("info", "Still on the pump.fun bonding curve", "No liquidity pool yet, so LP lock does not apply. Risk is in the holders and the deployer.");
      else if (typeof rc.lpLockedPct === "number")
        add(rc.lpLockedPct >= 90 ? "ok" : rc.lpLockedPct >= 50 ? "medium" : "high",
          `${rc.lpLockedPct.toFixed(0)}% of liquidity locked or burned`);
    }
  }
  if (i.deep) deepChecks(i.deep, add);
  if (pair) marketChecks(pair, add);
  if (pair && i.links && !Object.keys(i.links).length) add("info", "No website or socials listed", "Official links are missing on DexScreener. Check the project yourself.");

  // Chains without GoPlus coverage: mint, blacklist and hidden-owner flags can't be checked, so never present a top score.
  const limited = kind === "evm" && !(gp && Object.keys(gp).length);
  if (limited && hasSec) add("info", "Limited coverage on this chain", "Mint, blacklist, pause and hidden-owner functions could not be checked automatically. Verify the contract yourself.");
  let score = 100;
  for (const r of R) score -= PTS[r.sev] || 0;
  const critical = R.some((r) => r.sev === "critical");
  score = Math.max(0, Math.min(100, score));
  if (critical) score = Math.min(score, 20);
  else if (limited) score = Math.min(score, 85);

  const sources = i.sources || {};
  const okCount = ["goplus", "honeypot", "rugcheck"].filter((k) => sources[k]).length;
  const confidence = !hasSec ? "none" : limited ? "medium" : okCount >= 2 && sources.dexscreener ? "high" : okCount >= 1 ? "medium" : "low";

  let verdict;
  if (!hasSec) verdict = "Security data unavailable";
  else if (critical) verdict = "Critical risk";
  else if (score >= 80) verdict = "Low risk";
  else if (score >= 60) verdict = "Moderate risk";
  else if (score >= 40) verdict = "High risk";
  else verdict = "Very high risk";

  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4, ok: 5 };
  R.sort((a, b) => order[a.sev] - order[b.sev]);
  return { score: hasSec ? score : null, verdict, confidence, reasons: R };
}

function evmGoPlus(s, hp, add) {
  const sim = hp && hp.simulationResult;
  if (s.is_honeypot === "1" || s.cannot_sell_all === "1") add("critical", "Honeypot risk", "Selling is blocked or restricted");
  else if (!(hp && hp.honeypotResult && hp.honeypotResult.isHoneypot)) add("ok", "No honeypot detected");
  if (s.cannot_buy === "1") add("critical", "Buying is blocked");
  if (s.selfdestruct === "1") add("critical", "Contract can self-destruct");
  if (s.hidden_owner === "1") add("critical", "Hidden owner");
  if (s.can_take_back_ownership === "1") add("critical", "Owner can take back ownership");
  if (s.owner_change_balance === "1") add("critical", "Owner can change balances");

  const gb = pc(s.buy_tax), gs = pc(s.sell_tax);
  const buy = sim && N(sim.buyTax) !== null ? N(sim.buyTax) : gb;
  const sell = sim && N(sim.sellTax) !== null ? N(sim.sellTax) : gs;
  if (buy === null && sell === null) add("info", "Tax unknown");
  else {
    const mx = Math.max(buy || 0, sell || 0);
    const t = `Buy tax ${buy === null ? "?" : buy.toFixed(1) + "%"} / Sell tax ${sell === null ? "?" : sell.toFixed(1) + "%"}`;
    const d = sim ? "Measured by a live buy and sell simulation" : "Reported by the contract analysis";
    add(mx >= 50 ? "critical" : mx >= 20 ? "high" : mx >= 10 ? "medium" : mx >= 3 ? "low" : "ok", t, d);
  }
  if (sim && gs !== null && sell !== null && Math.abs(gs - sell) > 5)
    add("medium", "Sources disagree about the sell tax", `Simulation ${sell.toFixed(1)}% vs contract analysis ${gs.toFixed(1)}%`);

  if (s.is_open_source === "0") add("medium", "Contract source not verified");
  else if (s.is_open_source === "1") add("ok", "Contract source verified");
  if (s.is_proxy === "1") add("medium", "Upgradeable proxy", "The contract logic can be changed");
  if (s.is_mintable === "1") add("high", "Mintable", "Owner can create new tokens");
  if (s.slippage_modifiable === "1") add("high", "Owner can change the tax");
  if (s.transfer_pausable === "1") add("medium", "Transfers can be paused");
  if (s.is_blacklisted === "1") add("medium", "Blacklist function");
  if (s.trading_cooldown === "1") add("low", "Trading cooldown");
  if (s.external_call === "1") add("low", "Makes external calls");
  if (parseInt(s.honeypot_with_same_creator, 10) > 0) add("high", "Creator launched honeypot tokens before");

  const ow = (s.owner_address || "").toLowerCase();
  if (s.hidden_owner !== "1" && s.can_take_back_ownership !== "1")
    !ow || DEAD.test(ow) ? add("ok", "Ownership renounced") : add("medium", "Ownership not renounced", `Owner ${ow.slice(0, 6)}...${ow.slice(-4)}`);

  const h = (s.holders || []).filter((x) => x.is_contract !== "1" && x.is_locked !== "1" && !DEAD.test(x.address || ""))
    .map((x) => pc(x.percent) || 0).sort((a, b) => b - a);
  if (h.length) {
    const t5 = h.slice(0, 5).reduce((a, b) => a + b, 0);
    add(h[0] >= 30 ? "high" : h[0] >= 15 ? "medium" : "ok", `Largest wallet holds ${h[0].toFixed(1)}%`,
      `Top 5 wallets ${t5.toFixed(1)}% (contracts, locked and burn wallets excluded)`);
  }
  const cp = pc(s.creator_percent), op = pc(s.owner_percent);
  if ((cp || 0) >= 10 || (op || 0) >= 10) add("medium", "Creator or owner holds a large share", `${Math.max(cp || 0, op || 0).toFixed(1)}% of supply`);
  const n = parseInt(s.holder_count, 10);
  if (n) add(n < 50 ? "medium" : n < 200 ? "low" : "ok", `${n.toLocaleString("en-US")} holders`);
  const lp = s.lp_holders;
  if (lp && lp.length) {
    const lk = lp.reduce((a, x) => a + (x.is_locked === "1" || DEAD.test(x.address || "") ? pc(x.percent) || 0 : 0), 0);
    add(lk >= 90 ? "ok" : lk >= 50 ? "medium" : "high", `${Math.min(100, lk).toFixed(0)}% of liquidity locked or burned`);
  } else add("info", "Liquidity lock unknown", "Common for V3 pools or very new tokens");
}

function evmExplorer(x, hp, add) {
  if (x.verified === true) add("ok", "Contract source verified");
  else if (x.verified === false) add("medium", "Contract source not verified");
  if (x.proxy) add("medium", "Upgradeable proxy", "The contract logic can be changed");
  if (x.ownerKnown) !x.owner || DEAD.test(x.owner) ? add("ok", "Ownership renounced") : add("medium", "Ownership not renounced", `Owner ${x.owner.slice(0, 6)}...${x.owner.slice(-4)}`);
  if (x.top1 !== null) add(x.top1 >= 30 ? "high" : x.top1 >= 15 ? "medium" : "ok", `Largest wallet holds ${x.top1.toFixed(1)}%`, `Top 5 wallets ${x.top5.toFixed(1)}% (contracts and burn wallets excluded)`);
  if (x.creatorPct !== null && x.creatorPct >= 10) add("medium", "Creator holds a large share", `${x.creatorPct.toFixed(1)}% of supply`);
  if (x.holders) add(x.holders < 50 ? "medium" : x.holders < 200 ? "low" : "ok", `${x.holders.toLocaleString("en-US")} holders`);
}

function evmHoneypot(hp, gp, add) {
  if (hp.honeypotResult && hp.honeypotResult.isHoneypot)
    add("critical", "Honeypot confirmed by simulation", hp.honeypotResult.honeypotReason || "A test sell failed");
  const ha = hp.holderAnalysis;
  if (ha && N(ha.holders) > 0 && N(ha.failed) !== null) {
    const r = N(ha.failed) / N(ha.holders);
    if (r >= 0.1) add("high", `${N(ha.failed)} of ${N(ha.holders)} sampled holders could not sell`);
  }
  if (hp.simulationResult && hp.simulationResult.buyTax !== undefined && !(gp && Object.keys(gp).length))
    add("info", "Taxes measured by live simulation");
}

function solGoPlus(s, add, skipHolders) {
  const st = (x) => (x && typeof x === "object" && "status" in x ? x.status : x);
  st(s.mintable) === "1" ? add("high", "Mint authority active", "Supply can be increased") : add("ok", "Mint authority revoked");
  st(s.freezable) === "1" ? add("high", "Freeze authority active", "Wallets can be frozen") : add("ok", "No freeze authority");
  if (st(s.closable) === "1") add("low", "Close authority active");
  if (st(s.balance_mutable_authority) === "1") add("critical", "Balances can be changed by an authority");
  if (st(s.metadata_mutable) === "1") add("low", "Metadata can be changed");
  if (s.non_transferable === "1") add("critical", "Non-transferable token");
  if (s.transfer_fee && typeof s.transfer_fee === "object" && Object.keys(s.transfer_fee).length) add("medium", "Token has a transfer fee");
  if (s.transfer_hook && s.transfer_hook.length) add("medium", "Transfer hook present");
  const h = (s.holders || []).map((x) => pc(x.percent) || 0).sort((a, b) => b - a);
  if (h.length && !skipHolders) {
    const t10 = h.slice(0, 10).reduce((a, b) => a + b, 0);
    add(t10 >= 60 ? "high" : t10 >= 30 ? "medium" : "ok", `Top 10 wallets hold ${t10.toFixed(1)}%`, "May include liquidity pool accounts");
  }
  const n = parseInt(s.holder_count, 10);
  if (n) add(n < 50 ? "medium" : n < 200 ? "low" : "ok", `${n.toLocaleString("en-US")} holders`);
}

function marketChecks(p, add) {
  const liq = p.liquidity && p.liquidity.usd;
  const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
  if (typeof liq === "number") add(liq < 5000 ? "high" : liq < 25000 ? "medium" : "ok", `Liquidity ${fmt(liq)} on ${p.dexId}`);
  if (p.pairCreatedAt) {
    const days = (Date.now() - p.pairCreatedAt) / 864e5;
    if (days < 1) add("high", "Pair is less than 24 hours old");
    else if (days < 7) add("low", `New pair (${Math.round(days)} days old)`);
  }
  const fdv = p.fdv || p.marketCap;
  if (liq && fdv && liq / fdv < 0.005) add("medium", "Very thin liquidity compared to market cap");
  const ch = p.priceChange && p.priceChange.h24;
  if (typeof ch === "number" && ch <= -50) add("high", `Price down ${Math.abs(ch).toFixed(0)}% in 24h`);
}

module.exports = { analyze };
