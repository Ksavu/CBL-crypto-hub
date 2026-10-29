// Telegram message formatting (HTML parse mode).
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const NAMES = { ethereum: "Ethereum", bsc: "BNB Chain", base: "Base", robinhood: "Robinhood Chain", solana: "Solana", xrpl: "XRP Ledger", terraclassic: "Terra Classic" };
const EXPLORER = { ethereum: "https://etherscan.io/token/", bsc: "https://bscscan.com/token/", base: "https://basescan.org/token/", robinhood: "https://robinhoodchain.blockscout.com/token/", solana: "https://solscan.io/token/", xrpl: "https://xrpscan.com/account/", terraclassic: "https://finder.terra-classic.hexxagon.io/mainnet/address/" };
const { CHAINS } = require("./source");
const chainName = (c) => (c && (NAMES[c] || (CHAINS[c] && CHAINS[c][1]))) || c;
// Telegram callback_data is max 64 bytes; Terra contracts are 64 chars, so "terra1" travels as "~".
const cb = (a) => (/^terra1/.test(a) ? "~" + a.slice(6) : a);
const uncb = (a) => (a && a[0] === "~" ? "terra1" + a.slice(1) : a);
const ICON = { critical: "🚨", high: "🔴", medium: "🟠", low: "🟡" };

function usd(n) {
  n = Number(n);
  if (!isFinite(n) || !n) return "n/a";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toPrecision(3);
}
function age(ms) {
  if (!ms) return "n/a";
  const d = (Date.now() - ms) / 864e5;
  return d < 1 ? Math.max(1, Math.round(d * 24)) + "h" : d < 60 ? Math.round(d) + "d" : Math.round(d / 30) + "mo";
}

