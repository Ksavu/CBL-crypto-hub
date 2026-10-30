// Shared scan engine used by /api/scan (website) and /api/telegram (bot).
const { analyze } = require("./score");
const { deepSol } = require("./deep");
const { explorerEvm, evmLaunch, NET, EXPLORER_CHAINS } = require("./explorer");
const { fillSol } = require("./solmarket");
const { getOrders, dexPaid } = require("./dexpaid");
const EF = require("./evmfind");
const LP = require("./launchpads");

// DexScreener chain id -> EVM chain id (GoPlus / honeypot.is)
const EVM = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, optimism: 10, avalanche: 43114, linea: 59144, blast: 81457,
  zksync: 324, scroll: 534352, mantle: 5000, sonic: 146, unichain: 130, cronos: 25, robinhood: 4663 };
const OK_CHAINS = [...Object.keys(EVM), "solana"];
const cache = new Map(); // best-effort, per warm instance

async function j(url, ms = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function cleanUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href.slice(0, 300) : null; } catch (e) { return null; }
}
function extractLinks(pair) {
  const info = (pair && pair.info) || {}, L = {};
  for (const w of info.websites || []) { const u = cleanUrl(w && w.url); if (u && !L.web) L.web = u; }
  for (const s of info.socials || []) {
    const u = cleanUrl(s && s.url), t = String((s && s.type) || "").toLowerCase();
    if (!u) continue;
    if ((t === "twitter" || t === "x") && !L.x) L.x = u;
    else if (t === "telegram" && !L.tg) L.tg = u;
    else if (t === "discord" && !L.dc) L.dc = u;
  }
  return L;
}
const fail = (status, message) => Object.assign(new Error(message), { status });


const { runXrpl, isXrplId } = require("./xrpl");
const { runTerra, isTerraId } = require("./terra");
function detect(ca) {
  if (isTerraId(ca)) return "terra";
  if (isXrplId(ca)) return "xrpl";
  return /^0x[a-fA-F0-9]{40}$/.test(ca) ? "evm" : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) ? "sol" : "";
}

