// Static Solidity checks. Pattern based, so it flags what to look at; it is not a formal audit.
// Output reasons use the same shape as the token scanner: { sev, title, detail, line? }.
const PTS = { critical: 100, high: 25, medium: 10, low: 4, info: 0, ok: 0 };

function strip(src) { // remove comments and string contents, keep line breaks so line numbers stay right
  let out = "", i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; }
    else if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; } i += 2; }
    else if (c === '"' || c === "'") { const q = c; out += q; i++; while (i < n && src[i] !== q && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } out += q; i++; }
    else { out += c; i++; }
  }
  return out;
}
const lineOf = (s, idx) => s.slice(0, idx).split("\n").length;

function functions(s) { // { name, header, body, line }
  const out = [], re = /\b(function\s+(\w+)|constructor|receive|fallback)\s*\(/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index; let p = s.indexOf("(", start), depth = 0, j = p;
    for (; j < s.length; j++) { if (s[j] === "(") depth++; else if (s[j] === ")") { depth--; if (!depth) break; } }
    let k = j; while (k < s.length && s[k] !== "{" && s[k] !== ";") k++;
    const header = s.slice(start, k);
    let body = "";
    if (s[k] === "{") { let d2 = 0, e = k; for (; e < s.length; e++) { if (s[e] === "{") d2++; else if (s[e] === "}") { d2--; if (!d2) break; } } body = s.slice(k, e + 1); }
    out.push({ name: m[2] || m[1], header, body, line: lineOf(s, start) });
  }
  return out;
}
const OWNERISH = /\b(onlyOwner|onlyAdmin|onlyOperator|onlyGovernance|onlyGovernor|onlyManager|onlyDev|onlyRole|auth|requiresAuth|onlyAuthorized)\b/;
const guarded = (f) => OWNERISH.test(f.header) || /require\s*\(\s*(_?msgSender\(\)|msg\.sender)\s*==\s*\w*(owner|admin|dev|operator|manager)\w*/i.test(f.body) || /_checkOwner\s*\(/.test(f.body);
const external = (f) => !/\b(private|internal)\b/.test(f.header);

function audit(source, meta) {
  meta = meta || {};
  const raw = String(source || "");
  const s = strip(raw);
  const R = [];
  const add = (sev, title, detail, line) => R.push({ sev, title, detail: detail || "", ...(line ? { line } : {}) });
  const fns = functions(s);
  const find = (re) => { const m = re.exec(s); return m ? lineOf(s, m.index) : 0; };
  const fn = (re) => fns.filter((f) => re.test(f.name));
  const contracts = (s.match(/\b(contract|library|interface)\s+\w+/g) || []).length;
  const loc = raw.split("\n").length;

  if (!/\bcontract\s+\w+/.test(s)) add("high", "No contract found in this code", "Paste complete Solidity source that contains a contract.");

  // --- critical: anyone can mint / sells can be blocked
  const mints = fns.filter((f) => external(f) && /_mint\s*\(/.test(f.body) && !/^(constructor|_)/.test(f.name) && !/^(_transfer|transfer|transferFrom|_update)$/.test(f.name));
  mints.forEach((f) => {
    if (guarded(f)) add("high", `Owner can mint new tokens (${f.name})`, "The supply is not fixed. The owner can create tokens and sell them.", f.line);
    else add("critical", `Anyone can mint tokens (${f.name})`, "This function creates tokens and has no access control.", f.line);
  });
  const sellBlock = /\b(to|recipient|_to)\s*==\s*\w*(pair|Pair|uniswap|pancake|router)\w*[^{;]*\)\s*\{[^{}]*(revert\b|require\s*\(\s*false)/.exec(s);
  if (sellBlock) add("critical", "Sells to the pool can be blocked", "Transfer code reverts when the receiver is the trading pair. This is a common honeypot pattern.", lineOf(s, sellBlock.index));

  // --- blacklist / trading switches
  const bl = /\b(\w*(blacklist|blocklist|banned|isBot|_bots?|bots)\w*)\s*\[/i.exec(s);
  if (bl) {
    const setter = fns.some((f) => /black|block|ban|bot/i.test(f.name) && external(f) && /\[[^\]]+\]\s*=/.test(f.body));
    if (setter) add("high", "Owner can blacklist wallets", "Blocked wallets can be stopped from selling or transferring.", lineOf(s, bl.index));
    else add("medium", "Contains a blacklist mapping", "No obvious setter found. Check who can fill it.", lineOf(s, bl.index));
  }
  const tr = /\b(tradingEnabled|tradingOpen|tradingActive|tradeEnabled|tradingStarted|launched|swapEnabled)\b/.exec(s);
  if (tr && /require\s*\([^;]*\b(tradingEnabled|tradingOpen|tradingActive|tradeEnabled|tradingStarted|launched)\b/.test(s)) {
    const off = fns.some((f) => external(f) && /=\s*(false|_?\w+)\s*;/.test(f.body) && /\b(trading|launched|swap)\w*/i.test(f.body) && /set|enable|open|trading|toggle/i.test(f.name));
    add(off ? "high" : "medium", off ? "Trading can be switched on and off by the owner" : "Trading must be enabled by the owner", off ? "The owner can freeze all buying and selling." : "Check that trading is already open before you buy.", tr ? lineOf(s, tr.index) : 0);
  }
  if (/\bwhenNotPaused\b|\bfunction\s+pause\s*\(|\bis\s+[^{]*\bPausable\b/.test(s)) add("medium", "Transfers can be paused", "A pause switch can stop all transfers.", find(/\bwhenNotPaused\b|\bfunction\s+pause\s*\(/));

  // --- fees
  const feeSetters = fns.filter((f) => external(f) && /^(set|update|change)\w*(fee|tax|slippage)\w*/i.test(f.name));
  feeSetters.forEach((f) => {
    const cap = /require\s*\([^;]*(<=|<)\s*(\d+)/.exec(f.body) || /if\s*\([^)]*>\s*(\d+)/.exec(f.body);
    const capVal = cap ? parseInt(cap[2] || cap[1], 10) : null;
    if (!guarded(f)) add("critical", `Anyone can change fees (${f.name})`, "Fee setter has no access control.", f.line);
    else if (capVal === null) add("high", `Owner can change fees without a cap (${f.name})`, "The owner could raise the sell tax to 100% and trap holders.", f.line);
    else if (capVal > 25) add("medium", `Owner can raise fees up to ${capVal} (${f.name})`, "High maximum fee.", f.line);
    else add("low", `Owner can change fees, capped at ${capVal} (${f.name})`, "", f.line);
  });
  const fixedFee = /\b(_?(sell|buy|total)?(Tax|Fee|TaxFee)\w*)\s*=\s*(\d{2,3})\s*;/gi; let fm;
  while ((fm = fixedFee.exec(s))) { const v = parseInt(fm[4], 10); if (v >= 25 && v <= 100 && /tax|fee/i.test(fm[1])) { add("high", `Very high fee set in code (${fm[1]} = ${v})`, "", lineOf(s, fm.index)); break; } }
  fns.filter((f) => external(f) && /^(set|update)\w*(max|limit)\w*/i.test(f.name) && /maxTx|maxWallet|maxTransaction|maxBuy|maxSell|limit/i.test(f.name + f.body)).slice(0, 1)
    .forEach((f) => add("medium", `Owner can change transaction or wallet limits (${f.name})`, "Setting a limit very low can stop people selling.", f.line));
  if (/\bcooldown\b|_lastTx|lastTrade/i.test(s)) add("low", "Trade cooldown", "Wallets may have to wait between trades.", find(/\bcooldown\b|_lastTx|lastTrade/i));

  // --- control of the pool / contract
  fns.filter((f) => external(f) && /^(set|update|change)\w*(router|pair|dex|amm)\w*/i.test(f.name)).slice(0, 1)
    .forEach((f) => add(guarded(f) ? "high" : "critical", `${guarded(f) ? "Owner" : "Anyone"} can change the router or pair (${f.name})`, "Trades could be redirected to a contract the owner controls.", f.line));
  fns.filter((f) => external(f) && guarded(f) && /^(withdraw|rescue|recover|emergency|sweep|clear|claim)\w*/i.test(f.name) && /\.transfer\s*\(|safeTransfer|\.call\s*\{?\s*value|transfer\s*\(/.test(f.body)).slice(0, 1)
    .forEach((f) => add(/IERC20|token|safeTransfer/i.test(f.body) ? "medium" : "low", `Owner can pull funds out of the contract (${f.name})`, "Normal for fee wallets, but check it cannot reach liquidity or user deposits.", f.line));
  fns.filter((f) => external(f) && /exclude|whitelist|isExcluded|setFeeExempt/i.test(f.name) && !/black|bot|ban/i.test(f.name) && guarded(f)).slice(0, 1)
    .forEach((f) => add("low", `Owner can exempt wallets from fees or limits (${f.name})`, "", f.line));
  if (/_previousOwner|\bfunction\s+unlock\s*\(|\bfunction\s+geUnlockTime\b/.test(s) && /\bfunction\s+lock\s*\(/.test(s)) add("high", "Fake renounce pattern (lock/unlock)", "Ownership is only locked for a time and can be taken back.", find(/_previousOwner|function\s+unlock/));

  // --- upgradeability and dangerous opcodes
  const up = /\bdelegatecall\b|\bupgradeTo\w*\s*\(|\bUUPSUpgradeable\b|\bTransparentUpgradeableProxy\b|\bInitializable\b/.exec(s);
  if (up) add("high", "Upgradeable or delegatecall code", "The logic can be swapped later, so what you audit may not be what runs.", lineOf(s, up.index));
  if (/\bselfdestruct\s*\(|\bsuicide\s*\(/.test(s)) add("medium", "Contains selfdestruct", "On many chains this can still send out all native funds.", find(/\bselfdestruct\s*\(|\bsuicide\s*\(/));
  if (/\btx\.origin\b/.test(s)) add("medium", "Uses tx.origin", "Can be abused by phishing contracts. Prefer msg.sender.", find(/\btx\.origin\b/));
  if (/\bassembly\s*(\(\s*"memory-safe"\s*\))?\s*\{/.test(s)) add("low", "Inline assembly", "Harder to review. Read these blocks carefully.", find(/\bassembly\s*(\(\s*"memory-safe"\s*\))?\s*\{/));
  const lowCall = /\.call\s*(\{[^}]*\})?\s*\([^;]*\)\s*;/g; let lc;
  while ((lc = lowCall.exec(s))) { const pre = s.slice(Math.max(0, lc.index - 30), lc.index); if (!/\(\s*bool|bool\s+\w+|,\s*\)\s*=|require\s*\(|=\s*$/.test(pre)) { add("low", "Low-level call without a checked result", "A failed call would be ignored.", lineOf(s, lc.index)); break; } }
  if (/\.call\s*\{\s*value/.test(s) && !/nonReentrant|ReentrancyGuard/.test(s)) add("low", "Sends native currency without a reentrancy guard", "Check that state is updated before the call.", find(/\.call\s*\{\s*value/));
  if (/block\.timestamp|blockhash|block\.difficulty|block\.prevrandao/.test(s) && /random|lottery|winner/i.test(s)) add("medium", "Weak randomness", "Block values can be influenced by validators.", find(/block\.timestamp|blockhash|block\.difficulty|block\.prevrandao/));

  // --- compiler and structure
  const pv = /pragma\s+solidity\s*([^;]+);/.exec(s);
  if (pv) {
    const ver = /(\d+)\.(\d+)\.(\d+)/.exec(pv[1]);
    if (ver && (+ver[1] === 0 && +ver[2] < 8) && !/SafeMath/.test(s)) add("medium", `Old compiler (${ver[0]}) without SafeMath`, "Math can overflow silently before Solidity 0.8.", lineOf(s, pv.index));
    else if (ver && +ver[1] === 0 && +ver[2] < 8) add("low", `Old compiler (${ver[0]})`, "Uses SafeMath. Newer versions have built-in checks.", lineOf(s, pv.index));
    if (/\^|>=/.test(pv[1])) add("low", "Floating pragma", "Pin an exact compiler version for release builds.", lineOf(s, pv.index));
  }

  // --- ownership summary
  const ownerFns = fns.filter((f) => external(f) && guarded(f) && f.name !== "constructor");
  const ren = /\bfunction\s+renounceOwnership\b/.test(s);
  if (ownerFns.length) add("info", `${ownerFns.length} owner-only function${ownerFns.length === 1 ? "" : "s"}`, ownerFns.slice(0, 8).map((f) => f.name).join(", ") + (ownerFns.length > 8 ? ", ..." : "") + (ren ? ". Ownership can be renounced." : "."));
  else if (/\bOwnable\b|\bowner\b/.test(s)) add("info", "Owner role present, no owner-only functions found");

  // --- good signs
  if (/\bReentrancyGuard\b|\bnonReentrant\b/.test(s)) add("ok", "Uses a reentrancy guard");
  if (/@openzeppelin|\bERC20\b/.test(raw) && /@openzeppelin/.test(raw)) add("ok", "Built on OpenZeppelin libraries");
  if (!R.some((r) => ["critical", "high"].includes(r.sev))) add("ok", "No critical or high-risk patterns found by the checks", "This does not prove the contract is safe.");

  let score = 100;
  for (const r of R) score -= PTS[r.sev] || 0;
  score = Math.max(0, Math.min(100, score));
  const critical = R.some((r) => r.sev === "critical");
  if (critical) score = Math.min(score, 20);
  const verdict = critical ? "Critical risk" : score >= 80 ? "Low risk" : score >= 60 ? "Moderate risk" : score >= 40 ? "High risk" : "Very high risk";
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4, ok: 5 };
  R.sort((a, b) => order[a.sev] - order[b.sev]);
  return { score, verdict, reasons: R, stats: { lines: loc, contracts, functions: fns.length, ownerFunctions: ownerFns.length } };
}

module.exports = { audit, strip };