function card(r, site, opt) {
  opt = opt || {};
  const dot = r.score === null ? "⚪" : r.score >= 80 ? "🟢" : r.score >= 60 ? "🟡" : r.score >= 40 ? "🟠" : "🔴";
  const L = [];
  L.push(`<b>${esc(r.token.name)}</b>${r.token.symbol ? ` (${esc(r.token.symbol)})` : ""} · ${NAMES[r.chain]}`);
  L.push(`${dot} <b>${r.score === null ? "n/a" : r.score + "/100"}</b> · ${esc(r.verdict)}`);
  if (r.market) {
    const m = r.market, ch = typeof m.change24h === "number" ? ` (${m.change24h >= 0 ? "+" : ""}${m.change24h}% 24h)` : "";
    L.push("", m.curve ? `💧 Bonding curve ${usd(m.liquidity)}${typeof m.curveProgress === "number" ? ` (${m.curveProgress}% to migration)` : ""}   💰 MC ${usd(m.marketCap || m.fdv)}` : `💧 Liquidity ${usd(m.liquidity)}   💰 MC ${usd(m.marketCap || m.fdv)}`,
      `📊 Vol 24h ${usd(m.volume24h)}   🕒 Age ${age(m.pairCreatedAt)}`,
      `💲 $${esc(Number(m.price).toPrecision(4))}${ch}`);
  }
  if (r.dex && (r.dex.paid !== null || r.dex.boosts || r.dex.cto)) {
    const d = r.dex, bits = [];
    if (d.paid !== null) bits.push(`🦅 DEX paid ${d.paid ? "✅" : "❌"}`);
    if (d.boosts) bits.push(`🚀 Boosts ${d.boosts}`);
    if (d.cto) bits.push("👥 Community takeover");
    if (d.ads) bits.push("📣 Ads running");
    L.push(bits.join(" · "));
  }
  if (r.chain === "xrpl" && r.xrplInfo && (r.xrplInfo.domain || r.xrplInfo.xrplaunch)) {
    const x = r.xrplInfo, bits = [];
    if (x.domain) bits.push(x.domainVerified ? `🌐 Domain verified ✅ ${esc(x.domain)}` : `🌐 Domain not verified (${esc(x.domain)})`);
    if (x.xrplaunch) bits.push("🚀 Launched on XRPLabs");
    L.push(bits.join(" · "));
  }
  if (r.chain === "terraclassic" && r.terraInfo) {
    const t = r.terraInfo, q = t.lp, pc = (n) => (n >= 99.95 ? "100" : n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%";
    L.push("", `${t.admin ? "⚠️ Upgradable (admin set)" : "🔒 Immutable contract"} · ${r.flags && r.flags.mint ? "🖨 Mintable" : "✅ Fixed supply"}`);
    if (q) L.push(q.burned >= 90 ? `🔥 LP ${pc(q.burned)} burned`
      : q.topPct >= 50 && q.topContract ? `🔐 LP: ${pc(q.topPct)} in a contract (locker or farm?)`
      : q.topPct >= 50 ? `🔓 LP: one wallet holds ${pc(q.topPct)}, can pull liquidity`
      : `💧 LP spread over ${q.providers} wallets${q.burned > 0.5 ? " · " + pc(q.burned) + " burned" : ""}`);
  }
  if (r.chain === "solana" || r.deep) {
    const d = r.deep;
    if (!d && opt.pending) L.push("", "🧬 Deep scan running… (holders, snipers, bundlers)");
    else if (!d) L.push("", "🧬 Deep scan unavailable");
    else {
      const p = (n) => (typeof n === "number" ? n.toFixed(1) + "%" : "n/a");
      L.push("", `🧬 Deployer ${d.traced ? p(d.deployerPct) : "n/a"} · Top 10 wallets ${p(d.top10)}${d.holders ? " · " + d.holders + " holders" : ""}`);
      const g = (x) => `${x.stillHolding} holding of ${x.wallets} · ${p(x.heldPct)} of supply${typeof x.boughtPct === "number" ? " · bought " + p(x.boughtPct) : ""}`;
      if (d.traced) L.push(`🎯 Snipers: ${d.snipers ? g(d.snipers) : "none detected"}`, `📦 Bundlers: ${d.bundlers ? g(d.bundlers) : "none detected"}`);
      else L.push("🎯 Snipers / 📦 Bundlers: n/a (launch too old to trace)");
    }
  }
  if (r.chain === "xrpl" && r.lp) {
    const q = r.lp, pc = (n) => (n >= 99.95 ? "100" : n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%";
    L.push("", q.safe >= 90 ? `🔥 LP ${pc(q.safe)} burned/locked forever${q.burned > 0.5 ? " · " + pc(q.burned) + " burned" : ""}${q.locked > 0.5 ? " · " + pc(q.locked) + " in blackholed wallet" : ""}`
      : q.topPct >= 50 && q.topSafe ? `🔒 LP: top wallet (${pc(q.topPct)}) is ${q.burned >= q.topPct - 0.1 ? "burned" : "blackholed"}`
      : q.topPct >= 50 ? `🔓 LP: one wallet holds ${pc(q.topPct)} and is NOT blackholed${q.checked ? "" : " (unverified)"}, can pull liquidity`
      : `💧 LP spread over ${q.providers} wallets${q.safe > 0.5 ? " · " + pc(q.safe) + " burned/locked" : " · not burned"}`);
  }
  const flags = r.reasons.filter((x) => ICON[x.sev]).slice(0, 6);
  if (flags.length) L.push("", ...flags.map((x) => `${ICON[x.sev]} ${esc(x.title)}`));
  const ok = r.reasons.filter((x) => x.sev === "ok").length;
  if (ok) L.push(`✅ ${ok} checks passed`);
  if (r.confidence === "medium" || r.confidence === "low") L.push("⚠️ Some data sources did not respond, result may be incomplete.");
  L.push("", `<code>${esc(r.address)}</code>`, "<i>Automated checks, not financial advice. DYOR.</i>");

  const rows = [[
    { text: "📋 Full report", url: `${site}/?ca=${r.address}#scanner` },
    ...(r.market && r.market.url ? [{ text: "📈 Chart", url: r.market.url }] : []),
    { text: "🔎 Explorer", url: EXPLORER[r.chain] + (r.chain === "xrpl" ? r.issuer : r.address) },
  ], [
    { text: "🔄 Rescan", callback_data: "r:" + cb(r.address) },
    { text: "👁 Watch", callback_data: "w:" + cb(r.address) },
    ...(r.chain === "terraclassic" ? [{ text: "💱 Swap", url: `${site}/?swap=${r.address}&chain=terraclassic#swap` }] : r.chain === "xrpl" ? [{ text: "💱 Swap", url: `${site}/?swap=${r.hex || r.address.split(".")[0]}.${r.issuer}&chain=xrpl#swap` }] : [{ text: "💱 Swap", url: `${site}/?swap=${r.address}&chain=${r.chain}${r.flags && r.flags.sellTax >= 3 ? "&t=" + Math.round(r.flags.sellTax) : ""}#swap` }]),
  ]];
  if (r.chain !== "solana" && r.chain !== "xrpl" && r.chain !== "terraclassic") rows.push([{ text: "🛡 Audit contract", callback_data: "a:" + r.address }]);
  const so = [];
  if (r.links && r.links.web) so.push({ text: "🌐 Website", url: r.links.web });
  if (r.links && r.links.x) so.push({ text: "𝕏", url: r.links.x });
  if (r.links && r.links.tg) so.push({ text: "✈️ Telegram", url: r.links.tg });
  if (r.links && r.links.dc) so.push({ text: "💬 Discord", url: r.links.dc });
  if (so.length) rows.splice(1, 0, so);
  return { text: L.join("\n"), reply_markup: { inline_keyboard: rows } };
}

const HELP = [
  "<b>CBL Scanner</b> 🔍",
  "Paste a token contract address and I'll check it for common red flags.",
  "",
  "Works on <b>Ethereum, BNB Chain, Base, Robinhood Chain, Solana, XRP Ledger and Terra Classic</b>.",
  "",
  "<b>Commands</b>",
  "/scan &lt;address&gt; [eth|bsc|base|rh|xrpl|sol|lunc]",
  "/audit &lt;0x address&gt; [network] – check the contract code on any EVM chain (eth, bsc, base, poly, arb, op, avax, ...)",
  "/watch &lt;address&gt; – get alerts in DM (rug signals)",
  "/unwatch &lt;address&gt;",
  "/list – your watchlist",
  "/help",
  "",
  "In groups I also scan any contract address posted in chat.",
  "<i>I never ask for keys or seed phrases and I never DM first.</i>",
].join("\n");

const SEV = { critical: "🚨", high: "🔴", medium: "🟠" };
function alertMsg(r, alerts, site) {
  const L = [`🚨 <b>${esc(r.token.name)}</b>${r.token.symbol ? ` (${esc(r.token.symbol)})` : ""} · ${NAMES[r.chain]}`, ""];
  alerts.forEach((a) => L.push(`${SEV[a.sev] || "⚠️"} ${esc(a.text)}`));
  L.push("", `<code>${esc(r.address)}</code>`, "<i>Automated check, can be delayed by a few minutes. Not financial advice.</i>");
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [[
    ...(r.market && r.market.url ? [{ text: "📈 Chart", url: r.market.url }] : []),
    { text: "🔄 Rescan", callback_data: "r:" + cb(r.address) },
    { text: "🔕 Unwatch", callback_data: "u:" + cb(r.address) },
  ]] } };
}

