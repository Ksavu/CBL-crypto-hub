// Telegram message formatting (HTML parse mode).
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const NAMES = { ethereum: "Ethereum", bsc: "BNB Chain", base: "Base", robinhood: "Robinhood Chain", solana: "Solana", xrpl: "XRP Ledger", terraclassic: "Terra Classic" };
const EXPLORER = { ethereum: "https://etherscan.io/token/", bsc: "https://bscscan.com/token/", base: "https://basescan.org/token/", robinhood: "https://robinhoodchain.blockscout.com/token/", solana: "https://solscan.io/token/", xrpl: "https://xrpscan.com/account/", terraclassic: "https://finder.terra-classic.hexxagon.io/mainnet/address/" };
const { CHAINS } = require("./source");
const chainName = (c) => (c && (NAMES[c] || (CHAINS[c] && CHAINS[c][1]))) || c;
// Telegram callback_data is max 64 bytes; Terra contracts are 64 chars, so "terra1" travels as "~".
const cb = (a) => (/^terra1/.test(a) ? "~" + a.slice(6) : a);
const uncb = (a) => (a && a[0] === "~" ? "terra1" + a.slice(1) : a);
const SWAP_CHAINS = ["ethereum", "bsc", "base", "robinhood", "solana"]; // chains CBL Swap trades directly
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
  L.push(`<b>${esc(r.token.name)}</b>${r.token.symbol ? ` (${esc(r.token.symbol)})` : ""} · ${chainName(r.chain)}`);
  L.push(`${dot} <b>${r.score === null ? "n/a" : r.score + "/100"}</b> · ${esc(r.verdict)}`);
  if (opt.call) L.push(callLine(opt.call, r));
  if (r.launchpad) L.push(`🚀 Launched on <b>${esc(r.launchpad)}</b>${r.onCurve ? ` · on the bonding curve${r.market && typeof r.market.curveProgress === "number" ? " (" + r.market.curveProgress + "% to migration)" : ""}` : " · graduated 🎓"}`);
  if (r.market) {
    const m = r.market, ch = typeof m.change24h === "number" ? ` (${m.change24h >= 0 ? "+" : ""}${m.change24h}% 24h)` : "";
    L.push("", m.curve ? `💧 Bonding curve ${usd(m.liquidity)}${typeof m.curveProgress === "number" ? ` (${m.curveProgress}% to migration)` : ""}   💰 MC ${usd(m.marketCap || m.fdv)}` : `💧 Liquidity ${usd(m.liquidity)}   💰 MC ${usd(m.marketCap || m.fdv)}`,
      `📊 Vol 24h ${usd(m.volume24h)}   🕒 Age ${age(m.pairCreatedAt)}`,
      `💲 ${Number(m.price) > 0 ? "$" + esc(Number(m.price).toPrecision(4)) : "n/a"}${ch}`);
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
    ...(EXPLORER[r.chain] || (CHAINS[r.chain] && CHAINS[r.chain][2]) ? [{ text: "🔎 Explorer", url: (EXPLORER[r.chain] || CHAINS[r.chain][2]) + (r.chain === "xrpl" ? r.issuer : r.address) }] : []),
  ], [
    { text: "🔄 Rescan", callback_data: "r:" + cb(r.address) },
    { text: "👁 Watch", callback_data: "w:" + cb(r.address) },
    ...(r.chain === "terraclassic" ? [{ text: "💱 Swap", url: `${site}/?swap=${r.address}&chain=terraclassic#swap` }] : r.chain === "xrpl" ? [{ text: "💱 Swap", url: `${site}/?swap=${r.hex || r.address.split(".")[0]}.${r.issuer}&chain=xrpl#swap` }] : SWAP_CHAINS.includes(r.chain) ? [{ text: "💱 Swap", url: `${site}/?swap=${r.address}&chain=${r.chain}${r.flags && r.flags.sellTax >= 3 ? "&t=" + Math.round(r.flags.sellTax) : ""}#swap` }] : []),
  ]];
  const last = [], pad = r.launchpad && r.onCurve ? require("./launchpads").padUrl(r.launchpad, r.address) : null;
  // Four.meme (BNB Chain) and Pons (Robinhood) curves trade inside CBL Swap, so the 💱 Swap button covers them
  const inSwap = (r.chain === "bsc" && r.launchpad === "Four.meme") || (r.chain === "robinhood" && r.launchpad === "Pons") || r.chain === "solana";
  if (pad && !inSwap) last.push({ text: `🛒 Buy on ${r.launchpad}`, url: pad });
  if (r.chain !== "solana" && r.chain !== "xrpl" && r.chain !== "terraclassic") last.push({ text: "🛡 Audit contract", callback_data: "a:" + r.address });
  if (r.creator && (r.chain === "solana" || /^0x[a-f0-9]{40}$/i.test(r.creator))) {
    const hint = r.chain === "solana" ? "" : "|" + r.chain;
    last.push({ text: "📜 Dev history", callback_data: "v:" + cb(r.creator) + hint }, { text: "👤 Track dev", callback_data: "t:" + cb(r.creator) + hint });
  }
  if (last.length) rows.push(last);
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
  "Works on <b>Solana, XRP Ledger, Terra Classic</b> and EVM chains: <b>Ethereum, BNB Chain, Base, Arbitrum, Polygon, Optimism, Avalanche, Linea, Blast, zkSync, Scroll, Mantle, Sonic, Unichain, Cronos and Robinhood Chain</b>.",
  "",
  "<b>Commands</b>",
  "/scan &lt;address&gt; [eth|bsc|base|arb|poly|op|avax|linea|blast|zksync|scroll|mantle|sonic|uni|cro|rh|sol|xrpl|lunc]",
  "/audit &lt;0x address&gt; [network] – check the contract code on any EVM chain (eth, bsc, base, poly, arb, op, avax, ...)",
  "/watch &lt;address&gt; – get alerts in DM (rug signals)",
  "/unwatch &lt;address&gt;",
  "/list – your watchlist",
  "",
  "<b>Wallet tracker</b> 👤",
  "/track &lt;wallet&gt; [chain] [name] – alerts in DM when a wallet buys, sells, creates a token or moves tokens (EVM, Solana, XRPL, Terra)",
  "/wallet &lt;wallet&gt; – developer report: every token it created (live or dead) + last 7 days of trades",
  "/wallets – your tracked wallets",
  "/untrack &lt;wallet&gt;",
  "Tip: on a scan, tap 📜 Dev history to see the deployer's other tokens, or 👤 Track dev to follow them.",
  "",
  "/radar [safe|trending|new|gainers|curves] – top tokens right now with CBL scores (curves = still on Pump.fun, Pons, Four.meme… bonding curves)",
  "",
  "<b>Group calls</b> 🏆",
  "Post a contract address in a group: the first poster gets the call, and I track how high it goes.",
  "/lb [24h|7d|30d|all] – top callers in this group",
  "/calls [reply to someone] – your (or their) calls",
  "/xalerts on|off – X milestone alerts in this group (admins)",
  "",
  "/help",
  "",
  "In groups I also scan any contract address posted in chat.",
  "<i>I never ask for keys or seed phrases and I never DM first.</i>",
].join("\n");


