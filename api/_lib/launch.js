// 🚀 Launch a token on pump.fun from the CBL Bartender (Telegram + web app).
//   1. Image + name/ticker/description/links go to pump.fun's IPFS endpoint → metadata URI.
//   2. PumpPortal (pumpportal.fun, local-transaction API) builds the create (+ dev buy) transaction; with a bundle it also
//      builds buy transactions for the user's own wallets W2–W5, all sent as ONE Jito bundle (same block).
//   3. Every transaction is CHECKED before we sign it (only known programs; no token approvals; plain SOL transfers capped),
//      because we sign with the user's custodial keys.
//   Fees: LAUNCH_FEE_SOL (default 0.05 SOL) + BOT_FEE_BPS of all SOL spent on buys, from W1 after the launch lands.
//   Bundled launches are NOT hidden: the CBL scanner will show them as bundlers like any other.
const crypto = require("crypto");
const db = require("./db");
const V = require("./vault");
const T = require("./trade");
const B = require("./bundle");
const D = require("./devstats");
const X = T._;

const PP = () => X.clean(process.env.PUMPPORTAL_URL) || "https://pumpportal.fun/api/trade-local";
const launchFee = () => { const v = Number(X.clean(process.env.LAUNCH_FEE_SOL) || "0.05"); return Number.isFinite(v) && v >= 0 ? v : 0.05; };
const DRAFT = (uid) => "launch:" + uid;
const env = (k) => X.clean(process.env[k]);

// ---------- draft (kept in radar_cache) ----------
async function draft(uid) { try { return ((await db.select("radar_cache", `id=eq.${DRAFT(uid)}&select=data`))[0] || {}).data || {}; } catch (e) { return {}; } }
async function saveDraft(uid, d) { await db.upsert("radar_cache", [{ id: DRAFT(uid), data: d }], "id"); return d; }
async function patchDraft(uid, p) { return saveDraft(uid, Object.assign(await draft(uid), p)); }

/** Parse the details message: line 1 name, line 2 ticker, line 3+ description; links anywhere. */
function parseDetails(txt) {
  const lines = String(txt || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const links = { twitter: null, telegram: null, website: null }, rest = [];
  for (const l of lines) {
    const u = (l.match(/https?:\/\/\S+/) || [])[0];
    if (u && /(x|twitter)\.com\//i.test(u)) links.twitter = u; else if (u && /t\.me\//i.test(u)) links.telegram = u; else if (u) links.website = u; else rest.push(l);
  }
  const name = (rest[0] || "").replace(/^name:\s*/i, "").slice(0, 32), symbol = (rest[1] || "").replace(/^(ticker|symbol):\s*/i, "").replace(/^\$/, "").replace(/\s+/g, "").slice(0, 10).toUpperCase();
  const description = rest.slice(2).join("\n").replace(/^description:\s*/i, "").slice(0, 600);
  if (!name || !symbol) X.fail("Send at least 2 lines: the name, then the ticker.");
  return Object.assign({ name, symbol, description }, links);
}

// ---------- metadata ----------
async function tgFile(fileId) {
  const tok = env("TELEGRAM_BOT_TOKEN"), r = await X.jfetch(`https://api.telegram.org/bot${tok}/getFile?file_id=${encodeURIComponent(fileId)}`, {}, 8000);
  if (!r.ok || !r.d || !r.d.ok) X.fail("Couldn't download the image from Telegram. Send it again.");
  const f = await fetch(`https://api.telegram.org/file/bot${tok}/${r.d.result.file_path}`);
  if (!f.ok) X.fail("Couldn't download the image from Telegram. Send it again.");
  return { buf: Buffer.from(await f.arrayBuffer()), mime: /\.png$/i.test(r.d.result.file_path) ? "image/png" : "image/jpeg" };
}
async function tfetch(url, opt, ms) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 20000); try { return await fetch(url, Object.assign({}, opt, { signal: c.signal })); } finally { clearTimeout(t); } }

