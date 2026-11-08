// Deep Solana scan via Helius. Needs env HELIUS_API_KEY. Every step is optional: failures drop that check, never the scan.
const SYS = "11111111111111111111111111111111";
// Is this address a normal wallet (on the ed25519 curve) or a program-derived address?
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const P = (1n << 255n) - 19n, DC = (((-121665n % P) + P) % P) * modpow(121666n, P - 2n, P) % P;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function onCurve(addr) {
  try {
    let n = 0n; for (const c of addr) { const i = B58.indexOf(c); if (i < 0) return true; n = n * 58n + BigInt(i); }
    let y = 0n; for (let i = 0; i < 32; i++) y |= ((n >> BigInt(8 * i)) & 255n) << BigInt(8 * i); // little-endian bytes from big-endian number
    const bytes = []; let t = n; for (let i = 0; i < 32; i++) { bytes.unshift(Number(t & 255n)); t >>= 8n; }
    y = 0n; for (let i = 0; i < 32; i++) y |= BigInt(bytes[i]) << BigInt(8 * i);
    y &= (1n << 255n) - 1n;
    const y2 = y * y % P, u = (y2 - 1n + P) % P, v = (DC * y2 + 1n) % P;
    if (u === 0n) return true;
    const r = u * modpow(v, P - 2n, P) % P;
    return modpow(r, (P - 1n) / 2n, P) === 1n;
  } catch (e) { return true; }
}
const JITO = new Set(["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ4Wr9SMA", "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"]);
const short = (a) => a.slice(0, 4) + "..." + a.slice(-4);

