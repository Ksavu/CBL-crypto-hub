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
/** Non-secret id of the Pinata key in use (to check Vercel has the new one). */
function pinataKeyId() { try { const h = pinataAuth(); if (!h) return "none"; if (h.pinata_api_key) return h.pinata_api_key.slice(0, 6); const p = JSON.parse(Buffer.from(h.authorization.split(".")[1], "base64url").toString()); return String(p.scopedKeyKey || "?").slice(0, 6); } catch (e) { return "unreadable"; } }
function pinataAuth() {
  const jwt = env("PINATA_JWT") || env("PINATA_JWT_TOKEN") || env("PINATA_API_JWT") || env("NEXT_PUBLIC_PINATA_JWT");
  if (jwt) return { authorization: "Bearer " + jwt.replace(/^Bearer\s+/i, "") };
  const k = env("PINATA_API_KEY") || env("NEXT_PUBLIC_PINATA_API_KEY"), sec = env("PINATA_SECRET_API_KEY") || env("PINATA_API_SECRET") || env("PINATA_SECRET") || env("NEXT_PUBLIC_PINATA_SECRET_API_KEY");
  return k && sec ? { pinata_api_key: k, pinata_secret_api_key: sec } : null;
}
/** Pin one file (Blob) to public IPFS. New Pinata keys only allow the v3 Files API; older/admin keys also allow the legacy pinning API. Returns the CID. */
async function pin(h, blob, name) {
  const errs = [];
  if (h.authorization) { // v3 Files API (JWT keys); network=public, otherwise files are private and pump.fun can't read them
    const fd = new FormData(); fd.append("file", blob, name); fd.append("network", "public"); fd.append("name", name);
    const r = await tfetch("https://uploads.pinata.cloud/v3/files", { method: "POST", headers: h, body: fd });
    const j = r.ok ? await r.json().catch(() => null) : null; if (j && j.data && j.data.cid) return j.data.cid;
    errs.push("v3 " + r.status + (r.ok ? "" : " " + (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 90))); // Pinata says why (scopes, plan, key)
  }
  const fd = new FormData(); fd.append("file", blob, name);
  const r = await tfetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: h, body: fd });
  const j = r.ok ? await r.json().catch(() => null) : null; if (j && j.IpfsHash) return j.IpfsHash;
  errs.push("legacy " + r.status + (r.ok ? "" : " " + (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 90)));
  throw new Error("pinata " + errs.join("/"));
}
/** 2) Pinata (free account, set PINATA_JWT): image → IPFS, then the same metadata JSON pump.fun would write. */
async function viaPinata(d, img) {
  const h = pinataAuth(); if (!h) throw new Error("no Pinata key");
  const imgCid = await pin(h, new Blob([img.buf], { type: img.mime }), (d.symbol || "logo") + (img.mime === "image/png" ? ".png" : ".jpg"));
  const meta = { name: d.name, symbol: d.symbol, description: d.description || "", image: "https://ipfs.io/ipfs/" + imgCid, showName: true, createdOn: "https://pump.fun" };
  if (d.twitter) meta.twitter = d.twitter; if (d.telegram) meta.telegram = d.telegram; if (d.website) meta.website = d.website;
  const metaCid = await pin(h, new Blob([JSON.stringify(meta)], { type: "application/json" }), (d.symbol || "token") + "-metadata.json");
  return "https://ipfs.io/ipfs/" + metaCid;
}
/** 3) Filebase (free 5 GB): IPFS RPC "add" with the bucket's IPFS RPC API key (FILEBASE_IPFS_KEY). */
async function fbAdd(blob, name) {
  const key = env("FILEBASE_IPFS_KEY") || env("FILEBASE_KEY"); if (!key) throw new Error("no FILEBASE_IPFS_KEY");
  const fd = new FormData(); fd.append("file", blob, name);
  const r = await tfetch("https://rpc.filebase.io/api/v0/add?cid-version=1&pin=true", { method: "POST", headers: { authorization: "Bearer " + key.replace(/^Bearer\s+/i, "") }, body: fd });
  const t = await r.text().catch(() => ""), j = (() => { try { return JSON.parse(t.trim().split("\n").pop()); } catch (e) { return null; } })();
  if (!r.ok || !j || !j.Hash) throw new Error("filebase " + r.status + " " + t.replace(/\s+/g, " ").slice(0, 80));
  return j.Hash;
}
async function viaFilebase(d, img) {
  const imgCid = await fbAdd(new Blob([img.buf], { type: img.mime }), (d.symbol || "logo") + (img.mime === "image/png" ? ".png" : ".jpg"));
  const meta = { name: d.name, symbol: d.symbol, description: d.description || "", image: "https://ipfs.io/ipfs/" + imgCid, showName: true, createdOn: "https://pump.fun" };
  if (d.twitter) meta.twitter = d.twitter; if (d.telegram) meta.telegram = d.telegram; if (d.website) meta.website = d.website;
  return "https://ipfs.io/ipfs/" + await fbAdd(new Blob([JSON.stringify(meta)], { type: "application/json" }), (d.symbol || "token") + "-metadata.json");
}
async function uploadMeta(d, img) {
  const errs = [];
  for (const f of [viaPump, viaFilebase, viaPinata]) { try { return await f(d, img); } catch (e) { errs.push(e.message); } }
  console.error("launch metadata", errs.join(" | "));
  X.fail(pinataAuth() || env("FILEBASE_IPFS_KEY") ? "Couldn't upload the image / metadata (" + errs.join(", ") + "). Pinata key in use: " + pinataKeyId() + "…"
    : "pump.fun blocks image uploads from our server. Admin: add a free Filebase IPFS key as FILEBASE_IPFS_KEY (or Pinata PINATA_JWT) in Vercel.");
}

