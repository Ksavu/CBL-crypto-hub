// Phanes-style developer stats.
//   solCreator(mint)          -> dev wallet of a Solana token (pump.fun bonding-curve account, else first transaction)
//   solOrigin(addr, deadline) -> { firstTs, funder, funderLabel } (wallet age + who funded it first)
//   evmOrigin(esCall, chain, addr) -> same for EVM
//   athFor(tokens, deadline)  -> fills t.ath (USD market cap) for bonded tokens; cached in radar_cache ("ath:<mint>")
const crypto = require("crypto");
const db = require("./db");
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function jfetch(u, opt, ms = 7000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(u, Object.assign({ signal: c.signal, headers: { accept: "application/json", "content-type": "application/json" } }, opt || {})); return { s: r.status, j: r.ok ? await r.json() : null }; }
  catch (e) { return { s: 0, j: null }; } finally { clearTimeout(t); }
}
const HEL = () => clean(process.env.HELIUS_API_KEY);
const rpcUrl = () => (HEL() ? "https://mainnet.helius-rpc.com/?api-key=" + HEL() : "https://api.mainnet-beta.solana.com");
async function rpc(method, params, ms) { const r = await jfetch(rpcUrl(), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, ms || 7000); return r.j ? r.j.result : undefined; }

// ---------- base58 + ed25519 on-curve check (for PDA derivation, no dependencies) ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58dec(s) {
  let n = 0n; for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") out.unshift(0); else break; }
  return Buffer.from(out);
}
function b58enc(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}
const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pw(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; }
const D = mod(-121665n * pw(121666n, P - 2n));
function onCurve(bytes) {
  const b = Buffer.from(bytes); b[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(b).reverse().toString("hex"));
  if (y >= P) return false;
  const y2 = y * y % P, u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  const v3 = v * v % P * v % P, v7 = v3 * v3 % P * v % P;
  const x = u * v3 % P * pw(u * v7 % P, (P - 5n) / 8n) % P;
  const vx2 = v * x % P * x % P;
  return vx2 === u || vx2 === mod(-u);
}
function pda(seeds, programId) {
  const prog = b58dec(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), prog, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!onCurve(h)) return b58enc(h);
  }
  return null;
}
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** Is this Solana address a token mint? */
async function isMint(addr) {
  const r = await rpc("getAccountInfo", [addr, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], 5000);
  return !!(r && r.value && TOKEN_PROGRAMS.has(r.value.owner));
}

/** Dev wallet of a Solana token. pump.fun stores the creator in the bonding-curve account; otherwise use the first transaction's fee payer. */
async function solCreator(mint, deadline, quick) {
  try {
    const bc = pda([Buffer.from("bonding-curve"), b58dec(mint)], PUMP);
    const r = bc && await rpc("getAccountInfo", [bc, { encoding: "base64" }], 5000);
    const data = r && r.value && Buffer.from(r.value.data[0], "base64");
    if (data && data.length >= 81) {
      const c = b58enc(data.subarray(49, 81));
      if (c && !/^1+$/.test(c)) return { creator: c, pump: true, complete: data[48] === 1 };
    }
  } catch (e) {}
  if (quick) return null;
  // Fallback: walk back to the first transaction (fine for young tokens; gives up on very busy ones).
  let before, oldest = null;
  for (let i = 0; i < 6 && (!deadline || Date.now() < deadline - 4000); i++) {
    const s = await rpc("getSignaturesForAddress", [mint, Object.assign({ limit: 1000 }, before ? { before } : {})], 8000);
    if (!Array.isArray(s) || !s.length) break;
    oldest = s[s.length - 1]; before = oldest.signature;
    if (s.length < 1000) {
      const tx = await rpc("getTransaction", [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: "json" }], 7000);
      const keys = tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
      return keys && keys[0] ? { creator: typeof keys[0] === "string" ? keys[0] : keys[0].pubkey, pump: false } : null;
    }
  }
  return null;
}

// ---------- who funded a wallet first ----------
const EXCH = {
  // Solana exchange hot wallets
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance", "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": "Binance",
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS": "Coinbase", "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE": "Coinbase", "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm": "Coinbase",
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX", "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2": "Bybit", "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5": "Kraken",
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ": "MEXC", "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w": "Gate", "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6": "KuCoin",
  "A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR": "Bitget",
  // EVM exchange hot wallets (lowercase)
  "0x28c6c06298d514db089934071355e5743bf21d60": "Binance", "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance", "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance",
  "0x8894e0a0c962cb723c1976a4421c95949be2d4e3": "Binance", "0xe2fc31f816a9b94326492132018c3aecc4a93ae1": "Binance", "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance",
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase", "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "Coinbase", "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase",
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX", "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit", "0xd6216fc19db775df9774a6e33526131da7d19a2c": "KuCoin",
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "Gate", "0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88": "MEXC", "0x5bdf85216ec1e38d6458c870992a69e38e03f7ef": "Bitget",
  "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": "Kraken",
};
const labelOf = (a) => (a ? EXCH[a] || EXCH[String(a).toLowerCase()] || null : null);