// ---------- wallet tracker ----------
const TXURL = { solana: "https://solscan.io/tx/", xrpl: "https://xrpscan.com/tx/", terraclassic: "https://finder.terra-classic.hexxagon.io/mainnet/tx/" };
const ADDRURL = { solana: "https://solscan.io/account/", xrpl: "https://xrpscan.com/account/", terraclassic: "https://finder.terra-classic.hexxagon.io/mainnet/address/" };
const txUrl = (c, h) => (TXURL[c] || (CHAINS[c] ? CHAINS[c][2].replace(/\/(address|account)\/$/, "/tx/") : "")) + h;
const addrUrl = (c, a) => (ADDRURL[c] || (CHAINS[c] ? CHAINS[c][2] : "")) + a;
const shortA = (a) => (a ? String(a).slice(0, 6) + "…" + String(a).slice(-4) : "");
function amt(n) {
  n = Math.abs(Number(n)); if (!isFinite(n)) return "?";
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n ? Number(n.toPrecision(3)).toString() : "0";
}
const assets = (L) => L.map((x) => `${amt(x.amt)} ${esc(x.sym)}`).join(" + ");
const tokSym = (e, info) => esc((info && info.sym) || e.token.sym || (e.chain === "xrpl" ? String(e.token.id).split(".")[0] : shortA(e.token.id)));
const swapLink = (site, e) => e.chain === "xrpl" ? `${site}/?swap=${e.token.id}&chain=xrpl#swap` : `${site}/?swap=${e.token.id}&chain=${e.chain}#swap`;
const scanId = (e) => (e.chain === "xrpl" ? String(e.token.id).split(".")[1] : e.token.id);