// ---------- transaction safety check (we sign with custodial keys) ----------
const B58 = (b) => D.b58enc(b);
const ALLOWED = new Set([
  "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
/** Throws on token approvals or too much plain SOL sent away. Returns the programs we don't know (checked by simulation instead). */
function check(raw, capLamports) {
  const b = Buffer.from(raw), [nSig, l] = V.cu16(b, 0); let o = l + 64 * nSig;
  const v0 = (b[o] & 0x80) !== 0; if (v0) o++;
  const nReq = b[o]; o += 3;
  const [nKeys, l2] = V.cu16(b, o); o += l2;
  const keys = []; for (let i = 0; i < nKeys; i++) keys.push(B58(b.subarray(o + 32 * i, o + 32 * i + 32))); o += 32 * nKeys + 32; // + blockhash
  const signers = new Set(keys.slice(0, nReq));
  const [nIx, l3] = V.cu16(b, o); o += l3; let sent = 0n; const unknown = new Set();
  for (let i = 0; i < nIx; i++) {
    const pid = b[o++]; const [na, la] = V.cu16(b, o); o += la; const acc = [...b.subarray(o, o + na)]; o += na; const [nd, ld] = V.cu16(b, o); o += ld; const data = b.subarray(o, o + nd); o += nd;
    const prog = keys[pid]; if (!prog) throw new Error("Launch blocked: unreadable transaction.");
    if (!ALLOWED.has(prog)) unknown.add(prog);
    if (prog === "11111111111111111111111111111111" && data.length >= 12) {
      const kind = data.readUInt32LE(0);
      if (kind === 2) { const to = keys[acc[1]]; if (!to || !signers.has(to)) sent += data.readBigUInt64LE(4); } // transfer to someone else
      if (kind === 0 && data.length >= 12) sent += 0n; // create account: rent for new accounts we sign for
    }
    if ((prog.startsWith("Tokenkeg") || prog.startsWith("TokenzQ")) && (data[0] === 4 || data[0] === 13)) throw new Error("Launch blocked: the transaction tries to approve token spending.");
  }
  if (sent > BigInt(capLamports)) throw new Error("Launch blocked: the transaction sends more SOL to other addresses than expected.");
  return [...unknown];
}
/** Builders (PumpPortal) may route through their own program. Then we SIMULATE the transaction and allow it only if the
 *  wallet loses no more SOL than expected and the simulation succeeds. */
async function simulateSpend(b64, pub, maxLamports) {
  const [pre, sim] = await Promise.all([X.solBal(pub), X.srpc("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses: [pub] } }])]);
  const v = sim && sim.value; if (!v) throw new Error("Launch blocked: couldn't simulate the transaction.");
  if (v.err) throw new Error("Launch blocked: the transaction fails in simulation (" + JSON.stringify(v.err).slice(0, 80) + "). " + ((v.logs || []).slice(-2).join(" ").slice(0, 120)));
  const post = v.accounts && v.accounts[0] ? BigInt(v.accounts[0].lamports) : null;
  if (post == null) throw new Error("Launch blocked: simulation returned no balance.");
  const spent = pre - post; if (spent > BigInt(maxLamports)) throw new Error(`Launch blocked: it would spend ${T.fromUnits(spent, 9)} SOL, more than expected (${T.fromUnits(BigInt(maxLamports), 9)}).`);
  return spent;
}

// ---------- launch ----------
const lam = (sol) => X.toUnits(Number(sol).toFixed(9), 9);
const toB64 = (x) => Buffer.from(x).toString("base64");
function randomMint() { const k = crypto.generateKeyPairSync("ed25519"); const seed = Buffer.from(k.privateKey.export({ format: "jwk" }).d, "base64url"); return { seed, pub: B58(V.solPubOf(seed)) }; }
/** A pre-ground mint ending in "pump" (pool filled by scripts/grind.js via GitHub Actions); random mint if the pool is empty. */
async function newMint() {
  for (let i = 0; i < 3; i++) {
    const one = ((await db.select("bot_mint_pool", "select=id&order=id.asc&limit=1").catch(() => [])) || [])[0]; if (!one) break;
    const got = ((await db.take("bot_mint_pool", "id=eq." + one.id).catch(() => [])) || [])[0]; if (!got) continue; // someone else took it
    try { const seed = V.open(got.enc, "mint"); const pub = B58(V.solPubOf(seed)); if (pub === got.pub) return { seed, pub, vanity: true }; } catch (e) {}
  }
  return Object.assign(randomMint(), { vanity: false });
}
/** Store ground mints (from the cron endpoint). Checks each seed really gives its "…pump" address. */
async function addMints(keys) {
  const rows = [];
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 50)) {
    try { const seed = Buffer.from(String(k.seed || ""), "hex"); if (seed.length !== 32) continue; const pub = B58(V.solPubOf(seed)); if (pub !== k.pub || !/pump$/.test(pub)) continue; rows.push({ pub, enc: V.seal(seed, "mint") }); } catch (e) {}
  }
  if (rows.length) await db.insert("bot_mint_pool", rows);
  return rows.length;
}
async function poolCount() { const r = await db.select("bot_mint_pool", "select=id&limit=1000").catch(() => []); return (r || []).length; }

// pump.fun create_v2 has an is_mayhem_mode flag (Mayhem mode: pump.fun's AI agent trades the coin for 24h).
// The user chooses on/off; if the builder set it differently we flip the flag, and the simulation below confirms it still works.
const CREATE_V2 = crypto.createHash("sha256").update("global:create_v2").digest().subarray(0, 8);
function noMayhem(raw, want) {
  const b = Buffer.from(raw), [nSig, l] = V.cu16(b, 0); let o = l + 64 * nSig; if (b[o] & 0x80) o++;
  o += 3; const [nKeys, l2] = V.cu16(b, o); o += l2; const keys = []; for (let i = 0; i < nKeys; i++) keys.push(B58(b.subarray(o + 32 * i, o + 32 * i + 32))); o += 32 * nKeys + 32;
  const [nIx, l3] = V.cu16(b, o); o += l3; let flipped = false;
  for (let i = 0; i < nIx; i++) {
    const pid = b[o++]; const [na, la] = V.cu16(b, o); o += la + na; const [nd, ld] = V.cu16(b, o); o += ld; const ds = o; o += nd;
    if (keys[pid] !== "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" || nd < 8 || !b.subarray(ds, ds + 8).equals(CREATE_V2)) continue;
    let p = ds + 8; for (let s = 0; s < 3; s++) p += 4 + b.readUInt32LE(p); p += 32; // name, symbol, uri, creator
    const target = want ? 1 : 0; if (p < ds + nd && b[p] !== target) { b[p] = target; flipped = true; }
  }
  return { raw: b, flipped };
}

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
    const uri = await uploadMeta(d, img), mint = await newMint(), meta = { name: d.name, symbol: d.symbol, uri };
    const slip = Math.max(10, Number(st.slipBuy) || 10), cap = (sol) => lam(0.02 + sol * 0.02 + tip); // PumpPortal fee + tip
    let sigs;
    if (!extra.length) {
      const r = await fetch(PP(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey: list[0].pub, action: "create", tokenMetadata: meta, mint: mint.pub, denominatedInSol: "true", amount: dev, slippage: slip, priorityFee: 0.0005, pool: "pump", isMayhemMode: !!d.mayhem }) });
      if (!r.ok) X.fail("PumpPortal couldn't build the launch: " + (await r.text().catch(() => "")).slice(0, 120));
      const nm = noMayhem(Buffer.from(await r.arrayBuffer()), !!d.mayhem), raw = nm.raw, unk = check(raw, cap(dev));
      if (unk.length || nm.flipped) await simulateSpend(toB64(raw), list[0].pub, lam(dev * 1.02 + 0.05) + lam(dev * slip / 100));
      const signed = V.solSignTx(V.solSignTx(toB64(raw), mint.seed), list[0].seed());
      const sig = await X.srpc("sendTransaction", [signed, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }]);
      for (let i = 0; i < 20; i++) { await new Promise((ok) => setTimeout(ok, 2000)); const s = await X.srpc("getSignatureStatuses", [[sig]]).catch(() => null), v = s && s.value && s.value[0]; if (v && v.err) X.fail("The launch failed on-chain. Nothing was created (only network fees)."); if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) break; if (i === 19) X.fail("The launch didn't confirm in time. Check your wallet on Solscan before retrying."); }
      sigs = [sig];
    } else {
      const body = [{ publicKey: list[0].pub, action: "create", tokenMetadata: meta, mint: mint.pub, denominatedInSol: "true", amount: dev, slippage: slip, priorityFee: tip, pool: "pump", isMayhemMode: !!d.mayhem },
        ...extra.map((w) => ({ publicKey: w.pub, action: "buy", mint: mint.pub, denominatedInSol: "true", amount: each, slippage: Math.max(slip, 30), priorityFee: 0.00005, pool: "pump" }))];
      const r = await fetch(PP(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const arr = r.ok ? await r.json().catch(() => null) : null;
      if (!Array.isArray(arr) || arr.length !== body.length) X.fail("PumpPortal couldn't build the bundle. Try again.");
      const nm0 = noMayhem(D.b58dec(arr[0]), !!d.mayhem), raws = [nm0.raw, ...arr.slice(1).map((s) => D.b58dec(s))], unks = raws.map((raw, i) => check(raw, cap(i === 0 ? dev : each)));
      // the create tx can be simulated; the buys can't (the token doesn't exist yet), so they may only use programs the create tx used
      if (unks[0].length || nm0.flipped) await simulateSpend(toB64(raws[0]), list[0].pub, lam(dev * 1.02 + 0.05 + tip) + lam(dev * slip / 100));
      unks.slice(1).forEach((u) => { const bad = u.filter((p) => !unks[0].includes(p)); if (bad.length) throw new Error("Launch blocked: a bundle transaction calls an unknown program (" + bad[0] + ")."); });
      const signed = raws.map((raw, i) => { let t = toB64(raw); if (i === 0) t = V.solSignTx(t, mint.seed); return V.solSignTx(t, (i === 0 ? list[0] : extra[i - 1]).seed()); });
      sigs = (await B.sendBundle(signed)).sigs;
    }
    if (fee > 0n) await B.solSendSeed(list[0].seed(), feeTo, fee).catch((e) => console.error("launch fee", e.message));
    // record buys so they show in 📊 Positions
    const buyers = [{ w: list[0], sol: dev, sig: sigs[0] }, ...extra.map((w, i) => ({ w, sol: each, sig: sigs[i + 1] }))].filter((x) => x.sol > 0);
    for (const x of buyers) { const t = (await X.solTokens(x.w.pub, mint.pub).catch(() => []))[0]; await X.record({ tg_id: uid, chain: "solana", token: mint.pub, side: "buy", native_raw: lam(x.sol).toString(), token_raw: t ? t.raw.toString() : "0", decimals: 6, tx: x.sig, fee_raw: "0", wallet: x.w.idx }); }
    await db.insert("bot_launches", [{ tg_id: uid, mint: mint.pub, name: d.name, symbol: d.symbol, dev_sol: dev, bundle_wallets: extra.length, bundle_each: each, tx: sigs[0] }]).catch(() => {});
    await saveDraft(uid, {}).catch(() => {});
    return { mint: mint.pub, sigs, bundled: extra.length, dev, each, fee, vanity: mint.vanity, mayhem: !!d.mayhem };
  } finally { await X.unlock(uid); }
}

/** Fee preview for the confirm screen. */
function cost(d, nExtra) {
  const dev = Number(d.dev) || 0, each = d.bundle && d.bundle.on ? Number(d.bundle.each) || 0 : 0, n = each > 0 ? nExtra : 0, buys = dev + each * n;
  return { dev, each, n, buys, launchFee: launchFee(), tradeFee: buys * T.feeBps() / 10000, w1: dev + 0.03 + launchFee() + buys * T.feeBps() / 10000 + (n ? 0.001 : 0) };
}

module.exports = { addMints, poolCount, noMayhem, draft, saveDraft, patchDraft, parseDetails, launch, cost, check, launchFee };