async function solOrigin(addr, deadline) {
  let before, oldest = null, full = false;
  for (let i = 0; i < 12 && (!deadline || Date.now() < deadline - 3000); i++) {
    const s = await rpc("getSignaturesForAddress", [addr, Object.assign({ limit: 1000 }, before ? { before } : {})], 8000);
    if (!Array.isArray(s) || !s.length) { full = !!oldest || Array.isArray(s); break; }
    oldest = s[s.length - 1]; before = oldest.signature;
    if (s.length < 1000) { full = true; break; }
  }
  if (!oldest) return null;
  const out = { firstTs: oldest.blockTime || null, complete: full, funder: null, funderLabel: null };
  if (full && HEL() && (!deadline || Date.now() < deadline - 2500)) {
    const r = await jfetch("https://api.helius.xyz/v0/transactions?api-key=" + HEL(), { method: "POST", body: JSON.stringify({ transactions: [oldest.signature] }) }, 6000);
    const t = Array.isArray(r.j) && r.j[0];
    const nt = t && (t.nativeTransfers || []).find((x) => x.toUserAccount === addr && x.fromUserAccount && x.fromUserAccount !== addr && x.amount > 0);
    if (nt) { out.funder = nt.fromUserAccount; out.funderLabel = labelOf(nt.fromUserAccount); }
  }
  return out;
}

async function evmOrigin(esCall, chain, addr) {
  const txs = await esCall(chain, `module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=5&sort=asc`);
  if (!Array.isArray(txs) || !txs.length) return null;
  const inc = txs.find((x) => String(x.to).toLowerCase() === addr && x.value !== "0") || txs[0];
  const f = String(inc.from || "").toLowerCase();
  return { firstTs: Number(txs[0].timeStamp) || null, complete: true, funder: f && f !== addr ? f : null, funderLabel: labelOf(f) };
}

// ---------- all-time-high market cap of bonded tokens (GeckoTerminal daily candles, cached) ----------
const GT_NET = { solana: "solana", bsc: "bsc", base: "base", ethereum: "eth", robinhood: "robinhood" };
async function athFor(list, deadline, maxNew = 10) {
  const want = list.filter((t) => t.pool && GT_NET[t.chain]);
  if (!want.length) return { checked: 0, total: 0 };
  const cache = {};
  if (db.on()) {
    for (let i = 0; i < want.length; i += 60) {
      const ids = want.slice(i, i + 60).map((t) => `"ath:${t.id}"`).join(",");
      const rows = await db.select("radar_cache", `id=in.(${encodeURIComponent(ids)})&select=id,data`).catch(() => []);
      (rows || []).forEach((r) => (cache[r.id.slice(4)] = r.data));
    }
  }
  const fresh = (c, t) => c && c.at && now() - c.at < ((t.ts && now() - t.ts > 30 * 86400) ? 7 * 86400 : 6 * 3600);
  const todo = [];
  for (const t of want) {
    const c = cache[t.id];
    if (c) t.ath = Math.max(c.ath || 0, t.mcap || 0) || null;
    if (!fresh(c, t)) todo.push(t);
  }
  // Biggest first: those decide "Top ATH" and "Hits".
  todo.sort((a, b) => (b.mcap || 0) + (b.vol || 0) - ((a.mcap || 0) + (a.vol || 0)));
  const save = [];
  let n = 0;
  for (const t of todo.slice(0, maxNew)) {
    if (deadline && Date.now() > deadline - 2500) break;
    let r = await jfetch(`https://api.geckoterminal.com/api/v2/networks/${GT_NET[t.chain]}/pools/${t.pool}/ohlcv/day?limit=1000&currency=usd&token=base`, null, 5000);
    if (r.s === 429) { await sleep(1500); r = await jfetch(`https://api.geckoterminal.com/api/v2/networks/${GT_NET[t.chain]}/pools/${t.pool}/ohlcv/day?limit=1000&currency=usd&token=base`, null, 5000); }
    const L = r.j && r.j.data && r.j.data.attributes && r.j.data.attributes.ohlcv_list;
    if (!Array.isArray(L)) { if (r.s === 429) break; continue; }
    const hi = Math.max(0, ...L.map((c) => Number(c[2]) || 0));
    const sup = t.price > 0 && t.mcap > 0 ? t.mcap / t.price : (t.chain === "solana" ? 1e9 : 0);
    const ath = hi && sup ? Math.max(hi * sup, t.mcap || 0) : (t.mcap || null);
    t.ath = ath; n++;
    save.push({ id: "ath:" + t.id, data: { ath, at: now() }, updated_at: new Date().toISOString() });
    await sleep(350);
  }
  if (save.length && db.on()) await db.upsert("radar_cache", save, "id").catch(() => {});
  return { checked: want.filter((t) => t.ath != null).length, total: want.length, fetched: n };
}

module.exports = { solCreator, isMint, solOrigin, evmOrigin, athFor, labelOf, pda, onCurve, b58dec, b58enc, PUMP };
