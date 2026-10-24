/* XRPLaunch (by CBL) — fair-launch XRPL tokens with no custody.
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
        var r = await C().send({ TransactionType: "Payment", Account: cr, Destination: L, Amount: C().drops(p.lpFund), Memos: [{ Memo: { MemoData: hex("XRPLaunch " + f.ticker) } }] }, say);
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
      $("lnTrade").onclick = function () { if (window.cblSwapXrpl) window.cblSwapXrpl(id) };
      $("lnShare").onclick = function () { var u = location.origin + "/?swap=" + id + "&chain=xrpl#swap"; try { navigator.clipboard.writeText(u); $("lnShare").textContent = "Copied" } catch (e) { prompt("Share link", u) } };
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
  async function summary() {
    var box = $("lnSum");
    try {
      var f = readForm(), cfg = X() && X().core ? await C().cfg() : {}, fee = cfg.launchFeeAccount ? Number(cfg.launchFee) || 0 : 0;
      var p = plan(f, { base: 1, inc: 0.2 }, fee);
      box.innerHTML = "<div><span>Starting price</span><b>" + fmt(p.price) + " XRP</b></div>" +
        "<div><span>Starting market cap</span><b>" + fmt(p.mcap) + " XRP</b></div>" +
        "<div><span>Pool</span><b>" + fmt(f.poolXrp) + " XRP + " + fmt(p.pool) + " " + esc(f.ticker) + "</b></div>" +
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
        el.dataset.url = u; el.style.backgroundImage = "url(" + u + ")"; el.textContent = "";
      };
      rd.readAsDataURL(fl);
    };
  }

  /* ---------- "New on CBL" list ---------- */
  async function list() {
    var g = $("lnList"); if (!g) return;
    try {
      var d = await fetch("/api/launch").then(function (r) { return r.json() });
      var L = (d && d.launches) || [];
      if (!L.length) { g.innerHTML = '<p class="hint">No launches yet. Be the first.</p>'; return }
      g.innerHTML = L.map(function (t) {
        var id = t.currency + "." + t.issuer, logo = /^data:image\/(png|webp|jpeg);base64,/.test(t.logo || "") ? t.logo : "";
        return '<article class="fc lnc"><div class="fcn">' + (logo ? '<img class="lnl" alt="" src="' + logo + '">' : '<span class="av">' + esc((t.ticker || "?")[0]) + '</span>') +
          '<div><b>' + esc(t.name) + '</b> <small>' + esc(t.ticker) + '</small><div class="lnp" data-c="' + esc(t.currency) + '" data-i="' + esc(t.issuer) + '">…</div></div></div>' +
          (t.description ? '<p>' + esc(t.description) + '</p>' : '') +
          '<div class="row"><span class="tag">🔒 Supply locked</span><span class="tag">🔒 LP locked</span>' + (Number(t.dev_pct) ? '<span class="tag">Dev ' + esc(t.dev_pct) + '%</span>' : '') + '</div>' +
          '<div class="row"><button class="buy" type="button" data-id="' + esc(id) + '">Buy</button><a class="chip" href="/?ca=' + encodeURIComponent(id) + '#scanner">Scan</a>' +
          (t.web ? '<a class="chip" href="' + esc(t.web) + '" target="_blank" rel="noopener nofollow">Web</a>' : '') +
          (t.x ? '<a class="chip" href="' + esc(t.x) + '" target="_blank" rel="noopener nofollow">X</a>' : '') +
          (t.tg ? '<a class="chip" href="' + esc(t.tg) + '" target="_blank" rel="noopener nofollow">TG</a>' : '') + '</div></article>';
      }).join("");
      g.querySelectorAll("button.buy[data-id]").forEach(function (b) { b.onclick = function () { if (window.cblSwapXrpl) window.cblSwapXrpl(b.dataset.id) } });
      g.querySelectorAll(".lnp").forEach(async function (el) {
        try {
          var a = await amm(el.dataset.c, el.dataset.i); if (!a) { el.textContent = ""; return }
          var x = Number(a.amount) / 1e6, t = Number(a.amount2.value);
          el.textContent = fmt(x / t) + " XRP · liquidity " + fmt(x * 2) + " XRP";
        } catch (e) { el.textContent = "" }
      });
    } catch (e) { g.innerHTML = "" }
  }

  function init() {
    if (!$("launch")) return;
    logoInput();
    ["lnName", "lnTicker", "lnSupply", "lnDev", "lnPool"].forEach(function (i) { $(i).addEventListener("input", summary) });
    $("lnFee").querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { $("lnFee").querySelectorAll("button").forEach(function (o) { o.setAttribute("aria-pressed", o === b) }); summary() };
    });
    $("lnGo").onclick = start;
    pendingBanner(); summary(); list();
  }
  window.CBLLaunch = { _plan: plan, _steps: steps };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
