// Custodial trading wallets for the Telegram bot.
//   Keys are encrypted with AES-256-GCM using BOT_WALLET_KEY (64 hex chars, server env only) and bound to the Telegram user id.
//   Solana signing uses Node's built-in ed25519 (no SDK); EVM signing uses ethers (loaded only when needed).
const crypto = require("crypto");
const { b58dec, b58enc } = require("./devstats");

function master() {
  const k = String(process.env.BOT_WALLET_KEY || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error("Trading is not switched on yet (BOT_WALLET_KEY missing).");
  return Buffer.from(k, "hex");
}
const on = () => /^[0-9a-fA-F]{64}$/.test(String(process.env.BOT_WALLET_KEY || "").trim());

function seal(secret, uid) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", master(), iv);
  c.setAAD(Buffer.from("cbl:" + uid));
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return "v1." + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function open(blob, uid) {
  const b = Buffer.from(String(blob).replace(/^v1\./, ""), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", master(), b.subarray(0, 12));
  d.setAAD(Buffer.from("cbl:" + uid)); d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

// ---------- Solana ----------
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
function solNew() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url"), pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { seed, pub, address: b58enc(pub) };
}
const solKey = (seed) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
function solPubOf(seed) { return Buffer.from(crypto.createPublicKey(solKey(seed)).export({ format: "jwk" }).x, "base64url"); }
/** Phantom/Solflare "import private key" format: base58 of seed+pubkey (64 bytes). */
const solExport = (seed) => b58enc(Buffer.concat([seed, solPubOf(seed)]));

function cu16(buf, o) { let v = 0, s = 0, i = 0; for (;;) { const b = buf[o + i++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; } return [v, i]; }
function encCu16(n) { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); if (!n) break; } return Buffer.from(out); }

/** Sign a serialized (legacy or v0) transaction in our signer slot. Returns base64. */
function solSignTx(b64, seed) {
  const buf = Buffer.from(b64, "base64"), [nSig, l] = cu16(buf, 0), sigAt = l, msg = buf.subarray(l + 64 * nSig);
  let m = (msg[0] & 0x80) ? 1 : 0; const nReq = msg[m]; m += 3;
  const [nKeys, l2] = cu16(msg, m); m += l2;
  const pub = solPubOf(seed);
  let idx = -1;
  for (let i = 0; i < Math.min(nReq, nKeys); i++) if (msg.subarray(m + 32 * i, m + 32 * i + 32).equals(pub)) { idx = i; break; }
  if (idx < 0 || idx >= nSig) throw new Error("This transaction is not for this wallet");
  const sig = crypto.sign(null, msg, solKey(seed)), out = Buffer.from(buf);
  sig.copy(out, sigAt + 64 * idx);
  return out.toString("base64");
}
/** Legacy SOL transfer transaction, signed. */
function solTransferTx(seed, to, lamports, blockhash) {
  const from = solPubOf(seed), toK = b58dec(to), sys = Buffer.alloc(32), bh = b58dec(blockhash);
  if (toK.length !== 32 || bh.length !== 32) throw new Error("Bad address");
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4);
  const msg = Buffer.concat([Buffer.from([1, 0, 1]), encCu16(3), from, toK, sys, bh, encCu16(1), Buffer.from([2]), encCu16(2), Buffer.from([0, 1]), encCu16(data.length), data]);
  return Buffer.concat([encCu16(1), crypto.sign(null, msg, solKey(seed)), msg]).toString("base64");
}

// ---------- EVM ----------
let E = null;
const ethers = () => (E = E || require("ethers"));
function evmNew() { const w = ethers().Wallet.createRandom(); return { pk: w.privateKey, address: w.address.toLowerCase() }; }

/** New wallet pair for a Telegram user (encrypted for storage). */
function create(uid) {
  const s = solNew(), e = evmNew();
  return { tg_id: uid, sol_pub: s.address, sol_enc: seal(s.seed, uid), evm_addr: e.address, evm_enc: seal(Buffer.from(e.pk.slice(2), "hex"), uid) };
}
const solSeed = (row) => open(row.sol_enc, row.tg_id);
const evmPk = (row) => "0x" + open(row.evm_enc, row.tg_id).toString("hex");

module.exports = { on, seal, open, create, solSeed, evmPk, solExport, solSignTx, solTransferTx, solPubOf, ethers, cu16, encCu16 };