/** One alert for one wallet event. who: label or short address. */
function walletAlert(w, who, e, info, site) {
  const head = { buy: "🟢 <b>BUY</b>", sell: "🔴 <b>SELL</b>", swap: "🔄 <b>SWAP</b>", create: "🆕 <b>NEW TOKEN</b>", transfer: "📤 <b>TRANSFER</b>" }[e.type];
  const s = tokSym(e, info), L = [`${head} · 👤 <b>${esc(who)}</b> · ${chainName(e.chain)}`];
  if (e.type === "buy") L.push(`Bought <b>${amt(e.amt)} ${s}</b> for <b>${assets(e.paid)}</b>`);
  else if (e.type === "sell") L.push(`Sold <b>${amt(e.amt)} ${s}</b> for <b>${assets(e.got)}</b>`);
  else if (e.type === "swap") L.push(`Swapped ${amt(e.from.amt)} ${esc(e.from.sym)} → <b>${amt(e.amt)} ${s}</b>`);
  else if (e.type === "transfer") L.push(`Sent <b>${amt(e.amt)} ${s}</b>${e.to ? ` to <a href="${addrUrl(e.chain, e.to)}">${shortA(e.to)}</a>` : ""}`);
  else if (e.type === "create") {
    const known = (info && info.sym) || e.token.sym;
    if (e.chain === "xrpl") L.push(`Opened an XRP pool for <b>${s}</b>`);
    else L.push(known ? `Created <b>${s}</b>${(info && info.name) || e.token.name ? ` (${esc((info && info.name) || e.token.name)})` : ""}` : e.chain === "solana" || e.chain === "terraclassic" ? "Created a new token" : "Deployed a new contract");
    if (e.amt) L.push(`Dev holds ${amt(e.amt)} ${s} from launch`);
  }
  if (info && (info.mcap || info.liq)) L.push(`💰 MC ${usd(info.mcap)} · 💧 Liq ${usd(info.liq)}`);
  L.push(`<code>${esc(e.chain === "xrpl" && e.token.sym ? e.token.sym + "." + String(e.token.id).split(".")[1] : e.token.id)}</code>`, `<a href="${txUrl(e.chain, e.hash)}">View tx</a> · <a href="${addrUrl(e.chain, w.address)}">${shortA(w.address)}</a>`);
  const row1 = [{ text: "🔍 Scan", callback_data: "s:" + cb(scanId(e)) }];
  if (info && info.url) row1.push({ text: "📈 Chart", url: info.url });
  if (SWAP_CHAINS.includes(e.chain) || e.chain === "xrpl" || e.chain === "terraclassic") row1.push({ text: "💱 Buy", url: swapLink(site, e) });
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [row1, [{ text: "🔕 Untrack wallet", callback_data: "x:" + cb(w.address) }]] } };
}