/** 1) pump.fun's own IPFS endpoint (often blocks server/datacenter requests). */
async function viaPump(d, img) {
  const fd = new FormData();
  fd.append("file", new Blob([img.buf], { type: img.mime }), img.mime === "image/png" ? "logo.png" : "logo.jpg");
  fd.append("name", d.name); fd.append("symbol", d.symbol); fd.append("description", d.description || "");
  if (d.twitter) fd.append("twitter", d.twitter); if (d.telegram) fd.append("telegram", d.telegram); if (d.website) fd.append("website", d.website);
  fd.append("showName", "true");
  const r = await tfetch("https://pump.fun/api/ipfs", { method: "POST", body: fd, headers: { origin: "https://pump.fun", referer: "https://pump.fun/create", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" } });
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j || !j.metadataUri) throw new Error("pump.fun ipfs " + r.status);
  return j.metadataUri;
}
/** 2) Pinata (free account, set PINATA_JWT): image → IPFS, then the same metadata JSON pump.fun would write. */
// Accepts the usual Vercel names: a JWT (PINATA_JWT …) or the older API key + secret pair.
function pinataAuth() {
  const jwt = env("PINATA_JWT") || env("PINATA_JWT_TOKEN") || env("PINATA_API_JWT") || env("NEXT_PUBLIC_PINATA_JWT");
  if (jwt) return { authorization: "Bearer " + jwt.replace(/^Bearer\s+/i, "") };
  const k = env("PINATA_API_KEY") || env("NEXT_PUBLIC_PINATA_API_KEY"), sec = env("PINATA_SECRET_API_KEY") || env("PINATA_API_SECRET") || env("PINATA_SECRET") || env("NEXT_PUBLIC_PINATA_SECRET_API_KEY");
  return k && sec ? { pinata_api_key: k, pinata_secret_api_key: sec } : null;
}
async function viaPinata(d, img) {
  const h = pinataAuth(); if (!h) throw new Error("no Pinata key");
  const fd = new FormData();
  fd.append("file", new Blob([img.buf], { type: img.mime }), img.mime === "image/png" ? "logo.png" : "logo.jpg");
  const a = await tfetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: h, body: fd });
  const ja = a.ok ? await a.json().catch(() => null) : null; if (!ja || !ja.IpfsHash) throw new Error("pinata image " + a.status);
  const meta = { name: d.name, symbol: d.symbol, description: d.description || "", image: "https://ipfs.io/ipfs/" + ja.IpfsHash, showName: true, createdOn: "https://pump.fun" };
  if (d.twitter) meta.twitter = d.twitter; if (d.telegram) meta.telegram = d.telegram; if (d.website) meta.website = d.website;
  const b = await tfetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", { method: "POST", headers: Object.assign({ "content-type": "application/json" }, h), body: JSON.stringify({ pinataContent: meta, pinataMetadata: { name: d.symbol + " metadata" } }) });
  const jb = b.ok ? await b.json().catch(() => null) : null; if (!jb || !jb.IpfsHash) throw new Error("pinata json " + b.status);
  return "https://ipfs.io/ipfs/" + jb.IpfsHash;
}
async function uploadMeta(d, img) {
  const errs = [];
  for (const f of [viaPump, viaPinata]) { try { return await f(d, img); } catch (e) { errs.push(e.message); } }
  console.error("launch metadata", errs.join(" | "));
  X.fail(pinataAuth() ? "Couldn't upload the image / metadata right now (" + errs.join(", ") + "). Try again in a minute."
    : "pump.fun blocks image uploads from our server. Admin: add a free Pinata key as PINATA_JWT in Vercel to fix this.");
}