function auditCard(r, site) {
  const dot = r.score >= 80 ? "🟢" : r.score >= 60 ? "🟡" : r.score >= 40 ? "🟠" : "🔴";
  const L = [`🛡 <b>Contract audit</b> · ${esc(r.token.name)}${r.chain ? " · " + chainName(r.chain) : ""}`, `${dot} <b>${r.score}/100</b> · ${esc(r.verdict)}`, ""];
  const flags = r.reasons.filter((x) => ICON[x.sev]);
  flags.slice(0, 10).forEach((x) => L.push(`${ICON[x.sev]} ${esc(x.title)}${x.line ? ` <i>(line ${x.line})</i>` : ""}`));
  if (flags.length > 10) L.push(`… and ${flags.length - 10} more on the website`);
  const ok = r.reasons.filter((x) => x.sev === "ok").length;
  if (ok) L.push(`✅ ${ok} good sign${ok === 1 ? "" : "s"}`);
  if (r.audit && r.audit.lines) L.push("", `<i>${r.audit.lines} lines · ${r.audit.functions} functions · source: ${esc(r.audit.source)}</i>`);
  L.push("", `<code>${esc(r.address || "")}</code>`, "<i>Automated pattern checks, not a manual audit. A clean result does not mean the contract is safe. DYOR.</i>");
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [[
    { text: "📋 Full audit", url: `${site}/?audit=${r.address}#scanner` },
    ...(r.chain && CHAINS[r.chain] ? [{ text: "🔎 Explorer", url: CHAINS[r.chain][2] + r.address + "#code" }] : []),
  ]] } };
}
module.exports = { card, alertMsg, auditCard, HELP, esc, cb, uncb };
