// Launchpad origin of a token, shared by the scanner, the Token Radar and the bot.
//   launchpadOf(chain, ca, dexIds, labels) — from DEX ids + vanity address endings (pump, bonk, LoL, 4444, b07...)
//   launchpadByCreator(chain, creator)     — the token contract was deployed by a known launchpad contract
// Launchpad origin (best effort): DEX ids where the token trades + vanity address endings launchpads use.
// Returns { n: name, k: short key, g: graduated (true/false, null = unknown) } or null.
const LP_DEX = { pumpfun: ["Pump.fun", "pump"], pumpswap: ["Pump.fun", "pump"], moonshot: ["Moonshot", "moon"], fourmeme: ["Four.meme", "four"], four_meme: ["Four.meme", "four"],
  virtuals: ["Virtuals", "virt"], zora: ["Zora", "zora"], apestore: ["Ape.store", "ape"], flaunch: ["Flaunch", "flaunch"], boop: ["Boop", "boop"], heaven: ["Heaven", "heaven"],
  believe: ["Believe", "believe"], meteoradbc: ["Meteora DBC", "dbc"], launchlab: ["LaunchLab", "launchlab"], bonkfun: ["LetsBonk", "bonk"], letsbonk: ["LetsBonk", "bonk"] };
function launchpadOf(chain, ca, dexes, labels) {
  const a = String(ca), d = dexes.map((x) => String(x || "").toLowerCase()), lb = labels.map((x) => String(x || "").toLowerCase());
  const curve = (ids) => d.some((x) => ids.includes(x)), grad = (ids) => d.some((x) => !ids.includes(x)); // trades elsewhere = graduated
  if (chain === "solana") {
    if (/LoL$/.test(a)) return { n: "launched.lol", k: "lol", g: null };
    if (/high$/.test(a)) return { n: "higher.fun", k: "higher", g: null }; // higher.fun vanity ending
    if (/pump$/.test(a) || curve(["pumpfun", "pumpswap"])) return { n: "Pump.fun", k: "pump", g: !d.includes("pumpfun") || grad(["pumpfun"]) };
    if (/bonk$/.test(a) || curve(["bonkfun", "letsbonk"])) return { n: "LetsBonk", k: "bonk", g: grad(["raydium", "bonkfun", "letsbonk"]) || null };
    if (curve(["moonshot"])) return { n: "Moonshot", k: "moon", g: grad(["moonshot"]) };
    if (curve(["meteoradbc"])) return { n: "Meteora DBC", k: "dbc", g: grad(["meteoradbc"]) || null };
    if (lb.includes("launchlab")) return { n: "LaunchLab", k: "launchlab", g: null };
    if (lb.includes("dbc")) return { n: "Meteora DBC", k: "dbc", g: null };
  }
  if (chain === "robinhood") { // no vanity suffix there: DEX ids here, on-chain launchpad check in robinhoodPads()
    const hit = (re) => d.some((x) => re.test(x));
    if (hit(/pons/)) return { n: "Pons", k: "pons", g: grad(d.filter((x) => /pons/.test(x))) };
    if (hit(/hood/)) return { n: "Hood.fun", k: "hood", g: grad(d.filter((x) => /hood/.test(x))) };
    if (hit(/robin/)) return { n: "RobinFun", k: "robin", g: grad(d.filter((x) => /robin/.test(x))) };
    for (const [re, n, k] of [[/klik/, "Klik", "klik"], [/printr/, "Printr", "printr"], [/dyor/, "DYOR.fun", "dyor"], [/realfun/, "RealFun", "realfun"], [/apestore/, "Ape.store", "ape"]]) if (hit(re)) return { n, k, g: null };
  }
  if (chain === "bsc" && (/4444$/i.test(a) || curve(["fourmeme", "four_meme"]))) return { n: "Four.meme", k: "four", g: grad(["fourmeme", "four_meme"]) };
  if (chain === "base") {
    if (/b07$/i.test(a)) return { n: "Clanker", k: "clanker", g: null };
    for (const x of ["virtuals", "zora", "apestore", "flaunch"]) if (d.includes(x)) return { n: LP_DEX[x][0], k: LP_DEX[x][1], g: grad([x]) };
  }
  for (const x of d) if (LP_DEX[x]) return { n: LP_DEX[x][0], k: LP_DEX[x][1], g: null };
  return null;
}