/** /wallet report: recent activity summary. */
function walletReport(r, site, tracked) {
  const n = (t) => r.events.filter((e) => e.type === t).length;
  const where = r.chains.map(chainName).join(", ") || "no active EVM chains found";
  const L = [`👤 <b>Wallet</b> <code>${esc(r.address)}</code>`, `Chains: ${esc(where)}`, "",
    `Last 7 days: 🟢 ${n("buy") + n("swap")} buys · 🔴 ${n("sell")} sells · 🆕 ${n("create")} new tokens · 📤 ${n("transfer")} transfers`];
  const top = r.events.slice(0, 10);
  if (top.length) {
    L.push("");
    for (const e of top) {
      const s = esc(e.token.sym || (e.chain === "xrpl" ? String(e.token.id).split(".")[0] : shortA(e.token.id)));
      const when = Math.max(1, Math.round((Date.now() / 1000 - e.ts) / 3600));
      const what = e.type === "buy" ? `🟢 Bought ${amt(e.amt)} ${s} for ${assets(e.paid)}` : e.type === "sell" ? `🔴 Sold ${amt(e.amt)} ${s} for ${assets(e.got)}`
        : e.type === "swap" ? `🔄 ${amt(e.from.amt)} ${esc(e.from.sym)} → ${amt(e.amt)} ${s}` : e.type === "create" ? (e.token.sym || e.chain !== "evm" && !/^0x/.test(e.token.id) ? `🆕 Created ${s}` : "🆕 Deployed a contract") : `📤 Sent ${amt(e.amt)} ${s}`;
      L.push(`<a href="${txUrl(e.chain, e.hash)}">${when < 48 ? when + "h" : Math.round(when / 24) + "d"}</a> · ${what}${r.chains.length > 1 ? " · " + chainName(e.chain) : ""}`);
    }
  } else L.push("", "No buys, sells or new tokens found in the last 7 days.");
  L.push("", "<i>Based on public explorer data. Not financial advice.</i>");
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [[tracked ? { text: "🔕 Untrack", callback_data: "x:" + cb(r.address) } : { text: "👤 Track this wallet", callback_data: "t:" + cb(r.address) + (r.family === "evm" && r.chains.length === 1 ? "|" + r.chains[0] : "") }]] } };
}