async function deepSol(mint, budgetMs = 25000) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
  const post = async (url, body) => {
    const ms = left();
    if (ms < 400) throw new Error("budget");
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    try {
      let r = await fetch(url, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      for (let k = 0; r.status === 429 && k < 2 && left() > 1500; k++) { await new Promise((z) => setTimeout(z, 400 * (k + 1))); D.retries = (D.retries || 0) + 1;
        r = await fetch(url, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  const rpc = async (method, params) => {
    const r = await post("https://mainnet.helius-rpc.com/?api-key=" + key, { jsonrpc: "2.0", id: 1, method, params });
    if (r.error) throw new Error(r.error.message || "rpc");
    return r.result;
  };
  const D = { notes: [], traced: false, errs: {} };
  const bad = (tag, e) => { const k = tag + ": " + String((e && e.message) || e).slice(0, 80); D.errs[k] = (D.errs[k] || 0) + 1; };
  try {
    // 1. Mint basics
    const mi = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const info = mi && mi.value && mi.value.data && mi.value.data.parsed && mi.value.data.parsed.info;
    if (!info) return null;
    const supply = Number(info.supply) || 0;
    D.supply = String(info.supply || "");
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
      holders = topO.map((o, i) => { const v = oa.value && oa.value[i]; return { owner: o, pct: bal[o] / supply * 100, kind: (!onCurve(o) || (v && v.owner !== SYS)) ? "program" : "wallet" }; }); // off-curve = PDA (pool/curve authority) even if it holds SOL
    }
    D.holders = holders;
    const real = holders.filter((h) => h.kind === "wallet");
    D.top10Wallets = real.slice(0, 10).reduce((a, h) => a + h.pct, 0);
    D.topWallet = real[0] || null;
    D.poolPct = holders.filter((h) => h.kind === "program").reduce((a, h) => a + h.pct, 0);

    // 3. Find the launch: oldest transactions of the mint
    let oldestList = null;
    try { // Helius ascending query (may need a paid plan)
      const r = await rpc("getTransactionsForAddress", [mint, { transactionDetails: "signatures", sortOrder: "asc", limit: 300 }]);
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
      if (reached && last.length) { oldestList = last.slice(-300).reverse(); D.path = "paged"; }
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
      D.deployerAmt = bal[dep] || 0;
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
      const first = {}; const moves = []; const why = {}; // why[wallet] = { r: reason, tx: signature } — shown as proof links
      const mark = (o, r, tx) => { if (!why[o] && tx) why[o] = { r, tx }; };
      let s0 = null;
      for (const t of list) for (const tr of t.tokenTransfers || []) {
        if (tr.mint !== mint || !tr.toUserAccount || !(tr.tokenAmount > 0)) continue;
        if (tr.fromUserAccount && tr.fromUserAccount !== tr.toUserAccount) moves.push([tr.fromUserAccount, tr.toUserAccount, t.signature]);
        if (tr.toUserAccount === D.deployer || pools.has(tr.toUserAccount)) continue;
        if (s0 === null) s0 = t.slot;
        if (t.slot - s0 <= 30 && !(tr.toUserAccount in first)) { first[tr.toUserAccount] = t.slot - s0; mark(tr.toUserAccount, t.slot - s0 <= 1 ? "bought in the launch block" : `bought ${t.slot - s0} blocks after launch`, t.signature); }
      }
      // any address that hands the token to many different wallets is a pool / bonding-curve vault, not a buyer
      const outTo = {}; moves.forEach(([f, t]) => { (outTo[f] = outTo[f] || new Set()).add(t); });
      Object.keys(outTo).forEach((f) => { if (outTo[f].size >= 8 && f !== D.deployer) { pools.add(f); delete first[f]; } });
      const all = Object.keys(first).filter((o) => !pools.has(o) && onCurve(o));
      // re-label holders found to be pools/vaults and recompute the wallet stats
      if (holders.some((h) => h.kind === "wallet" && pools.has(h.owner))) {
        holders.forEach((h) => { if (pools.has(h.owner)) h.kind = "program"; });
        const rw = holders.filter((h) => h.kind === "wallet");
        D.top10Wallets = rw.slice(0, 10).reduce((a, h) => a + h.pct, 0); D.topWallet = rw[0] || null;
        D.poolPct = holders.filter((h) => h.kind === "program").reduce((a, h) => a + h.pct, 0);
      }
      const same = all.filter((o) => first[o] <= 1);
      const bundled = same.length >= 2 ? same : [];
      const snipe = all.filter((o) => !bundled.includes(o) && first[o] <= 10);
      // follow the tokens: wallets that received them from an early buyer belong to the same group
      const spread = (seeds) => {
        const set = new Set(seeds);
        for (let pass = 0; pass < 3; pass++) for (const [f, t, sg] of moves) if (set.has(f) && !set.has(t) && !pools.has(t) && t !== D.deployer) { set.add(t); mark(t, "received tokens from " + short(f), sg); }
        return [...set];
      };
      const bundledAll = spread(bundled);
      const snipeAll = spread(snipe).filter((o) => !bundledAll.includes(o));
      // holder-side check: when did each current holder first receive the token? Same-block groups = bundles
      const slotOf = {}, sigFirst = {};
      try {
        const hs = Object.keys(bal).filter((o) => bal[o] > 0 && !pools.has(o) && o !== D.deployer && taddr[o])
          .sort((a, b) => bal[b] - bal[a]).slice(0, 80);
        for (let i = 0; i < hs.length && left() > 1500; i += 8) await Promise.all(hs.slice(i, i + 8).map(async (o) => {
          try {
            const r = await rpc("getTransactionsForAddress", [taddr[o], { transactionDetails: "signatures", sortOrder: "asc", limit: 1 }]);
            const a = (r && (r.data || r)) || [];
            if (Array.isArray(a) && a[0] && a[0].slot) { slotOf[o] = a[0].slot; sigFirst[o] = a[0].signature; } else bad("slot-empty", "no tx");
          } catch (e) { bad("slot", e); }
        }));
      } catch (e) { bad("slotstep", e); }
      const bySlot = {}; Object.keys(slotOf).forEach((o) => (bySlot[slotOf[o]] = bySlot[slotOf[o]] || []).push(o));
      const cs = oldest.slot || 0;
      // 3+ current holders whose first buy landed in the same block — only a bundle if it happened right at launch (later same-block buys are normal trading)
      const grouped = Object.entries(bySlot).filter(([sl, g]) => g.length >= 3 && cs && Number(sl) - cs <= 5).map(([, g]) => g).flat();
      grouped.forEach((o) => mark(o, "same block as other holders at launch", sigFirst[o]));
      const earlyHold = Object.keys(slotOf).filter((o) => cs && slotOf[o] - cs <= 3 && !grouped.includes(o));
      bundledAll.push(...grouped.filter((o) => !bundledAll.includes(o)));
      earlyHold.forEach((o) => { if (!bundledAll.includes(o) && !snipeAll.includes(o)) snipeAll.push(o); });
      // same-funder check: wallets first funded by the same source as the core bundle
      const funder = {}, fsig = {}, insiders = [];
      try {
        const cand = [...new Set([...bundledAll, ...Object.keys(bal).filter((o) => bal[o] > 0 && !pools.has(o) && o !== D.deployer).sort((a, b) => bal[b] - bal[a])])]
          .filter((o) => !pools.has(o) && o !== D.deployer).slice(0, 45);
        const sigsOf = {};
        for (let i = 0; i < cand.length && left() > 3000; i += 8) await Promise.all(cand.slice(i, i + 8).map(async (o) => {
          try { const r = await rpc("getTransactionsForAddress", [o, { transactionDetails: "signatures", sortOrder: "asc", limit: 3 }]);
            const a = (r && (r.data || r)) || []; if (Array.isArray(a) && a.length) sigsOf[o] = a.map((x) => x.signature); else bad("funder-empty", "no tx"); } catch (e) { bad("funder-sig", e); }
        }));
        const flat = []; Object.keys(sigsOf).forEach((o) => sigsOf[o].forEach((s) => flat.push([o, s])));
        for (let i = 0; i < flat.length && left() > 1500; i += 100) {
          const part = flat.slice(i, i + 100);
          const r = await post("https://api.helius.xyz/v0/transactions?api-key=" + key, { transactions: part.map((x) => x[1]) }).catch(() => []);
          const bySig = {}; (Array.isArray(r) ? r : []).forEach((t) => { bySig[t.signature] = t; });
          part.forEach(([o, s]) => { if (funder[o]) return; const t = bySig[s]; if (!t) return;
            const nt = (t.nativeTransfers || []).find((x) => x.toUserAccount === o && x.fromUserAccount !== o && x.amount > 0); if (nt) { funder[o] = nt.fromUserAccount; fsig[o] = s; } });
        }
        const cnt = {}; bundledAll.filter((o) => funder[o]).forEach((o) => { cnt[funder[o]] = (cnt[funder[o]] || 0) + 1; });
        const all3 = {}; Object.keys(funder).forEach((o) => { if (bal[o] > 0) all3[funder[o]] = (all3[funder[o]] || 0) + 1; });
        // a source that funded 10+ of the checked holders is an exchange hot wallet, not an insider
        const shared = new Set([...Object.keys(cnt).filter((f) => cnt[f] >= 2), ...Object.keys(all3).filter((f) => all3[f] >= 2)].filter((f) => (all3[f] || 0) < 10 && f !== mint && !pools.has(f)));
        D.sharedFunders = shared.size;
        // same funder as another holder = insider (like Phanes "Insiders"); reported separately, not counted as bundlers
        Object.keys(funder).forEach((o) => { if (shared.has(funder[o]) && !bundledAll.includes(o) && bal[o] > 0) { insiders.push(o); mark(o, "funded by " + short(funder[o]) + " (same as other holders)", fsig[o]); } });
      } catch (e) { bad("funderstep", e); }
      // did the wallet get its tokens through a Jito bundle (tip paid to a Jito tip account)?
      const jito = {};
      try {
        const js = Object.keys(sigFirst).filter((o) => sigFirst[o]).slice(0, 100);
        if (js.length && left() > 1500) {
          const r = await post("https://api.helius.xyz/v0/transactions?api-key=" + key, { transactions: js.map((o) => sigFirst[o]) });
          const bySig = {}; (Array.isArray(r) ? r : []).forEach((t) => { bySig[t.signature] = t; });
          js.forEach((o) => { const t = bySig[sigFirst[o]]; if (t) jito[o] = (t.nativeTransfers || []).some((x) => JITO.has(x.toUserAccount)); });
        }
      } catch (e) { bad("jito", e); }
      const hist = {}; all.forEach((o) => { hist[first[o]] = (hist[first[o]] || 0) + 1; });
      D.debug = { path: D.path, txsFetched: list.length, creationSlot: oldest.slot || null, firstBuySlotOffset: s0 === null ? null : s0 - (oldest.slot || s0),
        buyersBySlotOffset: hist, txsParsed: list.length, holderSlots: Object.keys(slotOf).length, ms: Date.now() - t0, jitoWallets: Object.values(jito).filter(Boolean).length, jitoChecked: Object.keys(jito).length, errs: D.errs, retries: D.retries || 0, funderKnown: Object.keys(funder).length, funderGroups: Object.entries(Object.values(funder).reduce((m, f) => (m[f] = (m[f] || 0) + 1, m), {})).filter((x) => x[1] >= 2).map((x) => short(x[0]) + " x" + x[1]), sharedFunders: D.sharedFunders || 0, sameSlotGroups: Object.values(bySlot).map((g) => g.length).filter((n) => n >= 2).sort((a, b) => b - a), seeds: { bundlers: bundled.length, snipers: snipe.length }, bundlerWallets: bundledAll.length, sniperWallets: snipeAll.length, holdersComplete: complete,
        holderList: Object.keys(bal).filter((o) => !pools.has(o) && bal[o] > 0).sort((a, b) => bal[b] - bal[a]).slice(0, 60).map((o) => o.slice(0, 3) + "..." + o.slice(-4) + " " + (bal[o] / supply * 100).toFixed(2) + "% slot+" + (slotOf[o] && cs ? slotOf[o] - cs : "?") + (jito[o] ? " J" : "") + (funder[o] ? " f:" + funder[o].slice(0, 4) : "") + (bundledAll.includes(o) ? " B" : snipeAll.includes(o) ? " S" : "")) };
      const held = async (o) => {
        if (complete || bal[o]) return bal[o] || 0;
        try { const r = await rpc("getTokenAccountsByOwner", [o, { mint }, { encoding: "jsonParsed" }]);
          return (r.value || []).reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.amount || 0), 0); } catch (e) { return 0; }
      };
      const grp = async (ws) => {
        const amts = []; for (const o of ws.slice(0, complete ? 200 : 8)) amts.push(await held(o));
        const proof = ws.filter((o) => why[o]).sort((a, b) => (bal[b] || 0) - (bal[a] || 0)).slice(0, 5).map((o) => ({ w: o, why: why[o].r, tx: why[o].tx, pct: supply && bal[o] ? +(bal[o] / supply * 100).toFixed(2) : 0 }));
        return { wallets: ws.length, heldPct: supply ? amts.reduce((a, b) => a + b, 0) / supply * 100 : 0, stillHolding: amts.filter((x) => x > 0).length, proof };
      };
      D.bundlers = bundledAll.length ? await grp(bundledAll) : null;
      D.snipers = snipeAll.length ? await grp(snipeAll) : null;
      D.insiders = insiders.length ? await grp(insiders) : null;
    } catch (e) { D.notes.push("Early buyer check unavailable"); D.earlyFailed = true; }
  } catch (e) {
    D.notes.push("Deep scan incomplete");
  }
  return D;
}

function deepChecks(D, add) {
  if (!D) return;
  const f = (n) => (typeof n === "number" ? n.toFixed(1) + "%" : "n/a");
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
    add((g.heldPct || 0) >= 10 ? "high" : (g.heldPct || 0) >= 5 || (g.boughtPct || 0) >= 5 ? "medium" : (g.boughtPct || 0) >= 3 ? "low" : "info", `${g.stillHolding} of ${g.wallets} ${label}`,
      `Together they hold ${f(g.heldPct)} of supply`);
  };
  grp(D.bundlers, "bundle wallets still hold tokens (bought in the launch block or received from those buyers)");
  if (D.insiders) add((D.insiders.heldPct || 0) >= 10 ? "medium" : "info", `${D.insiders.stillHolding} insider wallets (same funding source) hold ${f(D.insiders.heldPct)}`, "Different wallets funded from the same address. Could be one person, or friends of the dev.");
  grp(D.snipers, "sniper wallets still hold tokens (bought in the first seconds or received from those buyers)");
  (D.notes || []).forEach((n) => add("info", n));
}
// Current raw token balance of a wallet for a mint (one RPC call). Used by the alert checker.
async function deployerBalance(mint, owner) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  const c = new AbortController(), t = setTimeout(() => c.abort(), 5000);
  try {
    const r = await fetch("https://mainnet.helius-rpc.com/?api-key=" + key, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint }, { encoding: "jsonParsed" }] }) });
    const j = await r.json();
    if (!j.result) return null;
    return (j.result.value || []).reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.amount || 0), 0);
  } catch (e) { return null; } finally { clearTimeout(t); }
}
module.exports = { deepSol, deepChecks, deployerBalance };
