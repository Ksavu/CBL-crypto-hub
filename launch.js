/* XRPLabs (by CBL) — fair-launch XRPL tokens with no custody.
 *
 * The browser creates two fresh XRPL accounts and keeps their keys locally:
 *   I = issuer        (mints the supply, then is blackholed: supply fixed forever)
 *   L = launch wallet (receives the pool tokens, creates the AMM pool, pays the CBL fee,
 *                      then is blackholed: LP tokens locked forever, liquidity can't be pulled)
 * The creator signs ONE payment that funds L (plus one trust line if they keep a dev allocation).
 * Everything else is signed locally with the fresh keys. Our server never holds any key or funds.
 * Progress is saved in this browser so an interrupted launch can be resumed or refunded.
 */
(function () {
  "use strict";
  var BH = "rrrrrrrrrrrrrrrrrrrrBZbvji";
  var lsfDefaultRipple = 0x00800000, lsfNoFreeze = 0x00200000, lsfDisableMaster = 0x00100000;
  var asfDisableMaster = 4, asfNoFreeze = 6, asfDefaultRipple = 8;
  var KEY = "cbl_launch_pending", MAX_SUPPLY = 1e15, BUF = 0.05;
  var $ = function (i) { return document.getElementById(i) };
  var X = function () { return window.CBLXRPL }, C = function () { return X().core };
  var busy = false;

  /* ---------- small helpers ---------- */
  /* Runs on xrplabs.fun and on cryptobarlounge.space/launch. Swap and scanner live on the CBL site. */
  var MAIN = /(^|\.)cryptobarlounge\.space$/.test(location.hostname) || /localhost|127\.0\.0\.1/.test(location.hostname) ? "" : "https://cryptobarlounge.space";
  var BASE = /^\/launch/.test(location.pathname) ? "/launch" : "/";
  function trade(id) { if (window.cblSwapXrpl) window.cblSwapXrpl(id); else location.href = MAIN + "/?swap=" + id + "&chain=xrpl#swap" }
  function hex(s) { return Array.prototype.map.call(new TextEncoder().encode(s), function (b) { return b.toString(16).padStart(2, "0") }).join("").toUpperCase() }
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] }) }
  function num(v) { return Number(String(v).replace(/[,\s_]/g, "")) }
  function fmt(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumSignificantDigits: 5, maximumFractionDigits: 20 }) }
  function save(st) { try { localStorage.setItem(KEY, JSON.stringify(st)) } catch (e) {} }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "null") } catch (e) { return null } }
  function clear() { try { localStorage.removeItem(KEY) } catch (e) {} }
  function https(u) { u = String(u || "").trim(); if (!u) return ""; if (!/^https?:\/\//i.test(u)) u = "https://" + u; try { var x = new URL(u); return x.protocol === "https:" ? x.href : "" } catch (e) { return "" } }
  async function reserves() {
    var s = (await C().req({ command: "server_info" })).info.validated_ledger || {};
    return { base: s.reserve_base_xrp || 1, inc: s.reserve_inc_xrp || 0.2 };
  }
  async function acct(a) {
    try { return (await C().req({ command: "account_info", account: a, ledger_index: "validated" })).account_data }
    catch (e) { if (e && e.data && e.data.error === "actNotFound") return null; throw e }
  }
  async function line(holder, cur, issuer) {
    try {
      var r = await C().req({ command: "account_lines", account: holder, peer: issuer, ledger_index: "validated" });
      return (r.lines || []).filter(function (l) { return l.currency === cur })[0] || null;
    } catch (e) { if (e && e.data && e.data.error === "actNotFound") return null; throw e }
  }
  async function amm(cur, issuer) {
    try { return (await C().req({ command: "amm_info", asset: { currency: "XRP" }, asset2: { currency: cur, issuer: issuer }, ledger_index: "validated" })).amm }
    catch (e) { if (e && e.data && (e.data.error === "actNotFound" || e.data.error === "objectNotFound")) return null; throw e }
  }
  async function wait(fn, tries) { for (var i = 0; i < (tries || 8); i++) { if (await fn()) return true; await new Promise(function (r) { setTimeout(r, 1500) }) } return false }

  async function creatorWallet(cr) {
    if (X().account() === cr) return;
    var a = await X().connect(true);
    if (a !== cr) throw new Error("Connect the wallet that started this launch (" + cr.slice(0, 6) + "...).");
  }

  /** Sign locally with a fresh key and submit; throws with a readable reason on failure. */
  async function local(seed, tx) {
    var c = await C().getClient(), w = window.xrpl.Wallet.fromSeed(seed);
    tx.Account = w.address;
    var r = await c.submitAndWait(tx, { wallet: w, autofill: true });
    var code = r && r.result && r.result.meta && r.result.meta.TransactionResult;
    if (code !== "tesSUCCESS") throw new Error(C().why(code || "unknown"));
    return r.result.hash;
  }

  /* ---------- plan: amounts and costs ---------- */
  function plan(f, rs, feeXrp) {
    var supply = Math.floor(f.supply), dev = Math.floor(supply * f.devPct / 100), pool = supply - dev;
    var issuerFund = rs.base + BUF;
    var lpKeep = rs.base + 2 * rs.inc;            // L account reserve + token line + LP line (locked forever)
    var lpFund = f.poolXrp + lpKeep + rs.inc + BUF + feeXrp + issuerFund; // + AMMCreate burns 1 owner reserve
    return {
      supply: supply, dev: dev, pool: pool, issuerFund: issuerFund, lpFund: lpFund,
      network: issuerFund + lpKeep + rs.inc + BUF, // locked or burned, never comes back
      creatorTrust: dev > 0 ? rs.inc : 0,
      price: f.poolXrp / pool, mcap: (f.poolXrp / pool) * supply
    };
  }

  function readForm() {
    var name = $("lnName").value.trim(), ticker = $("lnTicker").value.trim(), supply = num($("lnSupply").value),
        devPct = num($("lnDev").value || 0), poolXrp = num($("lnPool").value), sel = $("lnFee").querySelector("[aria-pressed=true]"), tf = sel ? Number(sel.dataset.v) : 500;
    if (!name || name.length > 40) throw new Error("Enter a token name (up to 40 characters).");
    if (!/^[A-Za-z0-9]{1,20}$/.test(ticker) || ticker.toUpperCase() === "XRP") throw new Error("Ticker: 1 to 20 letters or numbers, and not XRP.");
    if (!(supply >= 1000 && supply <= MAX_SUPPLY && Number.isInteger(supply))) throw new Error("Supply must be a whole number between 1,000 and 1,000,000,000,000,000.");
    if (!(devPct >= 0 && devPct <= 10)) throw new Error("Dev allocation can be 0% to 10%.");
    if (!(poolXrp >= 10 && poolXrp <= 10000000)) throw new Error("Starting liquidity must be at least 10 XRP.");
    return {
      name: name, ticker: ticker.toUpperCase(), supply: supply, devPct: devPct, poolXrp: poolXrp, tradingFee: tf,
      desc: $("lnDesc").value.trim().slice(0, 280), web: https($("lnWeb").value), x: https($("lnX").value), tg: https($("lnTg").value),
      logo: $("lnLogo").dataset.url || ""
    };
  }

  /* ---------- the launch steps (each one checks the ledger first, so resuming is safe) ---------- */
  function steps(st) {
    var I = st.issuer, L = st.lp, cur = st.currency, p = st.plan, f = st.form, cr = st.creator;
    var S = [];
    if (p.dev > 0) S.push({
      t: "Approve " + f.ticker + " in your wallet (dev allocation)",
      done: async function () { var l = await line(cr, cur, I); return !!(l && Number(l.limit) > 0) },
      run: async function (say) {
        await creatorWallet(cr);
        var r = await C().send({ TransactionType: "TrustSet", Account: cr, LimitAmount: { currency: cur, issuer: I, value: String(p.supply) }, Flags: 0x00020000 }, say);
        if (r.code !== "tesSUCCESS") throw new Error(C().why(r.code));
      }
    });
    S.push({
      t: "Fund the launch (" + fmt(p.lpFund) + " XRP, one signature)",
      done: async function () { return !!(await acct(L)) },
      run: async function (say) {
        await creatorWallet(cr);
        var r = await C().send({ TransactionType: "Payment", Account: cr, Destination: L, Amount: C().drops(p.lpFund), Memos: [{ Memo: { MemoData: hex("XRPLabs " + f.ticker) } }] }, say);
        if (r.code !== "tesSUCCESS") throw new Error(C().why(r.code));
        await wait(async function () { return !!(await acct(L)) });
      }
    });
    S.push({ t: "Create issuer account", done: async function () { return !!(await acct(I)) },
      run: async function () { await local(st.lpSeed, { TransactionType: "Payment", Destination: I, Amount: C().drops(p.issuerFund) }) } });
    S.push({ t: "Enable trading on the token", done: async function () { var a = await acct(I); return !!(a && (a.Flags & lsfDefaultRipple)) },
      run: async function () {
        var tx = { TransactionType: "AccountSet", SetFlag: asfDefaultRipple };
        if (f.web) { try { tx.Domain = hex(new URL(f.web).hostname) } catch (e) {} }
        await local(st.issuerSeed, tx);
      } });
    S.push({ t: "Give up freeze powers", done: async function () { var a = await acct(I); return !!(a && (a.Flags & lsfNoFreeze)) },
      run: async function () { await local(st.issuerSeed, { TransactionType: "AccountSet", SetFlag: asfNoFreeze }) } });
    S.push({ t: "Prepare the pool wallet", done: async function () { return !!(await line(L, cur, I)) },
      run: async function () { await local(st.lpSeed, { TransactionType: "TrustSet", LimitAmount: { currency: cur, issuer: I, value: String(p.supply) } }) } });
    if (p.dev > 0) S.push({ t: "Send dev allocation (" + fmt(p.dev) + " " + f.ticker + ")",
      done: async function () { var l = await line(cr, cur, I); return !!(l && Number(l.balance) >= p.dev * 0.999) },
      run: async function () { await local(st.issuerSeed, { TransactionType: "Payment", Destination: cr, Amount: { currency: cur, issuer: I, value: String(p.dev) } }) } });
    S.push({ t: "Mint " + fmt(p.pool) + " " + f.ticker + " for the pool",
      done: async function () { if (await amm(cur, I)) return true; var l = await line(L, cur, I); return !!(l && Number(l.balance) >= p.pool * 0.999) },
      run: async function () { await local(st.issuerSeed, { TransactionType: "Payment", Destination: L, Amount: { currency: cur, issuer: I, value: String(p.pool) } }) } });
    S.push({ t: "Create the XRP/" + f.ticker + " pool", done: async function () { return !!(await amm(cur, I)) },
      run: async function () {
        var c = await C().getClient(), w = window.xrpl.Wallet.fromSeed(st.lpSeed), rs = await reserves();
        var tx = await c.autofill({ TransactionType: "AMMCreate", Account: w.address, Amount: C().drops(f.poolXrp), Amount2: { currency: cur, issuer: I, value: String(p.pool) }, TradingFee: f.tradingFee });
        tx.Fee = C().drops(rs.inc); // AMMCreate must burn one owner reserve
        var r = await c.submitAndWait(w.sign(tx).tx_blob);
        var code = r.result.meta && r.result.meta.TransactionResult;
        if (code !== "tesSUCCESS") throw new Error(C().why(code || "unknown"));
      } });
    if (st.fee > 0 && st.feeAccount) S.push({ t: "Pay CBL launch fee (" + st.fee + " XRP)",
      done: async function () { return !!st.feeTx },
      run: async function () {
        st.feeTx = await local(st.lpSeed, { TransactionType: "Payment", Destination: st.feeAccount, Amount: C().drops(st.fee), Memos: [{ Memo: { MemoData: hex("CBL-LAUNCH:" + I) } }] });
        save(st);
      } });
    [["lpSeed", L, "Lock liquidity forever"], ["issuerSeed", I, "Lock supply forever"]].forEach(function (b) {
      S.push({ t: b[2], done: async function () { var a = await acct(b[1]); return !!(a && (a.Flags & lsfDisableMaster)) },
        run: async function () {
          var a = await acct(b[1]);
          if (a.RegularKey !== BH) await local(st[b[0]], { TransactionType: "SetRegularKey", RegularKey: BH });
          await local(st[b[0]], { TransactionType: "AccountSet", SetFlag: asfDisableMaster });
        } });
    });
    S.push({ t: "List on CBL", done: async function () { return !!st.listed },
      run: async function () {
        var r = await fetch("/api/launch", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ issuer: I, lp: L, currency: cur, creator: cr, feeTx: st.feeTx || null, meta: { name: f.name, ticker: f.ticker, desc: f.desc, web: f.web, x: f.x, tg: f.tg, logo: f.logo, devPct: f.devPct } }) });
        var d = await r.json().catch(function () { return {} });
        if (!r.ok || !d.ok) { if (r.status === 503) { st.listed = "skipped"; save(st); return } throw new Error(d.error || "Listing failed") }
        st.listed = true; save(st);
      } });
    return S;
  }

  function drawSteps(S, at, state) {
    $("lnSteps").innerHTML = S.map(function (s, i) {
      var m = i < at ? "✓" : i === at ? (state === "err" ? "!" : "…") : "", cls = i < at ? "ok" : i === at ? state : "";
      return '<li class="' + cls + '"><span>' + m + '</span>' + esc(s.t) + '</li>';
    }).join("");
  }

  async function run(st) {
    if (busy) return; busy = true;
    var say = function (m) { $("lnMsg").textContent = m }, S = steps(st), i = 0;
    $("lnGo").disabled = true; $("lnProg").hidden = false; $("lnForm").hidden = true;
    try {
      for (i = 0; i < S.length; i++) {
        drawSteps(S, i, "run");
        if (await S[i].done()) continue;
        say(S[i].t + "...");
        await S[i].run(say);
      }
      drawSteps(S, S.length, "ok");
      var id = st.currency + "." + st.issuer;
      clear();
      $("lnMsg").innerHTML = "🎉 <b>" + esc(st.form.ticker) + "</b> is live. Supply and liquidity are locked forever." +
        (st.listed === "skipped" ? " (CBL listing is not set up yet.)" : "");
      $("lnDone").hidden = false;
      $("lnTrade").onclick = function () { trade(id) };
      $("lnShare").onclick = function () { var u = location.origin + BASE + "?t=" + encodeURIComponent(id); try { navigator.clipboard.writeText(u); $("lnShare").textContent = "Copied" } catch (e) { prompt("Share link", u) } };
      list();
    } catch (e) {
      var m = (e && e.message) || String(e);
      // Nothing happened on-ledger yet (e.g. first signature rejected): just go back to the form.
      if (!(await acct(st.lp).catch(function () { return true }))) {
        clear(); $("lnProg").hidden = true; $("lnForm").hidden = false; $("lnGo").disabled = false; $("lnGo").textContent = "Launch token"; $("lnGo").onclick = start;
        say(/Rejected|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent." : m); pendingBanner(); busy = false; return;
      }
      drawSteps(S, i, "err");
      say((/Rejected|cancel/i.test(m) ? "Cancelled in your wallet." : m) + " Your progress is saved — press Resume to continue.");
      $("lnGo").disabled = false; $("lnGo").textContent = "Resume launch";
      $("lnGo").onclick = function () { run(st) };
      pendingBanner();
    } finally { busy = false }
  }

  async function start() {
    var say = function (m) { $("lnMsg").textContent = m };
    try {
      if (!X() || !X().core) throw new Error("XRPL module is still loading. Try again in a second.");
      var f = readForm(), cfg = await C().cfg(), rs = await reserves();
      var fee = Number(cfg.launchFee) || 0, feeAccount = cfg.launchFeeAccount || "";
      var p = plan(f, rs, feeAccount ? fee : 0);
      say("Connecting XRPL wallet...");
      var cr = await X().connect();
      var need = p.lpFund + p.creatorTrust + 0.02;
      if ((await C().spendableXrp(cr)) < need) throw new Error("You need about " + fmt(need) + " XRP available (not counting your reserve).");
      var xl = window.xrpl, I = xl.Wallet.generate(), L = xl.Wallet.generate();
      var st = { v: 1, at: Date.now(), creator: cr, issuer: I.address, issuerSeed: I.seed, lp: L.address, lpSeed: L.seed,
        currency: X().parseId(f.ticker + "." + I.address).currency, form: f, plan: p, fee: feeAccount ? fee : 0, feeAccount: feeAccount };
      save(st);
      await run(st);
    } catch (e) { say((e && e.message) || String(e)) }
  }

  /** Refund an unfinished launch (only before the pool exists). */
  async function refund(st) {
    var say = function (m) { $("lnMsg").textContent = m };
    try {
      if (await amm(st.currency, st.issuer)) throw new Error("The pool already exists. Press Resume to finish locking it.");
      var rs = await reserves(), back = 0;
      for (var k of [["issuerSeed", st.issuer], ["lpSeed", st.lp]]) {
        var a = await acct(k[1]); if (!a || (a.Flags & lsfDisableMaster)) continue;
        var free = Number(a.Balance) / 1e6 - rs.base - rs.inc * a.OwnerCount - 0.001;
        if (free > 0.001) { say("Returning " + fmt(free) + " XRP..."); await local(st[k[0]], { TransactionType: "Payment", Destination: st.creator, Amount: C().drops(free) }); back += free }
      }
      clear(); $("lnPend").hidden = true; $("lnForm").hidden = false; $("lnProg").hidden = true;
      $("lnGo").disabled = false; $("lnGo").textContent = "Launch token"; $("lnGo").onclick = start;
      say("Refunded " + fmt(back) + " XRP to your wallet (account reserves of the unfinished launch stay locked).");
    } catch (e) { say((e && e.message) || String(e)) }
  }

  function pendingBanner() {
    var st = load(), b = $("lnPend");
    if (!st) { b.hidden = true; return }
    b.hidden = false;
    b.innerHTML = '<span>Unfinished launch: <b>' + esc(st.form.ticker) + '</b></span><button class="chip" type="button" id="lnRes">Resume</button><button class="chip" type="button" id="lnRef">Cancel &amp; refund</button>';
    $("lnRes").onclick = function () { run(st) };
    $("lnRef").onclick = function () { if (confirm("Return the unused XRP from this launch to " + st.creator + "?")) refund(st) };
  }

  /* ---------- live summary ---------- */
  /** How much of the supply a single 20 XRP buy would take at launch (constant-product AMM, fee on input). */
  function snipe(f, p) {
    var b = 20 * (1 - f.tradingFee / 100000), share = (p.pool * b / (f.poolXrp + b)) / p.supply * 100;
    var cls = share >= 15 ? "risk-h" : share >= 5 ? "risk-m" : "risk-l", word = share >= 15 ? "high snipe risk" : share >= 5 ? "medium" : "low snipe risk";
    return "<div><span>A 20 XRP buy at launch gets</span><b class='" + cls + "'>" + (share >= 10 ? share.toFixed(0) : share.toFixed(1)) + "% of supply · " + word + "</b></div>";
  }
  function syncTier() {
    var v = num($("lnPool").value), box = $("lnTier"); if (!box) return;
    box.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", v >= Number(b.dataset.min) && v <= Number(b.dataset.max)) });
  }

  async function summary() {
    var box = $("lnSum");
    try {
      var f = readForm(), cfg = X() && X().core ? await C().cfg() : {}, fee = cfg.launchFeeAccount ? Number(cfg.launchFee) || 0 : 0;
      var p = plan(f, { base: 1, inc: 0.2 }, fee);
      box.innerHTML = "<div><span>Starting price</span><b>" + fmt(p.price) + " XRP</b></div>" +
        "<div><span>Starting market cap</span><b>" + fmt(p.mcap) + " XRP</b></div>" +
        "<div><span>Pool</span><b>" + fmt(f.poolXrp) + " XRP + " + fmt(p.pool) + " " + esc(f.ticker) + "</b></div>" +
        snipe(f, p) +
        (p.dev ? "<div><span>Dev allocation (public)</span><b>" + fmt(p.dev) + " " + esc(f.ticker) + "</b></div>" : "") +
        "<div><span>CBL launch fee</span><b>" + (fee ? fee + " XRP" : "Free") + "</b></div>" +
        "<div><span>Network costs (locked/burned)</span><b>~" + fmt(p.network) + " XRP</b></div>" +
        "<div class='tot'><span>You send</span><b>~" + fmt(p.lpFund + p.creatorTrust) + " XRP</b></div>";
      $("lnGo").disabled = busy;
    } catch (e) { box.innerHTML = '<div class="hint">' + esc(e.message) + '</div>' }
  }

  function logoInput() {
    $("lnLogoF").onchange = function () {
      var fl = this.files && this.files[0], el = $("lnLogo"); if (!fl) return;
      if (!/^image\//.test(fl.type)) return;
      var img = new Image(), rd = new FileReader();
      rd.onload = function () { img.src = rd.result };
      img.onload = function () {
        var c = document.createElement("canvas"), s = Math.min(img.width, img.height); c.width = c.height = 128;
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
        var u = c.toDataURL("image/webp", 0.85); if (!/^data:image\/webp/.test(u)) u = c.toDataURL("image/png");
        el.dataset.url = u; el.style.backgroundImage = "url(" + u + ")"; el.classList.add("has");
        var t = el.querySelector(".lt"); if (t) t.hidden = true; preview();
      };
      rd.readAsDataURL(fl);
    };
  }

  /* ---------- launches list, trending, token pages ---------- */
  var ALL = [], SORT = "trend", EXPL = "https://xrpscan.com/account/", TXL = "https://xrpscan.com/tx/";
  var CHART_LIB = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js";
  function age(t) { var m = Math.max(1, Math.round((Date.now() - new Date(t).getTime()) / 60000)); return m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d" }
  function idOf(t) { return t.currency + "." + t.issuer }
  function logoHtml(t, cls) { var l = /^data:image\/(png|webp|jpeg);base64,/.test(t.logo || "") ? t.logo : ""; return l ? '<img class="' + (cls || "lg") + '" alt="" src="' + l + '">' : '<span class="' + (cls === "lgs" ? "lgxs" : "lgx") + '">' + esc((t.ticker || "?")[0]) + '</span>' }
  function chg(v) { return v == null || !isFinite(v) ? '<span class="mut">—</span>' : '<span class="' + (v >= 0 ? "up" : "dn") + '">' + (v >= 0 ? "+" : "") + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1)) + '%</span>' }
  function xrp(v) { return v == null || !isFinite(v) ? "—" : fmt(v) + " XRP" }
  function st(t) { return t.stats || {} }

  function card(t) {
    var s = st(t), id = idOf(t);
    return '<article class="card" data-open="' + esc(id) + '" tabindex="0"><div class="ch">' + logoHtml(t) +
      '<div><div class="nm">' + esc(t.name) + '</div><div class="tk">' + esc(t.ticker) + ' · ' + age(t.created_at) + ' ago</div></div><div class="c24">' + chg(s.change24) + '</div></div>' +
      (t.description ? '<p class="desc">' + esc(t.description) + '</p>' : '') +
      '<div class="kv"><div><span>Market cap</span><b>' + xrp(s.mcap) + '</b></div><div><span>24h volume</span><b>' + xrp(s.vol24) + '</b></div></div>' +
      '<div class="pills"><span class="pill">🔒 Supply</span><span class="pill">🔒 Liquidity</span>' + (Number(t.dev_pct) ? '<span class="pill n">Dev ' + esc(t.dev_pct) + '%</span>' : '<span class="pill n">No dev tokens</span>') + '</div>' +
      '<div class="acts"><button class="btn p" type="button" data-buy="' + esc(id) + '">Buy</button><button class="btn s" type="button" data-open="' + esc(id) + '">Chart &amp; info</button></div></article>';
  }
  function sorted(mode) {
    var L = ALL.slice(), v = function (t, k) { var x = st(t)[k]; return x == null || !isFinite(x) ? -Infinity : x };
    if (mode === "trend") L.sort(function (a, b) { return (v(b, "vol24") - v(a, "vol24")) || ((st(b).buys24 || 0) - (st(a).buys24 || 0)) });
    else if (mode === "gain") L.sort(function (a, b) { return v(b, "change24") - v(a, "change24") });
    else if (mode === "mcap") L.sort(function (a, b) { return v(b, "mcap") - v(a, "mcap") });
    return L;
  }
  function bind(root) {
    root.querySelectorAll("[data-buy]").forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); trade(b.dataset.buy) } });
    root.querySelectorAll("[data-open]").forEach(function (el) {
      el.onclick = function (e) { if (e.target.closest("[data-buy],a")) return; e.stopPropagation(); openToken(el.dataset.open) };
      el.onkeydown = function (e) { if (e.key === "Enter" && el === e.target) openToken(el.dataset.open) };
    });
  }
  function renderTop() {
    var box = $("lnTop"); if (!box) return;
    var L = sorted("trend").filter(function (t) { return st(t).vol24 > 0 || st(t).buys24 > 0 }).slice(0, 10);
    if (!L.length) L = sorted("mcap").slice(0, 10);
    if (!L.length) { box.innerHTML = '<p class="empty">No launches yet. Be the first to launch.</p>'; return }
    box.innerHTML = '<table class="lb"><thead><tr><th>#</th><th>Token</th><th class="r">Price</th><th class="r">24h</th><th class="r hs">Volume 24h</th><th class="r hs">Market cap</th><th class="r hm">Liquidity</th><th></th></tr></thead><tbody>' +
      L.map(function (t, i) { var s = st(t);
        return '<tr data-open="' + esc(idOf(t)) + '" tabindex="0"><td class="rk">' + (i + 1) + '</td><td><div class="tn">' + logoHtml(t, "lgs") + '<b>' + esc(t.name) + '</b><span class="mut">' + esc(t.ticker) + '</span></div></td>' +
          '<td class="r">' + xrp(s.price) + '</td><td class="r">' + chg(s.change24) + '</td><td class="r hs">' + xrp(s.vol24) + '</td><td class="r hs">' + xrp(s.mcap) + '</td><td class="r hm">' + xrp(s.liq) + '</td>' +
          '<td class="r"><button class="btn p sm" type="button" data-buy="' + esc(idOf(t)) + '">Buy</button></td></tr>' }).join("") + '</tbody></table>';
    bind(box);
  }
  function render() {
    var g = $("lnList"); if (!g) return;
    var q = (($("lnQ") || {}).value || "").trim().toLowerCase();
    var L = sorted(SORT).filter(function (t) { return !q || (t.name + " " + t.ticker).toLowerCase().indexOf(q) > -1 });
    g.innerHTML = L.length ? L.map(card).join("") : '<p class="empty">' + (ALL.length ? "No token matches “" + esc(q) + "”." : "No launches yet. Be the first to launch.") + '</p>';
    bind(g);
  }
  function stats() {
    var n = $("stCount"), l = $("stLiq"), v = $("stVol"); if (n) n.textContent = ALL.length.toLocaleString("en-US");
    var liq = 0, vol = 0, k = 0; ALL.forEach(function (t) { if (t.stats) { liq += (t.stats.liq || 0) / 2; vol += t.stats.vol24 || 0; k++ } });
    if (l) l.textContent = ALL.length && !k ? "…" : fmt(liq) + " XRP";
    if (v) v.textContent = ALL.length && !k ? "…" : fmt(vol) + " XRP";
  }
  async function list() {
    if (!$("lnList")) return;
    try { var d = await fetch("/api/launch?stats=1").then(function (r) { return r.json() }); ALL = (d && d.launches) || [] } catch (e) { ALL = [] }
    // Fill gaps straight from the ledger if the server couldn't compute stats for some tokens.
    await Promise.all(ALL.filter(function (t) { return !t.stats }).slice(0, 30).map(async function (t) {
      try { var a = await amm(t.currency, t.issuer); if (!a) return; var x = Number(a.amount) / 1e6, tk = Number(a.amount2.value);
        t.stats = { price: x / tk, liq: x * 2, mcap: Number(t.supply) ? (x / tk) * Number(t.supply) : null } } catch (e) {}
    }));
    render(); renderTop(); stats();
  }

  /* ----- token page ----- */
  var chart = null;
  function show(view) { ["pExplore", "pCreate", "pToken"].forEach(function (p) { if ($(p)) $(p).hidden = p !== view }); if ($("lnTabs")) $("lnTabs").hidden = view === "pToken"; if ($("lnHero")) $("lnHero").hidden = view === "pToken"; if ($("lnMore")) $("lnMore").hidden = view === "pToken" }
  function openToken(id, noPush) {
    if (!$("pToken")) return trade(id);
    if (!noPush) try { history.pushState({ t: id }, "", BASE + "?t=" + encodeURIComponent(id)) } catch (e) {}
    show("pToken"); window.scrollTo(0, 0);
    var known = ALL.filter(function (t) { return idOf(t) === id })[0];
    $("tkView").innerHTML = '<p class="empty">Loading ' + esc(known ? known.name : "token") + '…</p>';
    fetch("/api/launch?id=" + encodeURIComponent(id)).then(function (r) { return r.json() }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || "Token not found");
      d.token.stats = d.stats || (known && known.stats) || {};
      renderToken(d);
    }).catch(function (e) { $("tkView").innerHTML = '<p class="empty">' + esc(e.message) + '</p>' });
  }
  function closeToken() { show("pExplore"); try { history.pushState({}, "", BASE) } catch (e) {} }
  function renderToken(d) {
    var t = d.token, s = t.stats, id = idOf(t), h = d.holders, links = "";
    [["web", "Website"], ["x", "X"], ["tg", "Telegram"]].forEach(function (k) { if (t[k[0]]) links += '<a class="btn s sm" href="' + esc(t[k[0]]) + '" target="_blank" rel="noopener nofollow">' + k[1] + ' ↗</a>' });
    var buys = s.buys24 || 0, sells = s.sells24 || 0;
    $("tkView").innerHTML =
      '<div class="tkh">' + logoHtml(t) + '<div><h2>' + esc(t.name) + ' <span class="mut">' + esc(t.ticker) + '</span></h2><div class="mut sm2">Launched ' + age(t.created_at) + ' ago · ' + esc(t.ticker) + '/XRP · pool fee ' + (s.poolFee != null ? s.poolFee + "%" : "—") + '</div></div>' +
        '<div class="tkp"><b>' + xrp(s.price) + '</b>' + chg(s.change24) + '</div></div>' +
      '<div class="tkg"><div class="tkm">' +
        '<div class="blk tkc o1"><div class="tkct"><span>Price (XRP)</span><div class="seg" id="tkTf"><button type="button" data-h="24" aria-pressed="false">24h</button><button type="button" data-h="168" aria-pressed="false">7d</button><button type="button" data-h="0" aria-pressed="true">All</button></div></div><div id="tkChart" class="chartbox"></div></div>' +
        '<div class="blk o3"><h3>Recent trades</h3><div id="tkTrades"></div></div></div>' +
      '<aside class="tks">' +
        '<div class="blk o2"><div class="tkb"><button class="btn p" type="button" id="tkBuy">Buy ' + esc(t.ticker) + '</button><button class="btn s" type="button" id="tkSell">Sell</button></div>' +
          '<div class="sum"><div><span>Market cap</span><b>' + xrp(s.mcap) + '</b></div><div><span>Liquidity</span><b>' + xrp(s.liq) + '</b></div><div><span>24h volume</span><b>' + xrp(s.vol24) + '</b></div>' +
          '<div><span>24h trades</span><b><span class="up">' + buys + ' buys</span> · <span class="dn">' + sells + ' sells</span></b></div>' +
          '<div><span>Holders</span><b>' + (h ? h.count.toLocaleString("en-US") + (h.capped ? "+" : "") : "—") + '</b></div><div><span>Supply</span><b>' + (s.supply || Number(t.supply) ? fmt(s.supply || Number(t.supply)) : "—") + '</b></div>' +
          '<div><span>Dev allocation</span><b>' + (Number(t.dev_pct) ? esc(t.dev_pct) + "%" : "None") + '</b></div></div></div>' +
        '<div class="blk"><h3>Safety</h3><div class="pills" style="margin:8px 0 10px"><span class="pill">🔒 Supply locked</span><span class="pill">🔒 Liquidity locked</span><span class="pill">No freeze</span></div>' +
          '<div class="proof"><a href="' + EXPL + esc(t.issuer) + '" target="_blank" rel="noopener">Issuer (blackholed) ↗</a>' + (s.amm ? '<a href="' + EXPL + esc(s.amm) + '" target="_blank" rel="noopener">AMM pool ↗</a>' : '') + '<a href="' + MAIN + '/?ca=' + encodeURIComponent(id) + '#scanner">Scan on CBL ↗</a></div></div>' +
        (t.description || links ? '<div class="blk"><h3>About</h3>' + (t.description ? '<p class="mut" style="margin:6px 0 12px">' + esc(t.description) + '</p>' : '') + '<div class="tkl">' + links + '</div></div>' : '') +
        (h && h.top && h.top.length ? '<div class="blk"><h3>Top holders</h3><ol class="hold">' + h.top.map(function (x) { return '<li><a href="' + EXPL + esc(x.account) + '" target="_blank" rel="noopener">' + esc(x.account.slice(0, 6) + "…" + x.account.slice(-4)) + '</a><b>' + x.pct.toFixed(2) + '%</b></li>' }).join("") + '</ol><small class="mut">Pool excluded.</small></div>' : '') +
        '<div class="blk"><h3>Token ID</h3><div class="tid"><code>' + esc(id) + '</code><button class="btn s sm" type="button" id="tkCopy">Copy</button></div></div>' +
      '</aside></div>';
    $("tkBuy").onclick = $("tkSell").onclick = function () { trade(id) };
    $("tkCopy").onclick = function () { try { navigator.clipboard.writeText(id); $("tkCopy").textContent = "Copied" } catch (e) {} };
    var tr = d.trades || [];
    $("tkTrades").innerHTML = tr.length ? '<div class="trw"><table class="lb tr"><thead><tr><th>Type</th><th class="r">XRP</th><th class="r hs">' + esc(t.ticker) + '</th><th class="r hm">Price</th><th class="r hs">Account</th><th class="r">Age</th></tr></thead><tbody>' +
      tr.map(function (r) { var lab = { buy: "Buy", sell: "Sell", create: "Launch", add: "Add", remove: "Remove" }[r.side] || r.side, cls = r.side === "buy" || r.side === "create" ? "up" : r.side === "sell" ? "dn" : "mut";
        return '<tr><td class="' + cls + '">' + lab + '</td><td class="r">' + fmt(r.xrp) + '</td><td class="r hs">' + fmt(r.tok) + '</td><td class="r hm">' + (r.price ? fmt(r.price) : "—") + '</td><td class="r hs">' + (r.account ? '<a href="' + EXPL + esc(r.account) + '" target="_blank" rel="noopener">' + esc(r.account.slice(0, 5) + "…" + r.account.slice(-4)) + '</a>' : "") + '</td><td class="r">' + (r.hash ? '<a href="' + TXL + esc(r.hash) + '" target="_blank" rel="noopener">' + age(r.t * 1000) + '</a>' : age(r.t * 1000)) + '</td></tr>' }).join("") + '</tbody></table></div>'
      : '<p class="mut">No trades yet.</p>';
    drawChart(d.history || [], 0);
    $("tkTf").querySelectorAll("button").forEach(function (b) { b.onclick = function () { $("tkTf").querySelectorAll("button").forEach(function (o) { o.setAttribute("aria-pressed", o === b) }); drawChart(d.history || [], Number(b.dataset.h)) } });
  }
  function loadChartLib() {
    if (window.LightweightCharts) return Promise.resolve();
    return new Promise(function (ok, no) { var s = document.createElement("script"); s.src = CHART_LIB; s.onload = ok; s.onerror = function () { no(new Error("chart")) }; document.head.appendChild(s) });
  }
  async function drawChart(hist, hours) {
    var box = $("tkChart"); if (!box) return;
    var since = hours ? Date.now() / 1000 - hours * 3600 : 0, pts = hist.filter(function (p) { return p.t >= since });
    if (pts.length < 2) { if (chart) { chart.remove(); chart = null } box.innerHTML = '<p class="empty" style="border:0">Not enough trades yet for a chart.</p>'; return }
    try { await loadChartLib() } catch (e) { box.innerHTML = '<p class="empty" style="border:0">Chart could not load.</p>'; return }
    if (chart) { chart.remove(); chart = null } box.innerHTML = "";
    var css = getComputedStyle(document.documentElement), v = function (n) { return css.getPropertyValue(n).trim() };
    chart = LightweightCharts.createChart(box, { autoSize: true, layout: { background: { type: "solid", color: "transparent" }, textColor: v("--mute"), fontFamily: "DM Sans, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: v("--line") } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
      localization: { priceFormatter: function (p) { return p > 1e-12 ? fmt(p) : "" } } });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.25 } });
    var line = chart.addAreaSeries({ lineColor: "#E917E0", topColor: "rgba(233,23,224,.28)", bottomColor: "rgba(19,32,229,0)", lineWidth: 2, priceFormat: { type: "price", precision: 10, minMove: 1e-10 } });
    var vol = chart.addHistogramSeries({ priceScaleId: "", priceFormat: { type: "volume" }, color: "rgba(11,156,240,.35)", lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // one point per second max (lightweight-charts needs strictly increasing time)
    var byT = {}; pts.forEach(function (p) { var k = Math.floor(p.t); byT[k] = { p: p.p, v: ((byT[k] || {}).v || 0) + p.v } });
    var ks = Object.keys(byT).map(Number).sort(function (a, b) { return a - b });
    line.setData(ks.map(function (k) { return { time: k, value: byT[k].p } }));
    vol.setData(ks.map(function (k) { return { time: k, value: byT[k].v } }));
    chart.timeScale().fitContent();
  }

  /* ---------- live preview ---------- */
  function preview() {
    var n = $("pvName"), tk = $("pvTicker"), lg = $("pvLogo"); if (!n) return;
    n.textContent = $("lnName").value.trim() || "Your token";
    tk.textContent = ($("lnTicker").value.trim() || "TICKER").toUpperCase();
    var u = $("lnLogo").dataset.url;
    if (u) { lg.textContent = ""; lg.style.background = "center/cover no-repeat url(" + u + ")" }
    else lg.textContent = (($("lnTicker").value.trim() || $("lnName").value.trim() || "?")[0] || "?").toUpperCase();
  }

  function init() {
    if (!$("launch")) return;
    logoInput();
    ["lnName", "lnTicker", "lnSupply", "lnDev", "lnPool"].forEach(function (i) { $(i).addEventListener("input", function () { summary(); preview() }) });
    if ($("lnQ")) $("lnQ").addEventListener("input", render);
    if ($("lnSort")) $("lnSort").querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { SORT = b.dataset.s; $("lnSort").querySelectorAll("button").forEach(function (o) { o.setAttribute("aria-pressed", o === b) }); render() };
    });
    if ($("tkBack")) $("tkBack").onclick = closeToken;
    window.addEventListener("popstate", function () { var t = new URLSearchParams(location.search).get("t"); if (t) openToken(t, true); else show("pExplore") });
    var t0 = new URLSearchParams(location.search).get("t"); if (t0) openToken(t0, true);
    if ($("lnTier")) $("lnTier").querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { $("lnPool").value = b.dataset.v; syncTier(); summary() };
    });
    $("lnPool").addEventListener("input", syncTier); syncTier();
    $("lnFee").querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { $("lnFee").querySelectorAll("button").forEach(function (o) { o.setAttribute("aria-pressed", o === b) }); summary() };
    });
    $("lnGo").onclick = start;
    pendingBanner(); summary(); preview(); list();
    if (load() && $("tCreate")) $("tCreate").click();
  }
  window.CBLLaunch = { _plan: plan, _steps: steps };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
