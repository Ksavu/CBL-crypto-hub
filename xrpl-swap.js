/* CBL Swap — XRP Ledger module.
 * Native XRPL swaps against the ledger's built-in AMM + order book.
 * Wallets: Xaman (QR / deeplink / xApp), Joey (extension, or app via WalletConnect), Crossmark, GemWallet.
 * Fee: paid in XRP to XRPL_FEE_ACCOUNT. Swap + fee go in one atomic Batch
 * transaction (one signature); if the wallet or network can't do Batch, it
 * falls back to the swap followed by a separate fee payment.
 * Token id format (same as the scanner/bot): CODE.rIssuer
 */
(function () {
  "use strict";
  var WS = ["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"];
  var LIB = {
    xrpl: "https://cdn.jsdelivr.net/npm/xrpl@5.3.0/build/xrpl-latest-min.js",
    xumm: "https://cdn.jsdelivr.net/npm/xumm@1.8.1/dist/browser.min.js",
    crossmark: "https://cdn.jsdelivr.net/npm/@crossmarkio/sdk@0.4.0/pack/umd/index.js",
    gem: "https://cdn.jsdelivr.net/npm/@gemwallet/api@3.8.0/umd/gemwallet-api.js",
    joey: "https://cdn.jsdelivr.net/npm/@joeywallet/wallet-sdk@0.5.0/+esm",
    wcSign: "https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.17.0/dist/index.umd.js",
    qr: "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"
  };
  /* Same public WalletConnect project ID as the EVM connect in index.html; WC_PROJECT_ID in Vercel overrides it. */
  var WC_ID = "e07d269576aa4aebfe1c7eaf2f6139cf", XRPL_CHAIN = "xrpl:0",
      JOEY_WC = ["xrpl_signTransaction", "xrpl_signTransactionFor", "xrpl_signTransactionBatch", "xrpl_signTransactionFee"];
  var EXPLORER = "https://livenet.xrpl.org/transactions/";
  var tfSell = 0x00080000, tfFillOrKill = 0x00040000, tfSetNoRipple = 0x00020000,
      tfAllOrNothing = 0x00010000, tfInnerBatchTxn = 0x40000000;
  var ID_RE = /^([A-Za-z0-9]{1,40})\.(r[1-9A-HJ-NP-Za-km-z]{24,34})$/;
  var MIN_FEE = 0.00001;

  var $ = function (i) { return document.getElementById(i) };
  var CFG = null, client = null, clientP = null, wallet = null, account = null, pend = null;
  var ISM = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  /* ---------- helpers ---------- */
  function loadScript(u, test) {
    if (test()) return Promise.resolve();
    return new Promise(function (ok, no) {
      var s = document.createElement("script"); s.src = u; s.onload = ok;
      s.onerror = function () { no(new Error("Could not load an XRPL library")) };
      document.head.appendChild(s);
    });
  }
  function short(a) { return a.slice(0, 6) + "..." + a.slice(-4) }
  function sl(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  async function cfg() {
    if (CFG) return CFG;
    try { CFG = await fetch("/api/config").then(function (r) { return r.json() }) } catch (e) { CFG = {} }
    return CFG;
  }

  /** "SOLO.rIssuer" → { currency (ledger form), issuer, label } */
  function parseId(s) {
    var m = String(s || "").trim().match(ID_RE);
    if (!m) return null;
    var code = m[1], cur;
    if (/^[0-9A-Fa-f]{40}$/.test(code)) cur = code.toUpperCase();
    else if (code.length === 3 && code.toUpperCase() !== "XRP") cur = code;
    else if (code.length <= 20) {
      cur = Array.prototype.map.call(new TextEncoder().encode(code), function (b) { return b.toString(16).padStart(2, "0") }).join("").toUpperCase().padEnd(40, "0");
    } else return null;
    return { currency: cur, issuer: m[2], label: label(cur) };
  }
  function label(cur) {
    if (!/^[0-9A-F]{40}$/i.test(cur)) return cur;
    var bytes = cur.match(/.{2}/g).map(function (h) { return parseInt(h, 16) }).filter(function (b) { return b });
    try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)) } catch (e) { return cur.slice(0, 8) }
  }
  function isId(s) { return !!parseId(s) }

  /** IOU values: max 15 significant digits, never exponent notation, rounded down. */
  function iou(n) {
    if (!(n > 0)) return "0";
    var v = Number(n.toPrecision(15));
    if (v > n) v = Number((v - Math.pow(10, Math.floor(Math.log10(n)) - 14)).toPrecision(15));
    return v.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
  }
  function drops(x) { return String(Math.floor(x * 1e6 + 1e-9)) }
  function fmt(n) { return n >= 1 ? Number(n.toPrecision(7)).toString() : Number(n.toPrecision(6)).toString() }

  /* ---------- ledger ---------- */
  async function getClient() {
    if (client && client.isConnected()) return client;
    if (clientP) return clientP;
    clientP = (async function () {
      await loadScript(LIB.xrpl, function () { return window.xrpl && window.xrpl.Client });
      var last;
      for (var i = 0; i < WS.length; i++) {
        var c = new window.xrpl.Client(WS[i], { connectionTimeout: 10000 });
        try { await c.connect(); client = c; return c } catch (e) { last = e; try { await c.disconnect() } catch (e2) {} }
      }
      throw new Error("Could not reach the XRP Ledger (" + ((last && last.message) || "network") + ")");
    })();
    try { return await clientP } finally { clientP = null }
  }
  async function req(o) { var c = await getClient(); return (await c.request(o)).result }

  async function getPool(tok) {
    try {
      var r = await req({ command: "amm_info", asset: { currency: "XRP" }, asset2: { currency: tok.currency, issuer: tok.issuer }, ledger_index: "validated" });
      var a = r.amm, xrpSide = typeof a.amount === "string";
      var rx = xrpSide ? Number(a.amount) / 1e6 : Number(a.amount2) / 1e6;
      var rt = Number(xrpSide ? a.amount2.value : a.amount.value);
      return { rx: rx, rt: rt, fee: (a.trading_fee || 0) / 100000, account: a.account, frozen: !!(a.asset_frozen || a.asset2_frozen) };
    } catch (e) {
      if (e && e.data && e.data.error === "actNotFound") return null;
      throw e;
    }
  }

  /** XLS-30 swap formula (fee on input). */
  function swapOut(rin, rout, fee, amtIn) { var x = amtIn * (1 - fee); return x > 0 ? rout * x / (rin + x) : 0 }

  /**
   * Quote. side "buy": pay XRP, receive token. side "sell": pay token, receive XRP.
   * Fee (XRP): buy → % of XRP paid (deducted before swapping); sell → % of minimum XRP received.
   */
  function quote(pool, side, amt, slip, feeBps, feeOn) {
    var rate = feeOn ? feeBps / 10000 : 0, fee = 0, inAmt = amt, out, spot;
    if (side === "buy") {
      fee = amt * rate; if (fee < MIN_FEE) fee = 0;
      inAmt = amt - fee;
      out = swapOut(pool.rx, pool.rt, pool.fee, inAmt); spot = pool.rt / pool.rx;
    } else {
      out = swapOut(pool.rt, pool.rx, pool.fee, amt); spot = pool.rx / pool.rt;
    }
    var min = out * (1 - slip);
    if (side === "sell") { fee = min * rate; if (fee < MIN_FEE) fee = 0 }
    fee = Math.floor(fee * 1e6) / 1e6;
    var impact = Math.max(0, 1 - (out / inAmt) / spot);
    return { side: side, amt: amt, inAmt: inAmt, out: out, min: min, fee: fee, impact: impact };
  }

  function buildOffer(acct, tok, q) {
    var tokAmt = function (v) { return { currency: tok.currency, issuer: tok.issuer, value: iou(v) } };
    return {
      TransactionType: "OfferCreate", Account: acct,
      TakerGets: q.side === "buy" ? drops(q.inAmt) : tokAmt(q.inAmt),
      TakerPays: q.side === "buy" ? tokAmt(q.min) : drops(q.min),
      Flags: tfSell | tfFillOrKill
    };
  }
  function buildFee(acct, feeAcct, fee) { return { TransactionType: "Payment", Account: acct, Destination: feeAcct, Amount: drops(fee) } }
  function buildBatch(acct, offer, payment) {
    var inner = function (t) { return { RawTransaction: Object.assign({}, t, { Flags: (t.Flags || 0) | tfInnerBatchTxn, Fee: "0", SigningPubKey: "" }) } };
    return { TransactionType: "Batch", Account: acct, Flags: tfAllOrNothing, RawTransactions: [inner(offer), inner(payment)] };
  }

  async function lineOf(acct, tok) {
    try {
      var r = await req({ command: "account_lines", account: acct, peer: tok.issuer, ledger_index: "validated" });
      return (r.lines || []).filter(function (l) { return l.currency === tok.currency })[0] || null;
    } catch (e) { if (e && e.data && e.data.error === "actNotFound") throw new Error("This XRPL account is not activated yet. Send at least 1 XRP to it first."); throw e }
  }
  async function spendableXrp(acct) {
    var info = (await req({ command: "account_info", account: acct, ledger_index: "validated" })).account_data;
    var s = (await req({ command: "server_info" })).info.validated_ledger;
    return Number(info.Balance) / 1e6 - (s.reserve_base_xrp || 1) - (s.reserve_inc_xrp || 0.2) * info.OwnerCount;
  }

  async function waitTx(hash) {
    for (var i = 0; i < 45; i++) {
      try {
        var r = await req({ command: "tx", transaction: hash });
        if (r.validated) return { code: (r.meta || r.metaData).TransactionResult, ledger: r.ledger_index };
      } catch (e) { if (!(e && e.data && e.data.error === "txnNotFound")) throw e }
      await sl(1500);
    }
    throw new Error("Not confirmed yet. Check the transaction in your wallet.");
  }
  async function innerResults(acct, hash, ledger) {
    var r = await req({ command: "account_tx", account: acct, ledger_index_min: ledger, ledger_index_max: ledger, limit: 50 });
    return (r.transactions || []).filter(function (t) { return (t.meta || t.metaData || {}).ParentBatchID === hash })
      .map(function (t) { return (t.meta || t.metaData).TransactionResult });
  }

  var WHY = {
    tecKILLED: "Price moved past your slippage, so nothing was traded. Try again or raise slippage.",
    tecUNFUNDED_OFFER: "Not enough balance for this swap.",
    tecINSUF_RESERVE_OFFER: "Not enough XRP left to cover the account reserve.",
    tecNO_LINE_INSUF_RESERVE: "Not enough XRP to hold a new token (each token locks 0.2 XRP reserve).",
    tecPATH_DRY: "Not enough liquidity for this trade.",
    tecNO_AUTH: "This token requires issuer authorization.",
    tecFROZEN: "This token is frozen by its issuer.",
    tecBATCH: "Swap did not go through. Nothing was traded and no fee was charged. Try again or raise slippage."
  };
  function why(c) { return WHY[c] || ("Transaction failed (" + c + ")") }

  /* ---------- wallets ---------- */
  var xumm = null, cm = null, joeySdk = null, wcc = null, wcTopic = null, joeyMode = null;
  function joeyExt() { return window.joey || (window.xrpl && window.xrpl.joey) || null }
  async function joeyApi() {
    if (!joeySdk) joeySdk = await import(LIB.joey);
    var j = joeySdk.getJoey();
    if (!j && joeyExt() === null) { try { j = await joeySdk.waitForJoey({ timeoutMs: 1200 }) } catch (e) { j = null } }
    return j;
  }
  async function wcClient() {
    if (wcc) return wcc;
    var id = (await cfg()).wc || WC_ID;
    await loadScript(LIB.wcSign, function () { return window["@walletconnect/sign-client"] });
    var SC = window["@walletconnect/sign-client"].SignClient || window["@walletconnect/sign-client"].default;
    wcc = await SC.init({ projectId: id, metadata: { name: "CBL", description: "CBL Swap", url: location.origin, icons: [] } });
    wcc.on("session_delete", function (e) { if (e && e.topic === wcTopic) { wcTopic = null; if (wallet === "Joey") disconnect() } });
    wcc.on("session_expire", function (e) { if (e && e.topic === wcTopic) wcTopic = null });
    return wcc;
  }
  function wcAddr(sess) {
    var a = ((sess.namespaces.xrpl || {}).accounts || []).filter(function (x) { return x.indexOf(XRPL_CHAIN + ":") === 0 })[0];
    return a ? a.split(":")[2] : null;
  }
  function wcSession(c) {
    var all = c.session.getAll().filter(function (x) { return x.namespaces && x.namespaces.xrpl && x.expiry * 1000 > Date.now() + 60000 && wcAddr(x) });
    return all[all.length - 1] || null;
  }
  async function qrModal(uri, title, appLink) {
    await loadScript(LIB.qr, function () { return window.qrcode });
    var q = window.qrcode(0, "M"); q.addData(uri); q.make();
    var o = document.createElement("div");
    o.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px";
    o.innerHTML = '<div style="background:#fff;color:#111;border-radius:16px;padding:20px;max-width:320px;width:100%;text-align:center;font:16px system-ui,sans-serif"><b style="font-size:19px"></b><div class="jq" style="margin:12px auto;width:240px;height:240px"></div><div style="color:#555;margin-bottom:12px">Open Joey, tap WalletConnect / Scan, and scan this code.</div><a target="_blank" rel="noopener" style="display:block;padding:10px;border-radius:10px;border:1px solid #ccc;background:#f4f4f4;color:#111;text-decoration:none">Open Joey</a></div>';
    o.querySelector("b").textContent = title;
    o.querySelector(".jq").innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    o.querySelector("a").href = appLink;
    document.body.appendChild(o); return o;
  }
  var W = {
    Xaman: {
      ok: async function () { return !!(await cfg()).xaman },
      web: "https://xaman.app",
      init: async function () {
        if (xumm) return xumm;
        var key = (await cfg()).xaman;
        if (!key) throw new Error("Xaman is not set up yet. Add XAMAN_API_KEY in Vercel and redeploy.");
        await loadScript(LIB.xumm, function () { return window.Xumm });
        var X = window.Xumm.Xumm || window.Xumm;
        xumm = new X(key); return xumm;
      },
      connect: async function () {
        var x = await this.init();
        if (x.runtime && x.runtime.xapp) { var a0 = await x.user.account; if (a0) return a0 }
        var r = await x.authorize();
        if (r instanceof Error) throw r;
        var a = (r && r.me && r.me.account) || (await x.user.account);
        if (!a) throw new Error("Wallet connection cancelled");
        return a;
      },
      restore: async function () {
        if (!(await cfg()).xaman) return null;
        var x = await this.init();
        await Promise.race([x.environment.ready, sl(4000)]);
        return (await x.user.account) || null;
      },
      disconnect: async function () { if (xumm) try { await xumm.logout() } catch (e) {} },
      sign: async function (tx, say) {
        var x = await this.init();
        if (!x.payload) throw new Error("Xaman session expired. Connect again.");
        var sub = await x.payload.createAndSubscribe({ txjson: tx, options: { submit: true, expire: 5 } }, function (ev) { if ("signed" in ev.data) return ev.data });
        var c = sub.created, qr = null;
        if (x.runtime && x.runtime.xapp && x.xapp) x.xapp.openSignRequest({ uuid: c.uuid });
        else if (ISM) location.href = c.next.always;
        else qr = showQr(c.refs.qr_png, c.next.always);
        say("Sign in Xaman...");
        try {
          var res = await sub.resolved;
          if (!res || !res.signed) throw new Error("Rejected in wallet");
          var p = await x.payload.get(c.uuid);
          if (!p || !p.response || !p.response.txid) throw new Error("Xaman returned no transaction hash");
          return { hash: p.response.txid, er: p.response.dispatched_result || "" };
        } finally { if (qr) qr.remove() }
      }
    },
    Joey: {
      web: "https://joeywallet.xyz",
      ok: async function () { return true },
      label: function () { return joeyExt() ? "Detected" : ISM ? "Opens Joey" : "Scan QR with phone" },
      connect: async function () {
        if (joeyExt()) {
          var j = await joeyApi();
          if (j) {
            var icon = /^https:/.test(location.origin) ? location.origin + "/favicon.ico" : undefined;
            var r = await j.connect({ chain: XRPL_CHAIN, name: "CBL Swap", icon: icon });
            var a = r && r.accounts && r.accounts[0] && r.accounts[0].address;
            if (!a) throw new Error("Wallet connection cancelled");
            joeyMode = "ext"; return a;
          }
        }
        var c = await wcClient(), old = wcSession(c);
        if (old) { wcTopic = old.topic; joeyMode = "wc"; return wcAddr(old) }
        var p = await c.connect({ requiredNamespaces: { xrpl: { chains: [XRPL_CHAIN], methods: JOEY_WC, events: [] } } });
        var link = "joey://settings/wc?uri=" + encodeURIComponent(p.uri), modal = null, closed = false;
        if (ISM) location.href = link;
        else {
          modal = await qrModal(p.uri, "Connect Joey Wallet", link);
          modal.addEventListener("click", function (e) { if (e.target === modal) { closed = true; modal.remove() } });
        }
        try {
          var sess = await Promise.race([p.approval(), new Promise(function (ok, no) {
            var t = setInterval(function () { if (closed) { clearInterval(t); no(new Error("Wallet connection cancelled")) } }, 400);
          })]);
          wcTopic = sess.topic; joeyMode = "wc";
          var a2 = wcAddr(sess); if (!a2) throw new Error("Joey shared no XRPL mainnet account");
          return a2;
        } catch (e) {
          throw new Error(/reject|denied|cancel/i.test(String(e && e.message)) ? "Wallet connection cancelled" : "Joey did not connect. Try again.");
        } finally { if (modal && !closed) modal.remove() }
      },
      restore: async function () {
        if (joeyExt()) {
          var j = await joeyApi();
          if (j) { var r = await j.connect({ silent: true }); var a = r && r.accounts && r.accounts[0] && r.accounts[0].address; if (a) { joeyMode = "ext"; return a } }
        }
        var c = await wcClient(), s0 = wcSession(c);
        if (!s0) return null;
        wcTopic = s0.topic; joeyMode = "wc"; return wcAddr(s0);
      },
      disconnect: async function () {
        try {
          if (joeyMode === "ext") { var j = await joeyApi(); if (j) await j.disconnect() }
          else if (wcc && wcTopic) await wcc.disconnect({ topic: wcTopic, reason: { code: 6000, message: "User disconnected" } });
        } catch (e) {}
        wcTopic = null; joeyMode = null;
      },
      sign: async function (tx, say) {
        var pre = tx.TransactionType === "Batch";
        if (joeyMode === "ext") {
          var j = await joeyApi(); if (!j) throw new Error("Joey extension not found. Connect again.");
          say("Confirm in Joey...");
          var r = await j.signAndSubmitTransaction({ account: tx.Account, chain: XRPL_CHAIN, tx_json: tx, autofill: !pre });
          if (!r || !r.hash) throw new Error("Joey returned no transaction hash");
          return { hash: r.hash, er: r.engine_result || "" };
        }
        var c = await wcClient();
        if (!wcTopic) { var s1 = wcSession(c); if (!s1) throw new Error("Joey session expired. Connect again."); wcTopic = s1.topic }
        say(ISM ? "Confirm in Joey..." : "Confirm in the Joey app on your phone...");
        var pr = c.request({ topic: wcTopic, chainId: XRPL_CHAIN, request: { method: "xrpl_signTransaction", params: { tx_json: tx, options: { autofill: !pre, submit: true } } } });
        if (ISM) setTimeout(function () { location.href = "joey://settings" }, 300);
        var res = await pr, out = (res && res.tx_json) || res || {}, blob = (res && res.tx_blob) || out.tx_blob, h = out.hash || (res && res.hash);
        var xl = window.xrpl;
        if (!h && blob && xl && xl.hashes) h = xl.hashes.hashSignedTx(blob);
        if (!h) throw new Error("Joey returned no transaction hash");
        var er = (out.meta && out.meta.TransactionResult) || (res && res.engine_result) || "";
        if (blob && !er) { try { er = (await req({ command: "submit", tx_blob: blob })).engine_result || "" } catch (e) {} if (/^tef(PAST_SEQ|ALREADY)/.test(er)) er = "" }
        return { hash: h, er: er };
      }
    },
    Crossmark: {
      web: "https://crossmark.io",
      init: async function () {
        if (cm) return cm;
        var prev = window["default"];
        await loadScript(LIB.crossmark, function () { return false });
        cm = window["default"]; if (prev !== undefined) window["default"] = prev;
        return cm;
      },
      ok: async function () { try { var s = await this.init(); return !!(s.sync.isInstalled() || await s.async.detect(1200)) } catch (e) { return false } },
      connect: async function () {
        var s = await this.init(), r = await s.async.signInAndWait();
        var a = r && r.response && r.response.data && r.response.data.address;
        if (!a) throw new Error("Wallet connection cancelled"); return a;
      },
      restore: async function () { var s = await this.init(); return s.sync.isInstalled() ? (s.sync.getAddress() || null) : null },
      disconnect: async function () {},
      sign: async function (tx, say) {
        var s = await this.init(); say("Confirm in Crossmark...");
        var r = await s.async.signAndSubmitAndWait(tx), d = r && r.response && r.response.data;
        if (!d || (d.meta && d.meta.isRejected)) throw new Error("Rejected in wallet");
        var res = d.resp && d.resp.result;
        var h = res && (res.hash || (res.tx_json && res.tx_json.hash));
        if (!h) throw new Error("Crossmark returned no transaction hash");
        return { hash: h, er: (res.meta && res.meta.TransactionResult) || res.engine_result || "" };
      }
    },
    GemWallet: {
      web: "https://gemwallet.app",
      init: async function () { await loadScript(LIB.gem, function () { return window.GemWalletApi }); return window.GemWalletApi },
      ok: async function () { try { var g = await this.init(), r = await g.isInstalled(); return !!(r.result && r.result.isInstalled) } catch (e) { return false } },
      connect: async function () {
        var g = await this.init(), r = await g.getAddress();
        if (r.type === "reject" || !r.result) throw new Error("Wallet connection cancelled"); return r.result.address;
      },
      restore: async function () { return null },
      disconnect: async function () {},
      sign: async function (tx, say) {
        var g = await this.init(); say("Confirm in GemWallet...");
        var r = await g.submitTransaction({ transaction: tx });
        if (r.type === "reject" || !r.result || !r.result.hash) throw new Error("Rejected in wallet");
        return { hash: r.result.hash, er: "" };
      }
    }
  };

  function showQr(png, link) {
    var o = document.createElement("div");
    o.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px";
    o.innerHTML = '<div style="background:#fff;color:#111;border-radius:16px;padding:20px;max-width:320px;width:100%;text-align:center;font:16px system-ui,sans-serif"><b style="font-size:19px">Scan with Xaman</b><img alt="Xaman sign request" width="240" height="240" style="display:block;margin:12px auto"><a target="_blank" rel="noopener" style="display:block;padding:10px;border-radius:10px;border:1px solid #ccc;background:#f4f4f4;color:#111;text-decoration:none">Open Xaman</a></div>';
    o.querySelector("img").src = png; o.querySelector("a").href = link;
    o.addEventListener("click", function (e) { if (e.target === o) o.remove() });
    document.body.appendChild(o); return o;
  }

  function picker() {
    return new Promise(function (ok, no) {
      var m = $("wm"), box = $("wmp");
      box.textContent = "";
      var h = document.createElement("h3"); h.textContent = "Connect XRPL wallet"; box.appendChild(h);
      Object.keys(W).forEach(function (n) {
        var b = document.createElement("button"); b.type = "button"; b.className = "wrow2";
        var i = document.createElement("span"); i.className = "wl"; i.textContent = n[0]; b.appendChild(i);
        var s = document.createElement("span"); s.textContent = n; b.appendChild(s);
        var u = document.createElement("small"); u.textContent = "Checking..."; b.appendChild(u);
        b.onclick = function () { m.hidden = true; ok(n) };
        W[n].ok().then(function (yes) {
          if (yes) { u.textContent = W[n].label ? W[n].label() : n === "Xaman" ? (ISM ? "Opens Xaman" : "Scan QR with phone") : "Detected"; return }
          u.textContent = "Install";
          b.onclick = function () { window.open(W[n].web, "_blank", "noopener") };
        });
        box.appendChild(b);
      });
      var c = document.createElement("button"); c.type = "button"; c.className = "chip"; c.textContent = "Cancel";
      c.onclick = function () { m.hidden = true; no(new Error("Wallet connection cancelled")) };
      box.appendChild(c); m.hidden = false;
    });
  }

  function setBtn() {
    var b = $("wcx"); if (b) b.textContent = account ? "XRPL: " + short(account) : "Connect XRPL wallet";
    try { window.dispatchEvent(new CustomEvent("cbl:xrpl", { detail: { account: account } })) } catch (e) {}
  }
  async function connect(force) {
    if (account && wallet && !force) return account;
    var n = await picker();
    account = await W[n].connect(); wallet = n;
    try { localStorage.setItem("cbl_w_XRPL", n) } catch (e) {}
    setBtn(); return account;
  }
  async function disconnect() {
    if (wallet) await W[wallet].disconnect();
    wallet = null; account = null; pend = null;
    try { localStorage.removeItem("cbl_w_XRPL") } catch (e) {}
    setBtn();
  }
  async function restore() {
    var n; try { n = localStorage.getItem("cbl_w_XRPL") } catch (e) {}
    if (!n || !W[n]) return;
    try { var a = await W[n].restore(); if (a) { account = a; wallet = n; setBtn() } } catch (e) {}
  }

  /** Sign + submit; fail fast on tem/tef/tel; wait for validation. */
  async function send(tx, say) {
    var prepared = tx;
    if (tx.TransactionType === "Batch") prepared = await (await getClient()).autofill(tx);
    var s = await W[wallet].sign(prepared, say);
    if (/^(tem|tef|tel)/.test(s.er || "")) return { code: s.er, hash: s.hash };
    say("Sent. Waiting for the ledger...");
    var v = await waitTx(s.hash);
    if (v.code === "tesSUCCESS" && tx.TransactionType === "Batch") {
      var inner = await innerResults(account, s.hash, v.ledger);
      if (inner.length < 2 || inner.some(function (c) { return c !== "tesSUCCESS" })) v.code = "tecBATCH";
    }
    return { code: v.code, hash: s.hash };
  }
  var batchOff = function () { try { return localStorage.getItem("cbl_xrpl_nobatch") === "1" } catch (e) { return false } };
  /* Is the Batch amendment live? Amendment id = SHA-512Half(name), listed in the Amendments ledger object. */
  var batchLive = null;
  async function batchEnabled() {
    if (batchLive !== null) return batchLive;
    try {
      var r = await req({ command: "ledger_entry", index: "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4", ledger_index: "validated" });
      var on = (r.node && r.node.Amendments) || [], ids = [];
      for (var n of ["BatchV1_1", "Batch"]) {
        var h = new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(n)));
        ids.push(Array.prototype.map.call(h.slice(0, 32), function (b) { return b.toString(16).padStart(2, "0") }).join("").toUpperCase());
      }
      batchLive = on.some(function (a) { return ids.indexOf(String(a).toUpperCase()) > -1 });
    } catch (e) { batchLive = false }
    return batchLive;
  }
  var batchUnsupported = function (code, msg) {
    return code === "temDISABLED" || code === "temINVALID_FLAG" || code === "temMALFORMED" ||
      /batch|unsupported|not supported|unknown transaction|invalid transaction type/i.test(msg || "");
  };

  async function makeQuote(tok, side, amt, slip) {
    var c = await cfg(), pool = await getPool(tok);
    if (!pool) throw new Error("No XRP pool for " + tok.label + " on the XRPL AMM yet.");
    if (pool.frozen) throw new Error(tok.label + " is frozen by its issuer.");
    var feeOn = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(c.xrplFee || "") && Number(c.xrplFeeBps) > 0;
    var q = quote(pool, side, Number(amt), slip, Number(c.xrplFeeBps) || 0, feeOn);
    q.feeAcct = feeOn ? c.xrplFee : null; q.feeBps = Number(c.xrplFeeBps) || 0;
    return q;
  }
  function desc(q, tok) {
    var get = q.side === "buy" ? tok.label : "XRP";
    return "You get about " + fmt(q.out) + " " + get + " (minimum " + fmt(q.min) + "). Route: XRPL AMM" +
      (q.fee > 0 ? " · includes " + (q.feeBps / 100) + "% CBL fee" : "") +
      (q.impact > 0.05 ? " · price impact " + (q.impact * 100).toFixed(1) + "%" : "");
  }

  async function execute(tok, q, say) {
    if (q.side === "buy") {
      var line = await lineOf(account, tok);
      if (!line || Number(line.limit) <= 0) {
        say("First time holding " + tok.label + ": approve it in your wallet (locks 0.2 XRP reserve)...");
        var t = await send({ TransactionType: "TrustSet", Account: account, LimitAmount: { currency: tok.currency, issuer: tok.issuer, value: "1000000000000000" }, Flags: tfSetNoRipple }, say);
        if (t.code !== "tesSUCCESS") throw new Error(why(t.code));
      }
    }
    var offer = buildOffer(account, tok, q), r;
    if (q.fee > 0 && !batchOff() && (await batchEnabled())) {
      say("Confirm the swap in your wallet...");
      try { r = await send(buildBatch(account, offer, buildFee(account, q.feeAcct, q.fee)), say) }
      catch (e) { if (!batchUnsupported(null, e && e.message)) throw e; r = { code: "temDISABLED" } }
      if (r.code === "tesSUCCESS") return r.hash;
      if (!batchUnsupported(r.code)) throw new Error(why(r.code));
      try { localStorage.setItem("cbl_xrpl_nobatch", "1") } catch (e) {}
      say("Your wallet can't do one-step swaps yet. Confirm the swap, then the fee...");
    } else say("Confirm the swap in your wallet...");
    r = await send(offer, say);
    if (r.code !== "tesSUCCESS") throw new Error(why(r.code));
    if (q.fee > 0) {
      say("Swap done. Confirm the CBL fee (" + fmt(q.fee) + " XRP)...");
      try { await send(buildFee(account, q.feeAcct, q.fee), say) } catch (e) {}
    }
    return r.hash;
  }

  /**
   * Called by the CBL Swap button for XRP Ledger tokens.
   * ctx: { p (token row, p.a = "CODE.rIssuer"), amt, side ("buy"|"sell"), slip (fraction), say(msg), btn, out (input el) }
   * First click quotes, second click executes (same flow as the other chains).
   */
  async function go(ctx) {
    var btn = ctx.btn, say = ctx.say;
    try {
      var tok = parseId(ctx.p.a);
      if (!tok) throw new Error("This token has no valid XRPL id (CODE.rIssuer).");
      if (pend) {
        var p0 = pend; pend = null; btn.disabled = true; say("Refreshing price...");
        var q1 = await makeQuote(p0.tok, p0.side, p0.amt, p0.slip);
        if (q1.out < p0.out * 0.99) {
          pend = { tok: p0.tok, side: p0.side, amt: p0.amt, slip: p0.slip, out: q1.out };
          ctx.out.value = fmt(q1.out); btn.disabled = false;
          say("Price moved. " + desc(q1, p0.tok) + ". Click again to confirm."); return;
        }
        var h = await execute(p0.tok, q1, say);
        btn.textContent = "Get quote"; btn.disabled = false;
        say("Done. " + (p0.side === "sell" ? "Sold" : "Bought") + " on XRPL: " + EXPLORER + h);
        return;
      }
      if (!(ctx.amt > 0)) throw new Error("Enter an amount");
      say("Connecting XRPL wallet..."); await connect();
      say("Getting price from the XRPL AMM...");
      var q = await makeQuote(tok, ctx.side, ctx.amt, ctx.slip);
      if (ctx.side === "buy" && q.amt > (await spendableXrp(account)) - 0.01) throw new Error("Not enough XRP (part of your balance is locked as reserve).");
      pend = { tok: tok, side: ctx.side, amt: ctx.amt, slip: ctx.slip, out: q.out };
      ctx.out.value = fmt(q.out);
      say(desc(q, tok) + ". Click again to confirm."); btn.textContent = "Confirm in wallet";
    } catch (e) {
      pend = null; btn.disabled = false; btn.textContent = "Get quote";
      var m = (e && (e.message || e)) || "Something went wrong";
      say(/Rejected|cancel/i.test(m) ? "Cancelled in your wallet." : String(m).slice(0, 180));
    }
  }

  /** Payment with a memo (used for THORChain bridge deposits). Returns the tx hash once validated. */
  async function payMemo(dest, xrp, memo, say) {
    if (!account) await connect();
    if (xrp > (await spendableXrp(account)) - 0.01) throw new Error("Not enough XRP (part of your balance is locked as reserve).");
    var hex = Array.prototype.map.call(new TextEncoder().encode(memo), function (b) { return b.toString(16).padStart(2, "0") }).join("").toUpperCase();
    var r = await send({ TransactionType: "Payment", Account: account, Destination: dest, Amount: drops(xrp), Memos: [{ Memo: { MemoData: hex } }] }, say);
    if (r.code !== "tesSUCCESS") throw new Error(why(r.code));
    return r.hash;
  }

  window.CBLXRPL = {
    payMemo: payMemo,
    go: go, connect: connect, disconnect: disconnect, restore: restore,
    reset: function () { pend = null },
    isId: isId, parseId: parseId, label: label,
    account: function () { return account },
    _test: { batchEnabled: batchEnabled, quote: quote, swapOut: swapOut, buildOffer: buildOffer, buildFee: buildFee, buildBatch: buildBatch, iou: iou, drops: drops, batchUnsupported: batchUnsupported }
  };
  setTimeout(restore, 700);
})();