// Contracts that deploy launchpad tokens (Blockscout "creator" of the token contract).
const BY_CREATOR = {
  bsc: { "0x5c952063c7fc8610ffdb798152d69f0b9550762b": "Four.meme" }, // four.meme TokenManager2
  robinhood: {
    "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e": "Pons", "0x3711cea4feade896c913c68f01eda97cb06d1a42": "Pons", "0xe33e9e479df8802cb0866d5d05258bec4cf62948": "Pons",
    "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": "Pons",
    "0x5fcc1df0dc020cf454e742e9a8ae2554c37a452c": "Hood.fun", "0xc6a2941b962fb667786d7f4b97f7f965d6f0a4f8": "Hood.fun",
    "0xd861cb5dc71a0171e8f0f6586cadb069f3a35e4d": "RobinFun",
  },
};
const PAD_INFO = {
  Pons: "Robinhood Chain launchpad: tokens trade on their own bonding curve until 4.2 ETH, then move to a locked Uniswap v4 pool.",
  "Hood.fun": "Robinhood Chain fair-launch platform: bonding curve first, then a Uniswap v3-style pool after graduation.",
  RobinFun: "Robinhood Chain launchpad with a bonding curve that graduates to an AMM pool.",
  "Pump.fun": "Solana launchpad: bonding curve first, then PumpSwap once the curve completes.",
  LetsBonk: "Solana launchpad (Raydium LaunchLab): bonding curve first, then a Raydium pool.",
  Moonshot: "Solana launchpad: bonding curve first, then a DEX pool after migration.",
  "Four.meme": "BNB Chain launchpad: bonding curve first, then a PancakeSwap pool.",
  Clanker: "Base token launcher: deploys the token straight into a Uniswap pool with locked liquidity.",
  "launched.lol": "Solana bonding-curve launchpad by CBL's team.",
  "higher.fun": "Solana launchpad on Raydium LaunchLab: bonding curve first, then a Raydium pool (liquidity burned or locked).",
  LaunchLab: "Raydium LaunchLab bonding curve: graduates to a Raydium pool.",
};
const launchpadByCreator = (chain, creator) => (creator && BY_CREATOR[chain] && BY_CREATOR[chain][String(creator).toLowerCase()]) || null;

// Where a token still on a launchpad curve can be bought (token page on the launchpad).
const PAD_URL = { "Pump.fun": (ca) => "https://pump.fun/coin/" + ca, "Four.meme": (ca) => "https://four.meme/token/" + ca, Pons: (ca) => "https://ponsfamily.com/launchpad/" + ca };
const padUrl = (name, ca) => (PAD_URL[name] ? PAD_URL[name](ca) : null);