async function runScan(caIn, selIn, opts) {
  opts = opts || {};
  const ca = String(caIn || "").trim(), sel = String(selIn || "auto").toLowerCase();
  const kind = detect(ca);
  if (!kind) throw fail(400, "Invalid contract address");
  if (kind === "xrpl") {
    const k = "x|" + ca, h = cache.get(k);
    if (h && !opts.fresh && Date.now() - h.t < 60000) return h.v;
    const v = await runXrpl(ca); cache.set(k, { t: Date.now(), v }); return v;
  }
  if (kind === "terra") {
    const k = "t|" + ca.toLowerCase(), h = cache.get(k);
    if (h && !opts.fresh && Date.now() - h.t < 60000) return h.v;
    const v = await runTerra(ca); cache.set(k, { t: Date.now(), v });
    if (v.address !== ca.toLowerCase()) cache.set("t|" + v.address, { t: Date.now(), v }); // pair address was pasted
    return v;
  }
  if (sel !== "auto" && !OK_CHAINS.includes(sel)) throw fail(400, "Unsupported network");
  if (kind === "sol" && sel !== "auto" && sel !== "solana") throw fail(400, "That is a Solana address");
  if (kind === "evm" && sel === "solana") throw fail(400, "That is an EVM address");

  const now = Date.now(), key = ca.toLowerCase() + "|" + sel + (opts.noDeep ? "|nd" : ""), hit = cache.get(key);
  if (hit && !opts.fresh && now - hit.t < 60000) return hit.v;

  const low = ca.toLowerCase(), sources = {};
  const dx = await j("https://api.dexscreener.com/latest/dex/tokens/" + ca).catch(() => null);
  sources.dexscreener = !!dx;
  const liq = (p) => (p.liquidity && p.liquidity.usd) || 0;
  let pairs = ((dx && dx.pairs) || []).filter((p) => OK_CHAINS.includes(p.chainId) &&
    (kind === "sol" ? p.chainId === "solana" : p.baseToken.address.toLowerCase() === low || p.quoteToken.address.toLowerCase() === low));
  let chain = kind === "sol" ? "solana" : sel !== "auto" ? sel : null;
  if (!chain && pairs.length) chain = pairs.sort((a, b) => liq(b) - liq(a))[0].chainId;
  // Not on DexScreener (yet): GeckoTerminal search, then "does this contract exist on Robinhood Chain?"
  // Catches brand-new tokens and launchpad tokens still on their bonding curve (e.g. Pons on Robinhood).
  if (kind === "evm" && !pairs.some((p) => !chain || p.chainId === chain)) {
    const f = await EF.find(ca, chain || undefined).catch(() => null);
    if (f) { chain = chain || f.chain; if (f.pair) pairs = [f.pair]; sources.geckoterminal = !!f.pair; }
  }
  if (!chain) throw fail(404, "No trading pair found. Choose the network and try again.");
  pairs = pairs.filter((p) => p.chainId === chain).sort((a, b) => liq(b) - liq(a));
  let pair = pairs[0] || null;
  // Solana: DexScreener often has no liquidity/volume/age for new and pump.fun tokens; fill from other sources.
  if (kind === "sol") pair = await fillSol(ca, pair).catch(() => pair);

  // DexScreener paid orders (profile, community takeover, ads). Hype info only, never affects the score.
  const ordersP = getOrders(chain, ca);
  let gp = null, hp = null, rc = null, deep = null, ex = null;
  if (kind === "evm") {
    const id = EVM[chain];
    [gp, hp] = await Promise.all([
      j(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${low}`).then((r) => r.result && r.result[low]).catch(() => null),
      j(`https://api.honeypot.is/v2/IsHoneypot?address=${low}&chainID=${id}`).catch(() => null),
    ]);
    if (EXPLORER_CHAINS.includes(chain)) {
      ex = await Promise.race([explorerEvm(chain, low, pair && pair.pairAddress), new Promise((ok) => setTimeout(() => ok(null), 6000))]).catch(() => null);
      if (!opts.noDeep) {
        let err = null;
        const L = await Promise.race([
          evmLaunch(chain, low, pair && pair.pairCreatedAt, ex && ex.supplyRaw, ex && ex.creationTx),
          new Promise((ok) => setTimeout(() => ok({ traced: false, dbg: { why: "timeout" } }), 11000)),
        ]).catch((e) => { err = String(e && e.message || e); return null; });
        const dbg = Object.assign({ explorer: !!ex, error: err, net: NET.slice(0, 6) }, (L && L.dbg) || {});
        deep = { supply: null, deployerAmt: null, deployer: ex && ex.creator, deployerPct: ex ? ex.creatorPct : null, traced: !!(L && L.traced), debug: dbg, holderCount: ex ? ex.holders : null, top10Wallets: ex ? ex.top10 : null, bundlers: (L && L.bundlers) || null, snipers: (L && L.snipers) || null, notes: [] };
      }
    }
  } else {
    [gp, rc, deep] = await Promise.all([
      j(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${ca}`).then((r) => r.result && (r.result[ca] || r.result[Object.keys(r.result)[0]])).catch(() => null),
      j(`https://api.rugcheck.xyz/v1/tokens/${ca}/report/summary`).catch(() => null),
      opts.noDeep ? null : deepSol(ca).catch(() => null),
    ]);
  }
  sources.goplus = !!(gp && Object.keys(gp).length);
  sources.honeypot = !!hp;
  sources.rugcheck = !!rc;
  sources.explorer = !!ex;
  sources.helius = !!deep && kind === "sol";
  if (!pair && !sources.goplus && !sources.honeypot && !sources.rugcheck && !sources.explorer) throw fail(404, "No data found for this address on " + chain);

  const dexInfo = dexPaid(await ordersP, pair);
  const stv = (x) => (x && typeof x === "object" && "status" in x ? x.status : x);
  const hasGp = !!(gp && Object.keys(gp).length), sim = hp && hp.simulationResult;
  const flags = kind === "sol"
    ? { mint: hasGp ? stv(gp.mintable) === "1" : null, freeze: hasGp ? stv(gp.freezable) === "1" : null }
    : { honeypot: hasGp || hp ? !!((hp && hp.honeypotResult && hp.honeypotResult.isHoneypot) || (gp && (gp.is_honeypot === "1" || gp.cannot_sell_all === "1"))) : null,
        sellTax: sim && Number.isFinite(parseFloat(sim.sellTax)) ? parseFloat(sim.sellTax) : hasGp && Number.isFinite(parseFloat(gp.sell_tax)) ? parseFloat(gp.sell_tax) * 100 : null,
        owner: hasGp && gp.owner_address ? String(gp.owner_address).toLowerCase() : ex && ex.ownerKnown ? ex.owner : null };
  const links = extractLinks(pair);
  const a = analyze({ kind: kind === "sol" ? "sol" : "evm", chain, pair, gp, hp, rc, ex, sources, links, deep });
  // Launchpad origin: deployer contract (EVM), else DEX ids + vanity address endings (pump, bonk, LoL, 4444, b07...).
  const lpHit = (kind === "evm" && EF.launchpadByCreator(chain, ex && ex.creator)) || null;
  const lpGuess = LP.launchpadOf(chain, ca, pairs.map((p) => p.dexId).concat(pair && pair.curve ? ["pumpfun"] : []), [].concat(...pairs.map((p) => p.labels || [])));
  const launchpad = lpHit || (lpGuess && lpGuess.n) || null;
  const onCurve = pair ? !!pair.curve || (lpGuess && lpGuess.g === false) : !!launchpad;
  // The launchpad contract deployed the token; the real dev is whoever sent the launch transaction.
  let dev = null;
  if (launchpad && ex && ex.creationTx && chain === "robinhood") {
    const tx = await j(`https://robinhoodchain.blockscout.com/api/v2/transactions/${ex.creationTx}`, 3500).catch(() => null);
    dev = tx && tx.from && /^0x[a-fA-F0-9]{40}$/.test(tx.from.hash || "") ? tx.from.hash.toLowerCase() : null;
  }
  if (launchpad) a.reasons.unshift({ sev: "info", title: `Launched on ${launchpad}${onCurve ? " · still on the bonding curve" : ""}`, detail: EF.PAD_INFO[launchpad] || "" });
  const tok = pair ? (pair.baseToken.address.toLowerCase() === low ? pair.baseToken : pair.quoteToken) : {};
  const out = {
    ok: true, chain, address: ca, ts: now,
    token: { name: tok.name || (gp && (gp.token_name || (gp.metadata && gp.metadata.name))) || (ex && ex.name) || "Unknown token",
             symbol: tok.symbol || (gp && (gp.token_symbol || (gp.metadata && gp.metadata.symbol))) || (ex && ex.symbol) || "",
             logo: (pair && pair.info && pair.info.imageUrl) || null },
    market: pair ? { price: pair.priceUsd, liquidity: liq(pair), fdv: pair.fdv, marketCap: pair.marketCap,
             volume24h: pair.volume && pair.volume.h24, change24h: pair.priceChange && pair.priceChange.h24,
             pairCreatedAt: pair.pairCreatedAt || (deep && deep.launchTs ? deep.launchTs * 1000 : null), dex: pair.dexId, url: pair.url,
             curve: pair.curve || false, curveProgress: typeof pair.curveProgress === "number" ? Math.round(pair.curveProgress) : null, curveSol: pair.curveSol || null } : null,
    links, flags, dex: dexInfo, deep: deep ? { supply: deep.supply || null, deployerAmt: deep.deployerAmt != null ? deep.deployerAmt : null, deployer: deep.deployer || null, deployerPct: deep.deployerPct, traced: deep.traced, debug: deep.debug || null, holders: deep.holderCount, top10: deep.top10Wallets, bundlers: deep.bundlers || null, snipers: deep.snipers || null, notes: deep.notes } : null,
    launchpad, onCurve, creator: (lpHit ? dev : (deep && deep.deployer) || (ex && ex.creator)) || (gp && typeof gp.creator_address === "string" && /^0x[a-fA-F0-9]{40}$/.test(gp.creator_address) ? gp.creator_address.toLowerCase() : null)
      || (kind === "sol" && gp && Array.isArray(gp.creators) && gp.creators[0] && gp.creators[0].address) || null,
    score: a.score, verdict: a.verdict, confidence: a.confidence, reasons: a.reasons, sources,
  };
  if (kind === "sol" && !out.creator) { const c = await require("./devstats").solCreator(ca, null, true).catch(() => null); if (c) out.creator = c.creator; } // pump.fun dev from the bonding-curve account
  cache.set(key, { t: now, v: out });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = { runScan, detect, OK_CHAINS, EVM };