/** /wallet and 📜 Dev history: tokens this wallet created + recent trades. */
function devReportMsg(r, site, tracked) {
  const C = r.created, n = (s) => C.filter((t) => t.status === s).length, now = Date.now() / 1000;
  const ago = (ts) => { if (!ts) return "?"; const d = (now - ts) / 86400; return d < 1 / 24 ? Math.max(1, Math.round(d * 1440)) + "m" : d < 1 ? Math.round(d * 24) + "h" : Math.round(d) + "d"; };
  const sym = (t) => esc(t.sym || (t.chain === "xrpl" ? String(t.id).split(".")[0] : shortA(t.id)));
  const lnk = (t) => (t.url ? `<a href="${t.url}">${sym(t)}</a>` : `<b>${sym(t)}</b>`);
  const where = r.family === "evm" ? (r.chains.map(chainName).join(", ") || "no recent EVM activity") : chainName(r.family);
  const o = r.origin, L = [];
  if (r.fromToken) L.push(`<i>That's a token. Its creator:</i>`);
  L.push(`👷 <b>Dev</b> <code>${esc(r.address)}</code> · ${esc(where)}`);
  const rows = [];
  if (C.length) {
    const ts = C.map((t) => t.ts).filter(Boolean), first = ts.length ? Math.min(...ts) : null, days = first ? Math.max(1, (now - first) / 86400) : null;
    rows.push(`Deployed: <b>${C.length}${r.historyDone === false ? "+" : ""}</b>${days && C.length > 1 ? (C.length / days >= 0.1 ? ` (${(C.length / days).toFixed(1)}/day)` : ` (${(C.length / days * 7).toFixed(1)}/week)`) : ""}`);
    const bonded = C.filter((t) => t.graduated).length;
    if (r.family === "solana" || bonded) rows.push(`Bonded: <b>${bonded}</b> (${Math.round(bonded / C.length * 100)}%)`);
    else rows.push(`Live: <b>${n("live")}</b> · Dead: ${n("dead")}`);
    const withAth = C.filter((t) => t.ath), hits = withAth.filter((t) => t.ath >= 100000).length;
    if (r.ath && r.ath.total) rows.push(`Hits: <b>${hits}</b> ≥$100K${r.ath.checked < r.ath.total ? ` <i>(${r.ath.checked}/${r.ath.total} checked)</i>` : ""}`);
  } else rows.push("Deployed: <b>0</b> found");
  if (o && o.firstTs) rows.push(`Wallet: ${o.complete ? "" : "&gt;"}${ago(o.firstTs)} old`);
  if (o && o.funder) rows.push(`Funded: ${o.funderLabel ? "<b>" + esc(o.funderLabel) + "</b>" : `<code>${esc(shortA(o.funder))}</code>`}${o.firstTs ? ` (${ago(o.firstTs)} ago)` : ""}`);
  const lastTs = C.map((t) => t.ts).filter(Boolean).sort((a, b) => b - a)[0];
  if (lastTs) rows.push(`Last: ${ago(lastTs)} ago`);
  rows.forEach((x, k) => L.push(`${k === rows.length - 1 ? "└" : "├"} ${x}`));
  if (r.historyDone === false) L.push("⏳ <i>Older launches are still loading. Tap 🔄 Refresh in a minute for the full count.</i>");
  if (C.length >= 5 && n("dead") / C.length >= 0.8) L.push(`⚠️ <b>Serial launcher:</b> ${n("dead")} of ${C.length} tokens are dead.`);
  const top = C.filter((t) => t.ath >= 10000).sort((a, b) => b.ath - a.ath).slice(0, 5);
  if (top.length) { L.push("", "🏆 <b>Top ATH</b>"); top.forEach((t) => L.push(`• ${lnk(t)} @ ${t.mcap ? usd(t.mcap) : "?"} → ${usd(t.ath)} (${ago(t.ts)})`)); }
  if (C.length) {
    L.push("", "🆕 <b>Latest</b>");
    C.slice(0, 10).forEach((t) => L.push(`• ${lnk(t)} ${t.mcap ? "@ " + usd(t.mcap) : t.status === "dead" ? "💀" : "· no market yet"}${t.graduated ? " 🎓" : ""} (${ago(t.ts)})${t.id === r.fromToken ? " 👈" : ""}${r.family === "evm" && r.chains.length > 1 ? " · " + chainName(t.chain) : ""}`));
    if (r.fromToken && !C.slice(0, 10).some((t) => t.id === r.fromToken)) { const t = C.find((x) => x.id === r.fromToken); if (t) L.push(`• ${lnk(t)} ${t.mcap ? "@ " + usd(t.mcap) : ""} 👈`); }
  } else if (r.family === "evm") L.push("<i>Counts tokens it deployed itself. Launches through a factory (four.meme, Clanker…) show up as buys.</i>");
  const E = r.events || [], k = (t) => E.filter((e) => e.type === t).length;
  if (E.length) L.push("", `<b>Last 7 days:</b> 🟢 ${k("buy") + k("swap")} buys · 🔴 ${k("sell")} sells · 📤 ${k("transfer")} transfers`);
  L.push("", "<i>From public chain data (ATH from daily candles). Not financial advice.</i>");
  const kb = [[tracked ? { text: "🔕 Untrack", callback_data: "x:" + cb(r.address) } : { text: "👤 Track this dev", callback_data: "t:" + cb(r.address) + (r.family === "evm" && r.chains.length === 1 ? "|" + r.chains[0] : "") }]];
  const latest = (r.fromToken && C.find((t) => t.id === r.fromToken)) || C.find((t) => t.status !== "dead") || C[0];
  if (latest) kb[0].push({ text: "🔍 Scan " + (latest.id === r.fromToken ? "token" : "latest"), callback_data: "s:" + cb(latest.chain === "xrpl" ? String(latest.id).split(".")[1] : latest.id) });
  kb.push([{ text: "🔄 Refresh", callback_data: "v:" + cb(r.address) + (r.family === "evm" && r.chains.length === 1 ? "|" + r.chains[0] : "") }]);
  if (site) kb[1].push({ text: "🌐 Full dev report", url: `${site}/wallet?w=${encodeURIComponent(r.address)}${r.family === "evm" && r.chains.length === 1 ? "&chain=" + r.chains[0] : ""}` });
  return { text: L.join("\n").slice(0, 4000), reply_markup: { inline_keyboard: kb } };
}