// ---------- higher.fun (Solana, runs on Raydium LaunchLab) ----------
// A LaunchLab token is higher.fun's when its LaunchLab pool was created through higher.fun's platform config
// (HIGHER_PLATFORM_ID env, comma separated; find it with /api/scan?padinfo=<higher.fun token>) or its metadata points to higher.fun.
const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", WSOL = "So11111111111111111111111111111111111111112";
const helius = () => String(process.env.HELIUS_API_KEY || "").trim();
async function srpc(method, params) {
  const url = helius() ? "https://mainnet.helius-rpc.com/?api-key=" + helius() : "https://api.mainnet-beta.solana.com";
  const c = new AbortController(), t = setTimeout(() => c.abort(), 8000);
  try { const r = await fetch(url, { method: "POST", signal: c.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); return j.result; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
/** LaunchLab pool facts for a mint: { pool, platformId, configId, status } or null. Pool layout: 8 disc, epoch, 5×u8, 10×u64, vesting 5×u64, configId, platformId, mintA… */
async function launchlabPools(mints) {
  const D = require("./devstats"), out = {};
  const pdas = mints.map((m) => { try { return D.pda([Buffer.from("pool"), D.b58dec(m), D.b58dec(WSOL)], LAUNCHLAB); } catch (e) { return null; } });
  for (let i = 0; i < mints.length; i += 100) {
    const keys = pdas.slice(i, i + 100), r = await srpc("getMultipleAccounts", [keys.map((k) => k || WSOL), { encoding: "base64" }]);
    ((r && r.value) || []).forEach((acc, j) => {
      const m = mints[i + j]; if (!acc || acc.owner !== LAUNCHLAB) return;
      const b = Buffer.from(acc.data[0], "base64"); if (b.length < 237) return;
      if (D.b58enc(b.subarray(205, 237)) !== m) return; // layout self-check: mintA must be this token
      out[m] = { pool: keys[j], status: b[17], configId: D.b58enc(b.subarray(141, 173)), platformId: D.b58enc(b.subarray(173, 205)) };
    });
  }
  return out;
}
// Meteora Dynamic Bonding Curve: progress = SOL in the curve / the config's migration threshold (layout from the official SDK IDL).
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
async function dbcState(pool, mint) {
  const D = require("./devstats");
  const r = await srpc("getMultipleAccounts", [[pool], { encoding: "base64" }]), acc = r && r.value && r.value[0];
  if (!acc || acc.owner !== DBC) return null;
  const b = Buffer.from(acc.data[0], "base64"); if (b.length < 312) return null;
  if (D.b58enc(b.subarray(136, 168)) !== mint) return null; // self-check: base_mint
  const config = D.b58enc(b.subarray(72, 104)), quote = b.readBigUInt64LE(240), migrated = b[305] === 1;
  const c = await srpc("getMultipleAccounts", [[config], { encoding: "base64" }]), ca = c && c.value && c.value[0];
  let progress = migrated ? 100 : null;
  if (!migrated && ca && ca.owner === DBC) {
    const cb = Buffer.from(ca.data[0], "base64");
    if (cb.length >= 272 && D.b58enc(cb.subarray(8, 40)) === WSOL) { // self-check: quote mint is SOL
      const th = cb.readBigUInt64LE(264);
      if (th > 0n) progress = Math.min(100, Number(quote * 10000n / th) / 100);
    }
  }
  return { pool, migrated, progress, quoteSol: Number(quote) / 1e9 };
}
/** Which of these Solana mints were launched on higher.fun. Returns a Set. */
async function higherOf(mints) {
  const found = new Set(); mints = [...new Set(mints.filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)))].slice(0, 300);
  if (!mints.length) return found;
  const ids = ["7mT6fb3m6W2886ymKsShBBcnX3TYb9ZsnkDJtACsVt8V"].concat(String(process.env.HIGHER_PLATFORM_ID || "").split(",").map((x) => x.trim()).filter(Boolean)); // higher.fun LaunchLab platform config
  mints.filter((m) => /high$/.test(m)).forEach((m) => found.add(m));
  if (ids.length) { const P = await launchlabPools(mints).catch(() => ({})); for (const m of mints) if (P[m] && ids.includes(P[m].platformId)) found.add(m); }
  const rest = mints.filter((m) => !found.has(m));
  if (rest.length && helius()) {
    const a = await srpc("getAssetBatch", { ids: rest });
    (a || []).forEach((x) => { if (!x || !x.id) return; const c = x.content || {}, s = JSON.stringify([c.json_uri, c.links, c.metadata && c.metadata.description, c.metadata && c.metadata.external_url]).toLowerCase(); if (s.includes("higher.fun")) found.add(x.id); });
  }
  return found;
}
const HIGHER = { n: "higher.fun", k: "higher" };

module.exports = { dbcState, HIGHER, higherOf, launchlabPools, launchpadOf, launchpadByCreator, PAD_INFO, BY_CREATOR, LP_DEX, PAD_URL, padUrl };
