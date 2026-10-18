// Deep Solana scan via Helius. Needs env HELIUS_API_KEY. Every step is optional: failures drop that check, never the scan.
const SYS = "11111111111111111111111111111111";
const short = (a) => a.slice(0, 4) + "..." + a.slice(-4);

async function deepSol(mint, budgetMs = 6500) {
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
  const D = { notes: [] };
  try {
    // 1. Mint basics
    const mi = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const info = mi && mi.value && mi.value.data && mi.value.data.parsed && mi.value.data.parsed.info;
    if (!info) return null;
    const supply = Number(info.supply) || 0;
    D.mintAuthority = info.mintAuthority || null;
    D.freezeAuthority = info.freezeAuthority || null;

    // 2. Holders by owner wallet; separate pools/programs from real wallets
    const lg = await rpc("getTokenLargestAccounts", [mint]);
    const accs = ((lg && lg.value) || []).slice(0, 20);
    let holders = [];
    if (accs.length && supply) {
      const ta = await rpc("getMultipleAccounts", [accs.map((a) => a.address), { encoding: "jsonParsed" }]);
      const owners = (ta.value || []).map((v) => v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.owner);
      const uniq = [...new Set(owners.filter(Boolean))];
      const oa = await rpc("getMultipleAccounts", [uniq, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      const kind = {};
      uniq.forEach((o, i) => { const v = oa.value && oa.value[i]; kind[o] = !v || v.owner !== SYS ? "program" : "wallet"; });
      const by = {};
      accs.forEach((a, i) => { const o = owners[i]; if (o) by[o] = (by[o] || 0) + Number(a.amount); });
      holders = Object.entries(by).map(([owner, amt]) => ({ owner, pct: amt / supply * 100, kind: kind[owner] || "wallet" })).sort((a, b) => b.pct - a.pct);
    }
    D.holders = holders;
    const real = holders.filter((h) => h.kind === "wallet");
    D.top10Wallets = real.slice(0, 10).reduce((a, h) => a + h.pct, 0);
    D.topWallet = real[0] || null;
    D.poolPct = holders.filter((h) => h.kind === "program").reduce((a, h) => a + h.pct, 0);

    // 3. Walk back to the creation of the mint (max 3 pages)
    let before, last = [], reached = false;
    for (let p = 0; p < 3; p++) {
      const s = await rpc("getSignaturesForAddress", [mint, before ? { limit: 1000, before } : { limit: 1000 }]);
      if (!s || !s.length) { reached = p > 0; break; }
      last = s; before = s[s.length - 1].signature;
      if (s.length < 1000) { reached = true; break; }
    }
    if (!reached || !last.length) { D.notes.push("Token is too old or too active to trace the launch"); return D; }
    const oldest = last[last.length - 1];

    // 4. Deployer = fee payer of the first transaction
    const tx = await rpc("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
    const dep = keys && keys[0] && (keys[0].pubkey || keys[0]);
    if (typeof dep === "string") {
      D.deployer = dep;
      const dh = holders.find((h) => h.owner === dep);
      D.deployerPct = dh ? dh.pct : 0;
      D.deployerInTop = !!dh;
      D.launchTs = oldest.blockTime || null;
      try { // deployer wallet age
        const ds = await rpc("getSignaturesForAddress", [dep, { limit: 1000 }]);
        if (ds && ds.length) {
          D.deployerTxCount = ds.length >= 1000 ? "1000+" : ds.length;
          const o = ds[ds.length - 1];
          if (ds.length < 1000 && o.blockTime && D.launchTs) D.deployerAgeDays = Math.max(0, (D.launchTs - o.blockTime) / 86400);
        }
      } catch (e) {}
    }

    // 5. Early buyers: who received the token in the first slots
    try {
      const sigs = last.slice(-100).map((x) => x.signature);
      const et = await post("https://api.helius.xyz/v0/transactions?api-key=" + key, { transactions: sigs });
      const list = (Array.isArray(et) ? et : []).filter((t) => t && t.slot).sort((a, b) => a.slot - b.slot);
      const pools = new Set(holders.filter((h) => h.kind === "program").map((h) => h.owner));
      const first = {};
      let s0 = null;
      for (const t of list) for (const tr of t.tokenTransfers || []) {
        if (tr.mint !== mint || !tr.toUserAccount || tr.toUserAccount === D.deployer || pools.has(tr.toUserAccount)) continue;
        if (!(tr.tokenAmount > 0)) continue;
        if (s0 === null) s0 = t.slot;
        if (t.slot - s0 <= 4 && !(tr.toUserAccount in first)) first[tr.toUserAccount] = t.slot - s0;
      }
      const all = Object.keys(first);
      const same = all.filter((o) => first[o] === 0);
      const bundled = same.length >= 2 ? same : [];
      const snipe = all.filter((o) => !bundled.includes(o));
      const grp = async (ws) => {
        ws = ws.slice(0, 15);
        const held = await Promise.all(ws.map((o) => rpc("getTokenAccountsByOwner", [o, { mint }, { encoding: "jsonParsed" }])
          .then((r) => (r.value || []).reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.amount || 0), 0)).catch(() => null)));
        const ok = held.filter((x) => x !== null);
        return { wallets: ws.length, heldPct: supply ? ok.reduce((a, b) => a + b, 0) / supply * 100 : 0, stillHolding: held.filter((x) => x && x > 0).length };
      };
      const [bu, sn] = await Promise.all([grp(bundled), grp(snipe)]);
      D.bundlers = bundled.length ? bu : null;
      D.snipers = snipe.length ? sn : null;
      D.earlyTotal = all.length;
    } catch (e) { D.notes.push("Early buyer check unavailable"); }
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
  const grp = (g, label, sev) => {
    if (!g) return;
    add(g.heldPct >= 10 ? "high" : g.heldPct >= 5 ? "medium" : "info", `${g.wallets} ${label}`,
      `They hold ${f(g.heldPct)} of supply (${g.stillHolding} of ${g.wallets} still holding)`);
  };
  grp(D.bundlers, "bundled wallets bought in the launch block");
  grp(D.snipers, "sniper wallets bought in the first seconds");
  (D.notes || []).forEach((n) => add("info", n));
}
module.exports = { deepSol, deepChecks };
