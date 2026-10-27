/* CBL Swap — Terra Classic (columbus-5) module.
 * Swaps CW20 tokens against their LUNC or USTC pool (Terraswap / Terraport style pair contracts).
 * Wallets: Keplr, Leap, Galaxy Station (all expose the Keplr-style API).
 * Fee: TERRA_FEE_BPS of the trade, paid in LUNC/USTC to TERRA_FEE_ADDRESS inside the same transaction as the swap
 * (one signature, all-or-nothing). Quotes come from /api/terra; signing uses CosmJS against a public RPC.
 * Also signs Skip Go bridge transactions that start on Terra Classic (signSkip).
 */
(function () {
  "use strict";
  var CHAIN = "columbus-5";
  var RPCS = ["https://terra-classic-rpc.publicnode.com:443", "https://terra-mainnet-rpc.allthatnode.com:26657"];
  var REST = "https://terra-classic-lcd.publicnode.com";
  var COSMJS = "https://esm.sh/@cosmjs/cosmwasm-stargate@0.32.4";
  var EXPLORER = "https://finder.terra-classic.hexxagon.io/mainnet/tx/";
  var ID_RE = /^terra1[02-9ac-hj-np-z]{58}$/;
  var CHAIN_INFO = {
    chainId: CHAIN, chainName: "Terra Classic", rpc: RPCS[0], rest: REST,
    bip44: { coinType: 330 },
    bech32Config: { bech32PrefixAccAddr: "terra", bech32PrefixAccPub: "terrapub", bech32PrefixValAddr: "terravaloper", bech32PrefixValPub: "terravaloperpub", bech32PrefixConsAddr: "terravalcons", bech32PrefixConsPub: "terravalconspub" },
    currencies: [{ coinDenom: "LUNC", coinMinimalDenom: "uluna", coinDecimals: 6 }, { coinDenom: "USTC", coinMinimalDenom: "uusd", coinDecimals: 6 }],
    feeCurrencies: [{ coinDenom: "LUNC", coinMinimalDenom: "uluna", coinDecimals: 6, gasPriceStep: { low: 28.325, average: 28.325, high: 50 } }],
    stakeCurrency: { coinDenom: "LUNC", coinMinimalDenom: "uluna", coinDecimals: 6 },
    features: ["cosmwasm"]
  };
  var $ = function (i) { return document.getElementById(i) };
  var wallet = null, account = null, pend = null, libP = null, clientP = null, clientFor = null;

  /* ---------- wallets (all Keplr-compatible) ---------- */
  function galaxy() { var g = window.galaxyStation || window.station; return g && (g.keplr || (g.enable && g.getOfflineSignerAuto ? g : null)) || null }
  var W = {
    "Keplr": { api: function () { return window.keplr || null }, web: "https://www.keplr.app/get" },
    "Galaxy Station": { api: galaxy, web: "https://chromewebstore.google.com/detail/akckefnapafjbpphkefbpkpcamkoaoai" },
    "Leap": { api: function () { return window.leap || null }, web: "https://www.leapwallet.io/download" }
  };
  function api() { var a = wallet && W[wallet] && W[wallet].api(); if (!a) throw new Error("Terra wallet not found. Unlock it and try again."); return a }
  function sl(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function short(a) { return a.slice(0, 8) + "..." + a.slice(-4) }

  async function enable(a, chainId) {
    try { await a.enable(chainId) }
    catch (e) {
      if (chainId !== CHAIN || !a.experimentalSuggestChain || /reject|denied|cancel/i.test(String(e && e.message))) throw e;
      await a.experimentalSuggestChain(CHAIN_INFO); await a.enable(chainId);
    }
    try { a.defaultOptions = { sign: { preferNoSetFee: true, preferNoSetMemo: true } } } catch (e) {} // keep our fee: it includes the Terra Classic burn tax
  }
  async function connectWith(n) {
    if (!W[n]) throw new Error("Unknown Terra wallet");
    var a = W[n].api();
    if (!a) { window.open(W[n].web, "_blank", "noopener"); throw new Error(n + " is not installed. On a phone, open this page inside the wallet's browser.") }
    await enable(a, CHAIN);
    var k = await a.getKey(CHAIN);
    wallet = n; account = k.bech32Address; clientP = null;
    try { localStorage.setItem("cbl_w_Terra", n) } catch (e) {}
    setBtn(); return account;
  }
  function picker() {
    return new Promise(function (ok, no) {
      var m = $("wm"), box = $("wmp"); box.textContent = "";
      var h = document.createElement("h3"); h.textContent = "Connect Terra Classic wallet"; box.appendChild(h);
      items().forEach(function (it) {
        var b = document.createElement("button"); b.type = "button"; b.className = "wrow2";
        var src = typeof window.wic === "function" ? window.wic(it.n) : null, i;
        if (src) { i = document.createElement("img"); i.src = src; i.alt = "" } else { i = document.createElement("span"); i.className = "wl"; i.textContent = it.n[0] }
        b.appendChild(i); var s = document.createElement("span"); s.textContent = it.n; b.appendChild(s);
        var u = document.createElement("small"); b.appendChild(u);
        it.check().then(function (lab) {
          u.textContent = lab || "Install";
          b.onclick = lab ? function () { m.hidden = true; ok(it.n) } : function () { window.open(it.web, "_blank", "noopener") };
        });
        box.appendChild(b);
      });
      var c = document.createElement("button"); c.type = "button"; c.className = "chip"; c.textContent = "Cancel";
      c.onclick = function () { m.hidden = true; no(new Error("Wallet connection cancelled")) };
      box.appendChild(c); m.hidden = false;
    });
  }
  /** Wallet list for the site-wide Connect Wallet picker. check() resolves to a status label, or null when not installed. */
  function items() {
    return Object.keys(W).map(function (n) {
      return { n: n, web: W[n].web, check: async function () { for (var i = 0; i < 4; i++) { if (W[n].api()) return "Detected"; await sl(250) } return null } };
    });
  }
  async function connect(force) { if (account && wallet && !force) return account; return connectWith(await picker()) }
  async function disconnect() {
    try { var a = wallet && W[wallet].api(); if (a && a.disable) await a.disable(CHAIN) } catch (e) {}
    wallet = null; account = null; pend = null; clientP = null;
    try { localStorage.removeItem("cbl_w_Terra") } catch (e) {}
    setBtn();
  }
  async function restore() {
    var n; try { n = localStorage.getItem("cbl_w_Terra") } catch (e) {}
    if (!n || !W[n]) return;
    for (var i = 0; i < 8 && !W[n].api(); i++) await sl(250);
    var a = W[n].api(); if (!a) return;
    try { await a.enable(CHAIN); var k = await a.getKey(CHAIN); wallet = n; account = k.bech32Address; setBtn() } catch (e) {}
  }
  function setBtn() {
    var b = $("wct"); if (b) b.textContent = account ? "Terra: " + short(account) : "Connect Terra wallet";
    try { window.dispatchEvent(new CustomEvent("cbl:terra", { detail: { account: account } })) } catch (e) {}
  }
  /** Address of this wallet on another Cosmos chain (used for Skip Go routes through Osmosis, Noble, ...). */
  async function addressOn(chainId) {
    if (chainId === CHAIN) return account;
    var a = api(); await enable(a, chainId); return (await a.getKey(chainId)).bech32Address;
  }

  /* ---------- signing ---------- */
  function lib() { return libP || (libP = import(COSMJS).catch(function (e) { libP = null; throw new Error("Could not load the Terra library. Check your connection.") })) }
  async function client() {
    if (clientP && clientFor === account) return clientP;
    clientFor = account;
    clientP = (async function () {
      var L = await lib(), a = api(), signer = a.getOfflineSignerAuto ? await a.getOfflineSignerAuto(CHAIN) : a.getOfflineSigner(CHAIN), last;
      for (var i = 0; i < RPCS.length; i++) {
        try { return await L.SigningCosmWasmClient.connectWithSigner(RPCS[i], signer) } catch (e) { last = e }
      }
      throw new Error("Could not reach a Terra Classic node. Try again." + (last ? "" : ""));
    })();
    clientP.catch(function () { clientP = null });
    return clientP;
  }
  var enc = function (o) { return new TextEncoder().encode(JSON.stringify(o)) };
  function execMsg(contract, msg, funds) {
    return { typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract", value: { sender: account, contract: contract, msg: enc(msg), funds: funds || [] } };
  }
  function bankMsg(to, denom, amount) {
    return { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: account, toAddress: to, amount: [{ denom: denom, amount: String(amount) }] } };
  }
  /**
   * Simulate, add the fee (gas x price, plus the burn tax on native coins sent), sign and broadcast.
   * native: [{denom, amount}] of LUNC/USTC leaving the wallet, for the tax. Returns the tx hash.
   */
  async function sendMsgs(msgs, native, gasPrice, taxRate, say) {
    var c = await client(), gas;
    say("Checking the transaction...");
    try { gas = await c.simulate(account, msgs, "") }
    catch (e) { throw new Error(simErr(e)) }
    gas = Math.ceil(gas * 1.5) + 20000;
    var fee = { uluna: BigInt(Math.ceil(gas * (gasPrice || 28.325))) };
    (native || []).forEach(function (x) {
      var t = BigInt(Math.ceil(Number(x.amount) * (taxRate || 0)));
      if (t > 0n) fee[x.denom] = (fee[x.denom] || 0n) + t;
    });
    var amount = Object.keys(fee).map(function (d) { return { denom: d, amount: fee[d].toString() } });
    say("Confirm in your wallet...");
    var r = await c.signAndBroadcast(account, msgs, { amount: amount, gas: String(gas) }, "");
    if (r.code) throw new Error(txErr(r.rawLog || ("code " + r.code)));
    return r.transactionHash;
  }
  function simErr(e) {
    var m = String((e && e.message) || e);
    if (/insufficient funds|smaller than/i.test(m)) return "Not enough balance (remember the network fee and burn tax are paid in LUNC).";
    if (/max spread|spread assertion|slippage/i.test(m)) return "Price moved more than your slippage. Raise slippage or try a smaller amount.";
    if (/account .* not found|does not exist on chain/i.test(m)) return "This wallet has no LUNC yet. Send some LUNC to it first to pay network fees.";
    return m.replace(/^.*?(rpc error|failed to execute message; )/i, "").slice(0, 170);
  }
  function txErr(m) { return simErr({ message: m }) }

  /* ---------- swap ---------- */
  async function getQuote(tok, side, amt, pay, slip) {
    var u = "/api/terra?op=quote&token=" + encodeURIComponent(tok) + "&side=" + side + "&amt=" + encodeURIComponent(String(amt)) + "&pay=" + encodeURIComponent(pay || "LUNC") + "&slip=" + (slip * 100);
    var r = await fetch(u), d = await r.json().catch(function () { return {} });
    if (!r.ok || !d.ok) throw new Error(d.error || "Could not get a price. Try again.");
    return d;
  }
  function buildSwap(q) {
    var msgs = [], native = [];
    if (q.side === "buy") {
      if (q.feeAddr && BigInt(q.feeRaw) > 0n) { msgs.push(bankMsg(q.feeAddr, q.denom, q.feeRaw)); native.push({ denom: q.denom, amount: q.feeRaw }) }
      msgs.push(execMsg(q.pair, { swap: { offer_asset: { info: { native_token: { denom: q.denom } }, amount: q.swapRaw }, belief_price: q.beliefPrice, max_spread: q.maxSpread } }, [{ denom: q.denom, amount: q.swapRaw }]));
      native.push({ denom: q.denom, amount: q.swapRaw });
    } else {
      var inner = btoa(JSON.stringify({ swap: { belief_price: q.beliefPrice, max_spread: q.maxSpread } }));
      msgs.push(execMsg(q.token, { send: { contract: q.pair, amount: q.swapRaw, msg: inner } }));
      // Fee comes out of the LUNC/USTC the swap just paid out (based on the minimum, so it can never exceed what arrived).
      if (q.feeAddr && BigInt(q.feeRaw) > 0n) { msgs.push(bankMsg(q.feeAddr, q.denom, q.feeRaw)); native.push({ denom: q.denom, amount: q.feeRaw }) }
    }
    return { msgs: msgs, native: native };
  }
  function desc(q) {
    var get = q.side === "buy" ? q.symbol : q.paySym;
    return "You get about " + q.out + " " + get + " (minimum " + q.min + "). Route: Terra Classic pool vs " + q.paySym +
      (q.feeBps ? " · includes " + (q.feeBps / 100) + "% CBL fee" : "") +
      (q.impact > 0.05 ? " · price impact " + (q.impact * 100).toFixed(1) + "%" : "") + " · network fee + burn tax paid in LUNC";
  }
  /**
   * Called by the CBL Swap button for Terra Classic tokens.
   * ctx: { p (token row, p.a = terra1 contract), amt, side, pay ("LUNC"|"USTC"), slip (fraction), say, btn, out }
   */
  async function go(ctx) {
    var btn = ctx.btn, say = ctx.say;
    try {
      if (pend) {
        var p0 = pend; pend = null; btn.disabled = true; say("Refreshing price...");
        var q1 = await getQuote(p0.tok, p0.side, p0.amt, p0.pay, p0.slip);
        if (Number(q1.out) < p0.out * 0.99) {
          pend = { tok: p0.tok, side: p0.side, amt: p0.amt, pay: p0.pay, slip: p0.slip, out: Number(q1.out) };
          ctx.out.value = q1.out; btn.disabled = false; say("Price moved. " + desc(q1) + ". Click again to confirm."); return;
        }
        var s = buildSwap(q1), h = await sendMsgs(s.msgs, s.native, q1.gasPrice, q1.taxRate, say);
        btn.textContent = "Get quote"; btn.disabled = false;
        say("Done. " + (p0.side === "sell" ? "Sold" : "Bought") + " on Terra Classic: " + EXPLORER + h); return;
      }
      if (!ID_RE.test(String(ctx.p.a || ""))) throw new Error("This token has no valid Terra Classic contract address.");
      if (!(ctx.amt > 0)) throw new Error("Enter an amount");
      say("Connecting Terra wallet..."); await connect();
      say("Getting price from the pool...");
      var q = await getQuote(ctx.p.a, ctx.side, ctx.amt, ctx.pay, ctx.slip);
      pend = { tok: ctx.p.a, side: ctx.side, amt: ctx.amt, pay: ctx.pay, slip: ctx.slip, out: Number(q.out) };
      ctx.out.value = q.out; say(desc(q) + ". Click again to confirm."); btn.textContent = "Confirm in wallet";
      lib().catch(function () {}); // warm up while the user reads the quote
    } catch (e) {
      pend = null; btn.disabled = false; btn.textContent = "Get quote";
      var m = (e && (e.message || e)) || "Something went wrong";
      say(/reject|denied|cancel/i.test(m) ? "Cancelled in your wallet." : String(m).slice(0, 180));
    }
  }

  /* ---------- Skip Go: sign a cosmos_tx that starts on Terra Classic ---------- */
  var camel = function (k) { return k.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase() }) };
  function camelAll(o) {
    if (Array.isArray(o)) return o.map(camelAll);
    if (!o || typeof o !== "object") return o;
    var r = {}; Object.keys(o).forEach(function (k) { r[camel(k)] = camelAll(o[k]) }); return r;
  }
  function skipMsg(m) {
    var v = JSON.parse(m.msg), t = m.msg_type_url;
    if (t === "/ibc.applications.transfer.v1.MsgTransfer") {
      var x = camelAll(v); x.memo = v.memo || "";
      if (x.timeoutHeight) x.timeoutHeight = { revisionNumber: BigInt(x.timeoutHeight.revisionNumber || 0), revisionHeight: BigInt(x.timeoutHeight.revisionHeight || 0) };
      x.timeoutTimestamp = BigInt(v.timeout_timestamp || 0);
      return { typeUrl: t, value: x };
    }
    if (t === "/cosmwasm.wasm.v1.MsgExecuteContract") {
      return { typeUrl: t, value: { sender: v.sender, contract: v.contract, msg: enc(typeof v.msg === "string" ? JSON.parse(v.msg) : v.msg), funds: v.funds || [] } };
    }
    if (t === "/cosmos.bank.v1beta1.MsgSend") return { typeUrl: t, value: { fromAddress: v.from_address, toAddress: v.to_address, amount: v.amount } };
    throw new Error("This bridge route needs a transaction type the Terra wallet flow does not support yet.");
  }
  async function signSkip(tx, say) {
    if (!account) await connect();
    if (tx.chain_id !== CHAIN) throw new Error("This route starts on " + tx.chain_id + ", which isn't supported here.");
    if (tx.signer_address && tx.signer_address !== account) throw new Error("Route was built for another Terra address. Get a new quote.");
    var msgs = tx.msgs.map(skipMsg), native = [];
    msgs.forEach(function (m) {
      var coins = m.value.token ? [m.value.token] : m.value.funds || m.value.amount || [];
      coins.forEach(function (c) { if (c.denom === "uluna" || c.denom === "uusd") native.push(c) });
    });
    var cfg = await fetch("/api/terra?op=cfg").then(function (r) { return r.json() }).catch(function () { return {} });
    return sendMsgs(msgs, native, cfg.gasPrice, cfg.taxRate, say);
  }

  window.CBLTERRA = {
    go: go, connect: connect, connectWith: connectWith, items: items, disconnect: disconnect, restore: restore,
    reset: function () { pend = null }, isId: function (s) { return ID_RE.test(String(s || "").trim()) },
    account: function () { return account }, addressOn: addressOn, signSkip: signSkip, CHAIN: CHAIN, EXPLORER: EXPLORER,
    _test: { buildSwap: buildSwap, skipMsg: skipMsg, desc: desc, set: function (a) { account = a } }
  };
  setTimeout(restore, 800);
})();