// ---------- transaction safety check (we sign with custodial keys) ----------
const B58 = (b) => D.b58enc(b);
const ALLOWED = new Set([
  "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
/** Throws unless the transaction only calls known programs, approves no token spending, and its plain SOL transfers stay under `capLamports`. */
function check(raw, capLamports) {
  const b = Buffer.from(raw), [nSig, l] = V.cu16(b, 0); let o = l + 64 * nSig;
  const v0 = (b[o] & 0x80) !== 0; if (v0) o++;
  const nReq = b[o]; o += 3;
  const [nKeys, l2] = V.cu16(b, o); o += l2;
  const keys = []; for (let i = 0; i < nKeys; i++) keys.push(B58(b.subarray(o + 32 * i, o + 32 * i + 32))); o += 32 * nKeys + 32; // + blockhash
  const signers = new Set(keys.slice(0, nReq));
  const [nIx, l3] = V.cu16(b, o); o += l3; let sent = 0n;
  for (let i = 0; i < nIx; i++) {
    const pid = b[o++]; const [na, la] = V.cu16(b, o); o += la; const acc = [...b.subarray(o, o + na)]; o += na; const [nd, ld] = V.cu16(b, o); o += ld; const data = b.subarray(o, o + nd); o += nd;
    const prog = keys[pid]; if (!prog || !ALLOWED.has(prog)) throw new Error("Launch blocked: the transaction calls an unknown program (" + String(prog).slice(0, 8) + "…).");
    if (prog === "11111111111111111111111111111111" && data.length >= 12) {
      const kind = data.readUInt32LE(0);
      if (kind === 2) { const to = keys[acc[1]]; if (!to || !signers.has(to)) sent += data.readBigUInt64LE(4); } // transfer to someone else
      if (kind === 0 && data.length >= 12) sent += 0n; // create account: rent for new accounts we sign for
    }
    if ((prog.startsWith("Tokenkeg") || prog.startsWith("TokenzQ")) && (data[0] === 4 || data[0] === 13)) throw new Error("Launch blocked: the transaction tries to approve token spending.");
  }
  if (sent > BigInt(capLamports)) throw new Error("Launch blocked: the transaction sends more SOL to other addresses than expected.");
  return true;
}

// ---------- launch ----------
const lam = (sol) => X.toUnits(Number(sol).toFixed(9), 9);
const toB64 = (x) => Buffer.from(x).toString("base64");
function newMint() { const k = crypto.generateKeyPairSync("ed25519"); const seed = Buffer.from(k.privateKey.export({ format: "jwk" }).d, "base64url"); return { seed, pub: B58(V.solPubOf(seed)) }; }

/**
 * d = { name, symbol, description, twitter, telegram, website, image: {fileId} | {b64, mime}, dev (SOL), bundle: { on, each (SOL) } }
 * Returns { mint, sigs, bundled, wallets, fee }.
 */
async function launch(uid, d) {
  if (!d || !d.name || !d.symbol) X.fail("Add the name and ticker first.");
  if (!d.image) X.fail("Add an image first.");
  const st = T.settings(await T.getRow(uid)), { list } = await B.wallets(uid);
  const dev = Number(d.dev) || 0, each = d.bundle && d.bundle.on ? Number(d.bundle.each) || 0 : 0;
  const extra = each > 0 ? list.slice(1) : [];
  if (d.bundle && d.bundle.on && !extra.length) X.fail("Bundle needs extra wallets: add W2–W5 in 👛 Wallet first.");
  if (dev < 0 || dev > 50 || each < 0 || each > 20) X.fail("Dev buy max 50 SOL, bundle max 20 SOL per wallet.");
  const totalBuy = dev + each * extra.length, feeTo = X.feeTo("s"), fee = feeTo ? lam(launchFee()) + lam(totalBuy) * BigInt(T.feeBps()) / 10000n : 0n;
  const tip = extra.length ? Number(st.bundleTip || 0.001) : 0;
  // balances: W1 pays create (~0.02 SOL rent/fees), dev buy, CBL fee and the Jito tip
  const need1 = lam(dev + 0.03 + tip) + fee, bals = await Promise.all([list[0], ...extra].map((w) => X.solBal(w.pub)));
  if (bals[0] < need1) X.fail(`W1 needs about ${T.fromUnits(need1, 9)} SOL (dev buy + fees + rent). It has ${T.fromUnits(bals[0], 9)}.`);
  const short = extra.filter((w, i) => bals[i + 1] < lam(each + 0.005)).map((w) => "W" + w.idx);
  if (short.length) X.fail(`Not enough SOL in ${short.join(", ")} for ${each} SOL each (+ fees). Use 💸 Spread SOL in 👛 Wallet.`);

  if (!(await X.lock(uid))) X.fail("Another transaction is still running. Wait a few seconds.");
  try {
    const img = d.image.fileId ? await tgFile(d.image.fileId) : { buf: Buffer.from(String(d.image.b64 || ""), "base64"), mime: d.image.mime || "image/png" };
    if (!img.buf.length || img.buf.length > 4.5e6) X.fail("Image is empty or too big (max ~4 MB).");
    const uri = await uploadMeta(d, img), mint = newMint(), meta = { name: d.name, symbol: d.symbol, uri };
    const slip = Math.max(10, Number(st.slipBuy) || 10), cap = (sol) => lam(0.02 + sol * 0.02 + tip); // PumpPortal fee + tip
    let sigs;
    if (!extra.length) {
      const r = await fetch(PP(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey: list[0].pub, action: "create", tokenMetadata: meta, mint: mint.pub, denominatedInSol: "true", amount: dev, slippage: slip, priorityFee: 0.0005, pool: "pump" }) });
      if (!r.ok) X.fail("PumpPortal couldn't build the launch: " + (await r.text().catch(() => "")).slice(0, 120));
      const raw = Buffer.from(await r.arrayBuffer()); check(raw, cap(dev));
      const signed = V.solSignTx(V.solSignTx(toB64(raw), mint.seed), list[0].seed());
      const sig = await X.srpc("sendTransaction", [signed, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }]);
      for (let i = 0; i < 20; i++) { await new Promise((ok) => setTimeout(ok, 2000)); const s = await X.srpc("getSignatureStatuses", [[sig]]).catch(() => null), v = s && s.value && s.value[0]; if (v && v.err) X.fail("The launch failed on-chain. Nothing was created (only network fees)."); if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) break; if (i === 19) X.fail("The launch didn't confirm in time. Check your wallet on Solscan before retrying."); }
      sigs = [sig];
    } else {
      const body = [{ publicKey: list[0].pub, action: "create", tokenMetadata: meta, mint: mint.pub, denominatedInSol: "true", amount: dev, slippage: slip, priorityFee: tip, pool: "pump" },
        ...extra.map((w) => ({ publicKey: w.pub, action: "buy", mint: mint.pub, denominatedInSol: "true", amount: each, slippage: Math.max(slip, 30), priorityFee: 0.00005, pool: "pump" }))];
      const r = await fetch(PP(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const arr = r.ok ? await r.json().catch(() => null) : null;
      if (!Array.isArray(arr) || arr.length !== body.length) X.fail("PumpPortal couldn't build the bundle. Try again.");
      const signed = arr.map((s, i) => { const raw = D.b58dec(s); check(raw, cap(i === 0 ? dev : each)); let t = toB64(raw); if (i === 0) t = V.solSignTx(t, mint.seed); return V.solSignTx(t, (i === 0 ? list[0] : extra[i - 1]).seed()); });
      sigs = (await B.sendBundle(signed)).sigs;
    }
    if (fee > 0n) await B.solSendSeed(list[0].seed(), feeTo, fee).catch((e) => console.error("launch fee", e.message));
    // record buys so they show in 📊 Positions
    const buyers = [{ w: list[0], sol: dev, sig: sigs[0] }, ...extra.map((w, i) => ({ w, sol: each, sig: sigs[i + 1] }))].filter((x) => x.sol > 0);
    for (const x of buyers) { const t = (await X.solTokens(x.w.pub, mint.pub).catch(() => []))[0]; await X.record({ tg_id: uid, chain: "solana", token: mint.pub, side: "buy", native_raw: lam(x.sol).toString(), token_raw: t ? t.raw.toString() : "0", decimals: 6, tx: x.sig, fee_raw: "0", wallet: x.w.idx }); }
    await db.insert("bot_launches", [{ tg_id: uid, mint: mint.pub, name: d.name, symbol: d.symbol, dev_sol: dev, bundle_wallets: extra.length, bundle_each: each, tx: sigs[0] }]).catch(() => {});
    await saveDraft(uid, {}).catch(() => {});
    return { mint: mint.pub, sigs, bundled: extra.length, dev, each, fee };
  } finally { await X.unlock(uid); }
}

/** Fee preview for the confirm screen. */
function cost(d, nExtra) {
  const dev = Number(d.dev) || 0, each = d.bundle && d.bundle.on ? Number(d.bundle.each) || 0 : 0, n = each > 0 ? nExtra : 0, buys = dev + each * n;
  return { dev, each, n, buys, launchFee: launchFee(), tradeFee: buys * T.feeBps() / 10000, w1: dev + 0.03 + launchFee() + buys * T.feeBps() / 10000 + (n ? 0.001 : 0) };
}

module.exports = { draft, saveDraft, patchDraft, parseDetails, launch, cost, check, launchFee };