/** /radar: top tokens from the Token Radar snapshot. mode: safe | trending | new | gainers */
function radarMsg(rows, mode, site) {
  const ok = (r) => !(r.s && (r.s.honeypot || r.s.score < 40));
  const pick = {
    safe: rows.filter((r) => r.s && r.s.score >= 70 && !r.s.honeypot && r.liq >= 20000).sort((a, b) => b.trend - a.trend),
    trending: rows.filter(ok).sort((a, b) => b.trend - a.trend),
    new: rows.filter((r) => ok(r) && r.created && Date.now() - r.created < 864e5).sort((a, b) => b.created - a.created),
    gainers: rows.filter((r) => ok(r) && r.ch1h > 0 && r.liq >= 5000).sort((a, b) => b.ch1h - a.ch1h),
  }[mode] || [];
  if (mode === "curve") pick.push(...(rows.curve || []).filter(ok).sort((a, b) => (b.heat || 0) - (a.heat || 0)));
  const title = { safe: "🛡 Safer trending picks", trending: "🔥 Trending now", new: "🆕 New pairs (under 24h)", gainers: "🚀 Top gainers (1h)", curve: "🎢 Hot on bonding curves" }[mode];
  const pc = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + (Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(1)) + "%");
  const L = [`📡 <b>CBL Token Radar</b> · ${title}`, ""];
  pick.slice(0, 10).forEach((r, i) => {
    const sc = r.s ? `${r.s.score >= 80 ? "🟢" : r.s.score >= 60 ? "🟡" : r.s.score >= 40 ? "🟠" : "🔴"} ${r.s.score}` : "⚪ n/a";
    const lp = r.lp ? ` · ${{ pump: "💊", bonk: "🐕", four: "4️⃣", clanker: "🔨", virt: "🤖", zora: "🌀", lol: "😂", moon: "🌙", hood: "🪶", robin: "🏹", pons: "🌉", klik: "🖱", printr: "🖨" }[r.lp.k] || "🚀"} ${esc(r.lp.n)}${r.lp.g === false ? " (curve)" : ""}` : "";
    L.push(`${i + 1}. <a href="${site}/?ca=${encodeURIComponent(r.ca)}#scanner">${esc(r.sym || "?")}</a> · ${chainName(r.chain)} · ${sc}${lp}${r.koth ? " · 👑" : ""}`,
      mode === "curve" ? `    MC ${usd(r.mcap)}${r.progress != null ? " · curve " + Math.round(r.progress) + "%" : ""}${r.tx1h ? " · " + r.tx1h + " trades/1h" : r.holders ? " · " + r.holders + " holders" : ""}\n    <code>${esc(r.ca)}</code>`
        : `    MC ${usd(r.mcap)} · Liq ${usd(r.liq)} · 1h ${pc(r.ch1h)} · Vol ${usd(r.vol24)}`);
  });
  if (!pick.length) L.push(mode === "curve" ? "No bonding-curve tokens loaded yet. The feed refreshes every 5 minutes; try again shortly or use /radar trending." : "Nothing matches right now. Try /radar trending.");
  L.push("", "<i>Scores flag common red flags, not guarantees. DYOR.</i>");
  const b = (m, t) => ({ text: (m === mode ? "• " : "") + t, callback_data: "rd:" + m });
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [[b("safe", "🛡 Safer"), b("trending", "🔥 Trending"), b("new", "🆕 New")], [b("gainers", "🚀 Gainers"), b("curve", "🎢 Curves")], [{ text: "📡 Open Token Radar", url: `${site}/radar?tab=${mode}` }]] } };
}

