// Deep Solana scan via Helius. Needs env HELIUS_API_KEY. Every step is optional: failures drop that check, never the scan.
const SYS = "11111111111111111111111111111111";
const short = (a) => a.slice(0, 4) + "..." + a.slice(-4);

async function deepSol(mint, budgetMs = 14000) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const post = async (url, body) => {
    const ms = left();
    if (ms < 400) throw new Error("budget");
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  const rpc = async (method, params) => {
    const r = await post("https://mainnet.helius-rpc.com/?api-key=" + key, { jsonrpc: "2.0", id: 1, method, params });
    if (r.error) throw new Error(r.error.message || "rpc");
    return r.result;
  };
  const D = { notes: [], traced: false };
  try {
    // 1. Mint basics
    const mi = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const info = mi && mi.value && mi.value.data && mi.value.data.parsed && mi.value.data.parsed.info;
    if (!info) return null;
    const supply = Number(info.supply) || 0;
    D.mintAuthority = info.mintAuthority || null;
    D.freezeAuthority = info.freezeAuthority || null;

    // 2. All holders by owner (DAS), fallback to the 20 largest accounts
    const bal = {}, taddr = {}; let complete = false;
    try {
      for (let p = 1; p <= 4; p++) {
        const r = await rpc("getTokenAccounts", { mint, page: p, limit: 1000 });
        const ta = (r && r.token_accounts) || [];
        for (const a of ta) if (a.owner) { bal[a.owner] = (bal[a.owner] || 0) + Number(a.amount || 0); if (!taddr[a.owner] && a.address) taddr[a.owner] = a.address; }
        if (ta.length < 1000) { complete = true; break; }
      }
    } catch (e) {}
    if (!Object.keys(bal).length) {
      try {
        const lg = await rpc("getTokenLargestAccounts", [mint]);
        const accs = ((lg && lg.value) || []).slice(0, 20);
        if (accs.length) {
          const ta = await rpc("getMultipleAccounts", [accs.map((a) => a.address), { encoding: "jsonParsed" }]);
          accs.forEach((a, i) => { const v = ta.value && ta.value[i]; const o = v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.owner; if (o) bal[o] = (bal[o] || 0) + Number(a.amount); });
        }
      } catch (e) {}
    }
    let holders = [];
    const ranked = Object.entries(bal).sort((a, b) => b[1] - a[1]);
    D.holderCount = complete ? ranked.length : null;
    if (ranked.length && supply) {
      const topO = ranked.slice(0, 20).map((x) => x[0]);
      const oa = await rpc("getMultipleAccounts", [topO, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      holders = topO.map((o, i) => { const v = oa.value && oa.value[i]; return { owner: o, pct: bal[o] / supply * 100, kind: !v || v.owner !== SYS ? "program" : "wallet" }; });
    }
    D.holders = holders;
    const real = holders.filter((h) => h.kind === "wallet");
    D.top10Wallets = real.slice(0, 10).reduce((a, h) => a + h.pct, 0);
    D.topWallet = real[0] || null;
    D.poolPct = holders.filter((h) => h.kind === "program").reduce((a, h) => a + h.pct, 0);

    // 3. Find the launch: oldest transactions of the mint
    let oldestList = null;
    try { // Helius ascending query (may need a paid plan)
      const r = await rpc("getTransactionsForAddress", [mint, { transactionDetails: "signatures", sortOrder: "asc", limit: 600 }]);
      const arr = (r && (r.data || r)) || [];
      if (Array.isArray(arr) && arr.length) D.path = "asc";
      if (Array.isArray(arr) && arr.length) oldestList = arr.map((x) => ({ signature: x.signature, blockTime: x.blockTime, slot: x.slot }));
    } catch (e) {}
    if (!oldestList) { // walk back page by page
      let before, last = [], reached = false;
      for (let p = 0; p < 30 && left() > 3500; p++) {
        const s = await rpc("getSignaturesForAddress", [mint, before ? { limit: 1000, before } : { limit: 1000 }]);
        if (!s || !s.length) { reached = p > 0; break; }
        last = s; before = s[s.length - 1].signature;
        if (s.length < 1000) { reached = true; break; }
      }
      if (reached && last.length) { oldestList = last.slice(-600).reverse(); D.path = "paged"; }
    }
    if (!oldestList || !oldestList.length) { D.notes.push("Launch could not be traced (token too old or too active)"); return D; }
    D.traced = true;
    const oldest = oldestList[0];

    // 4. Deployer = fee payer of the first transaction
    const tx = await rpc("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
    const dep = keys && keys[0] && (keys[0].pubkey || keys[0]);
    if (typeof dep === "string") {
      D.deployer = dep;
      D.deployerPct = supply && bal[dep] ? bal[dep] / supply * 100 : 0;
      D.deployerInTop = !!bal[dep];
      D.launchTs = oldest.blockTime || null;
      try {
        const ds = await rpc("getSignaturesForAddress", [dep, { limit: 1000 }]);
        if (ds && ds.length) {
          D.deployerTxCount = ds.length >= 1000 ? "1000+" : ds.length;
          const o = ds[ds.length - 1];
          if (ds.length < 1000 && o.blockTime && D.launchTs) D.deployerAgeDays = Math.max(0, (D.launchTs - o.blockTime) / 86400);
        }
      } catch (e) {}
    }

    // 5. Bundlers (same block as first buy) and snipers (next few blocks)
    try {
      const sg = oldestList.map((x) => x.signature), list = [];
      for (let i = 0; i < sg.length && left() > 2500; i += 100) {
        const r = await post("https://api.helius.xyz/v0/transactions?api-key=" + key, { transactions: sg.slice(i, i + 100) }).catch(() => []);
        if (Array.isArray(r)) list.push(...r.filter((t) => t && t.slot));
      }
      list.sort((a, b) => a.slot - b.slot);
      const pools = new Set(holders.filter((h) => h.kind === "program").map((h) => h.owner));
      const first = {}; const moves = [];
      let s0 = null;
      for (const t of list) for (const tr of t.tokenTransfers || []) {
        if (tr.mint !== mint || !tr.toUserAccount || !(tr.tokenAmount > 0)) continue;
        if (tr.fromUserAccount && tr.fromUserAccount !== tr.toUserAccount) moves.push([tr.fromUserAccount, tr.toUserAccount]);
        if (tr.toUserAccount === D.deployer || pools.has(tr.toUserAccount)) continue;
        if (s0 === null) s0 = t.slot;
        if (t.slot - s0 <= 30 && !(tr.toUserAccount in first)) first[tr.toUserAccount] = t.slot - s0;
      }
      const all = Object.keys(first);
      const same = all.filter((o) => first[o] <= 1);
      const bundled = same.length >= 2 ? same : [];
      const snipe = all.filter((o) => !bundled.includes(o) && first[o] <= 10);
      // follow the tokens: wallets that received them from an early buyer belong to the same group
      const spread = (seeds) => {
        const set = new Set(seeds);
        for (let pass = 0; pass < 3; pass++) for (const [f, t] of moves) if (set.has(f) && !set.has(t) && !pools.has(t) && t !== D.deployer) set.add(t);
        return [...set];
      };
      const bundledAll = spread(bundled);
      const snipeAll = spread(snipe).filter((o) => !bundledAll.includes(o));
      // holder-side check: when did each current holder first receive the token? Same-block groups = bundles
      const slotOf = {};
      try {
        const hs = Object.keys(bal).filter((o) => bal[o] > 0 && !pools.has(o) && o !== D.deployer && taddr[o])
          .sort((a, b) => bal[b] - bal[a]).slice(0, 80);
        for (let i = 0; i < hs.length && left() > 1500; i += 8) await Promise.all(hs.slice(i, i + 8).map(async (o) => {
          try {
            const r = await rpc("getTransactionsForAddress", [taddr[o], { transactionDetails: "signatures", sortOrder: "asc", limit: 1 }]);
            const a = (r && (r.data || r)) || [];
            if (Array.isArray(a) && a[0] && a[0].slot) slotOf[o] = a[0].slot;
          } catch (e) {}
        }));
      } catch (e) {}
      const bySlot = {}; Object.keys(slotOf).forEach((o) => (bySlot[slotOf[o]] = bySlot[slotOf[o]] || []).push(o));
      const grouped = Object.values(bySlot).filter((g) => g.length >= 3).flat();
      const cs = oldest.slot || 0;
      const earlyHold = Object.keys(slotOf).filter((o) => cs && slotOf[o] - cs <= 3 && !grouped.includes(o));
      bundledAll.push(...grouped.filter((o) => !bundledAll.includes(o)));
      earlyHold.forEach((o) => { if (!bundledAll.includes(o) && !snipeAll.includes(o)) snipeAll.push(o); });
      const hist = {}; all.forEach((o) => { hist[first[o]] = (hist[first[o]] || 0) + 1; });
      D.debug = { path: D.path, txsFetched: list.length, creationSlot: oldest.slot || null, firstBuySlotOffset: s0 === null ? null : s0 - (oldest.slot || s0),
        buyersBySlotOffset: hist, txsParsed: list.length, holderSlots: Object.keys(slotOf).length, sameSlotGroups: Object.values(bySlot).map((g) => g.length).filter((n) => n >= 2).sort((a, b) => b - a), seeds: { bundlers: bundled.length, snipers: snipe.length }, bundlerWallets: bundledAll.length, sniperWallets: snipeAll.length, holdersComplete: complete,
        holderList: Object.keys(bal).filter((o) => !pools.has(o) && bal[o] > 0).sort((a, b) => bal[b] - bal[a]).slice(0, 60).map((o) => o.slice(0, 3) + "..." + o.slice(-4) + " " + (bal[o] / supply * 100).toFixed(2) + "% slot+" + (slotOf[o] && cs ? slotOf[o] - cs : "?") + (bundledAll.includes(o) ? " B" : snipeAll.includes(o) ? " S" : "")) };
      const held = async (o) => {
        if (complete || bal[o]) return bal[o] || 0;
        try { const r = await rpc("getTokenAccountsByOwner", [o, { mint }, { encoding: "jsonParsed" }]);
          return (r.value || []).reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.amount || 0), 0); } catch (e) { return 0; }
      };
      const grp = async (ws) => {
        const amts = []; for (const o of ws.slice(0, complete ? 200 : 8)) amts.push(await held(o));
        return { wallets: ws.length, heldPct: supply ? amts.reduce((a, b) => a + b, 0) / supply * 100 : 0, stillHolding: amts.filter((x) => x > 0).length };
      };
      D.bundlers = bundledAll.length ? await grp(bundledAll) : null;
      D.snipers = snipeAll.length ? await grp(snipeAll) : null;
    } catch (e) { D.notes.push("Early buyer check unavailable"); D.earlyFailed = true; }
  } catch (e) {
    D.notes.push("Deep scan incomplete");
  }
  return D;
}

function deepChecks(D, add) {
  if (!D) return;
  const f = (n) => n.toFixed(1) + "%";
  if (D.mintAuthority === null && D.freezeAuthority === null) add("ok", "Mint and freeze authority revoked (on-chain check)");
  if (D.topWallet) add(D.topWallet.pct >= 20 ? "high" : D.topWallet.pct >= 10 ? "medium" : "ok",
    `Largest real wallet holds ${f(D.topWallet.pct)}`, `Pool and program accounts excluded. ${short(D.topWallet.owner)}`);
  if (D.holders && D.holders.length) add(D.top10Wallets >= 50 ? "high" : D.top10Wallets >= 30 ? "medium" : "ok",
    `Top 10 real wallets hold ${f(D.top10Wallets)}`, `Pools and programs hold another ${f(D.poolPct)}`);
  if (D.deployer) {
    const p = D.deployerPct || 0;
    add(p >= 10 ? "high" : p >= 3 ? "medium" : "ok",
      p ? `Deployer holds ${f(p)}` : D.deployerInTop ? "Deployer holds nothing" : "Deployer is not a top holder",
      `Deployer ${short(D.deployer)}`);
    if (typeof D.deployerAgeDays === "number" && D.deployerAgeDays < 2)
      add("medium", "Deployer wallet was created right before launch", `Wallet age ${D.deployerAgeDays.toFixed(1)} days, ${D.deployerTxCount} transactions`);
  }
  const grp = (g, label) => {
    if (!g) return;
    add(g.heldPct >= 10 ? "high" : g.heldPct >= 5 ? "medium" : "info", `${g.stillHolding} of ${g.wallets} ${label}`,
      `Together they hold ${f(g.heldPct)} of supply`);
  };
  grp(D.bundlers, "bundle wallets still hold tokens (bought in the launch block or received from those buyers)");
  grp(D.snipers, "sniper wallets still hold tokens (bought in the first seconds or received from those buyers)");
  (D.notes || []).forEach((n) => add("info", n));
}
module.exports = { deepSol, deepChecks };
