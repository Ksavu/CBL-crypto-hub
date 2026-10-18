// Telegram message formatting (HTML parse mode).
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const NAMES = { ethereum: "Ethereum", bsc: "BNB Chain", base: "Base", robinhood: "Robinhood Chain", solana: "Solana" };
const EXPLORER = { ethereum: "https://etherscan.io/token/", bsc: "https://bscscan.com/token/", base: "https://basescan.org/token/", robinhood: "https://robinhoodchain.blockscout.com/token/", solana: "https://solscan.io/token/" };
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
    L.push("", `💧 Liquidity ${usd(m.liquidity)}   💰 MC ${usd(m.marketCap || m.fdv)}`,
      `📊 Vol 24h ${usd(m.volume24h)}   🕒 Age ${age(m.pairCreatedAt)}`,
      `💲 $${esc(Number(m.price).toPrecision(4))}${ch}`);
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
  const flags = r.reasons.filter((x) => ICON[x.sev]).slice(0, 6);
  if (flags.length) L.push("", ...flags.map((x) => `${ICON[x.sev]} ${esc(x.title)}`));
  const ok = r.reasons.filter((x) => x.sev === "ok").length;
  if (ok) L.push(`✅ ${ok} checks passed`);
  if (r.confidence === "medium" || r.confidence === "low") L.push("⚠️ Some data sources did not respond, result may be incomplete.");
  L.push("", `<code>${esc(r.address)}</code>`, "<i>Automated checks, not financial advice. DYOR.</i>");

  const rows = [[
    { text: "📋 Full report", url: `${site}/?ca=${r.address}#scanner` },
    ...(r.market && r.market.url ? [{ text: "📈 Chart", url: r.market.url }] : []),
    { text: "🔎 Explorer", url: EXPLORER[r.chain] + r.address },
  ], [
    { text: "🔄 Rescan", callback_data: "r:" + r.address },
    { text: "👁 Watch", callback_data: "w:" + r.address },
    { text: "💱 Swap", url: `${site}/?swap=${r.address}&chain=${r.chain}${r.flags && r.flags.sellTax >= 3 ? "&t=" + Math.round(r.flags.sellTax) : ""}#swap` },
  ]];
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
  "Works on <b>Ethereum, BNB Chain, Base and Solana</b>.",
  "",
  "<b>Commands</b>",
  "/scan &lt;address&gt; [eth|bsc|base|rh|sol]",
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
    { text: "🔄 Rescan", callback_data: "r:" + r.address },
    { text: "🔕 Unwatch", callback_data: "u:" + r.address },
  ]] } };
}
module.exports = { card, alertMsg, HELP, esc };