// ---------- first calls (groups) ----------
const callWho = (c) => esc(c.username ? "@" + c.username : c.name || "anon");
const fx = (x) => String(x >= 100 ? Math.round(x) : x >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, "") + "x";
const ago = (iso) => { const m = (Date.now() - Date.parse(iso)) / 60000; return m < 60 ? Math.max(1, Math.round(m)) + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
function callLine(c, r) {
  if (c.isNew) return `🎯 <b>First call</b> by ${callWho(c)}${c.mcap ? " at " + usd(c.mcap) + " MC" : ""}`;
  const now = r && r.market ? Number(r.market.marketCap || r.market.fdv) || null : null, x = c.mcap && now ? now / c.mcap : null, pk = c.mcap && c.peak_mcap ? Math.max(c.peak_mcap, now || 0) / c.mcap : null;
  return `🏆 First call: ${callWho(c)} · ${c.mcap ? usd(c.mcap) : "?"}${now ? " → " + usd(now) : ""}${x ? ` (<b>${fx(x)}</b>)` : ""}${pk && pk >= 1.5 && (!x || pk > x * 1.05) ? ` · peak ${fx(pk)}` : ""} · ${ago(c.created_at)} ago`;
}
function lbMsg(res, days, title) {
  const span = days === 1 ? "24h" : days ? days + " days" : "all time";
  const L = [`🏆 <b>Top callers</b>${title ? " · " + esc(title) : ""} · ${span}`, ""];
  if (!res.users.length) L.push("No calls yet. Post a token contract address in this group and I'll track who called it first.");
  const medal = ["🥇", "🥈", "🥉"];
  res.users.slice(0, 10).forEach((u, i) => L.push(`${medal[i] || (i + 1) + "."} <b>${esc(u.who)}</b> · avg ${fx(u.avg)} · ${u.n} call${u.n === 1 ? "" : "s"} · ${Math.round(u.hit * 100)}% hit 2x+ · best ${fx(u.best.x)} ${esc(u.best.sym || "")}`));
  if (res.top.length) { L.push("", "<b>Best calls</b>"); res.top.forEach((c) => L.push(`🚀 ${esc(c.sym || shortA(c.address))} · <b>${fx(c.x)}</b> · ${esc(c.who)} · ${usd(c.mcap)} → ${usd(c.peak_mcap)} peak`)); }
  L.push("", "<i>X = peak market cap since the first call. Not financial advice.</i>");
  const b = (d, t) => ({ text: (d === days ? "• " : "") + t, callback_data: "lb:" + d });
  return { text: L.join("\n"), reply_markup: { inline_keyboard: [[b(1, "24h"), b(7, "7d"), b(30, "30d"), b(0, "All")]] } };
}
function callsMsg(rows, name) {
  const L = [`📒 <b>Calls by ${esc(name)}</b>`, ""];
  if (!rows.length) L.push("No calls in this group yet.");
  rows.forEach((c) => L.push(`${c.x >= 2 ? "🟢" : c.x >= 1 ? "🟡" : "🔴"} ${esc(c.sym || shortA(c.address))} · ${chainName(c.chain)} · ${usd(c.mcap)} → ${usd(c.last_mcap)} · peak <b>${c.x ? fx(c.x) : "?"}</b> · ${ago(c.created_at)} ago`));
  return L.join("\n");
}
function xAlertMsg(a, site) {
  const c = a.call;
  return { text: `🚀 <b>${esc(c.sym || shortA(c.address))} just hit ${a.hit}x</b> from ${callWho(c)}'s call!\n${usd(c.mcap)} → <b>${usd(a.mcap)}</b> MC (${fx(a.x)}) · called ${ago(c.created_at)} ago\n<code>${esc(c.address)}</code>`,
    reply_markup: { inline_keyboard: [[...(a.url ? [{ text: "📈 Chart", url: a.url }] : []), { text: "🔍 Scan", callback_data: "s:" + cb(c.chain === "xrpl" ? String(c.address).split(".")[1] || c.address : c.address) }, { text: "🏆 Leaderboard", callback_data: "lb:7" }]] } };
}

const SEV = { critical: "🚨", high: "🔴", medium: "🟠" };
function alertMsg(r, alerts, site) {
  const L = [`🚨 <b>${esc(r.token.name)}</b>${r.token.symbol ? ` (${esc(r.token.symbol)})` : ""} · ${chainName(r.chain)}`, ""];
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
module.exports = { card, alertMsg, auditCard, HELP, esc, cb, uncb, walletAlert, walletReport, devReportMsg, radarMsg, lbMsg, callsMsg, xAlertMsg, chainName, shortA };
