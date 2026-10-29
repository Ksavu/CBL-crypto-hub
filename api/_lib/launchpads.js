// Launchpad origin of a token, shared by the scanner, the Token Radar and the bot.
//   launchpadOf(chain, ca, dexIds, labels) — from DEX ids + vanity address endings (pump, bonk, LoL, 4444, b07...)
//   launchpadByCreator(chain, creator)     — the token contract was deployed by a known launchpad contract
// Launchpad origin (best effort): DEX ids where the token trades + vanity address endings launchpads use.
// Returns { n: name, k: short key, g: graduated (true/false, null = unknown) } or null.
const LP_DEX = { pumpfun: ["Pump.fun", "pump"], pumpswap: ["Pump.fun", "pump"], moonshot: ["Moonshot", "moon"], fourmeme: ["Four.meme", "four"], four_meme: ["Four.meme", "four"],
  virtuals: ["Virtuals", "virt"], zora: ["Zora", "zora"], apestore: ["Ape.store", "ape"], flaunch: ["Flaunch", "flaunch"], boop: ["Boop", "boop"], heaven: ["Heaven", "heaven"],
  believe: ["Believe", "believe"], launchlab: ["LaunchLab", "launchlab"], bonkfun: ["LetsBonk", "bonk"], letsbonk: ["LetsBonk", "bonk"] };
function launchpadOf(chain, ca, dexes, labels) {
  const a = String(ca), d = dexes.map((x) => String(x || "").toLowerCase()), lb = labels.map((x) => String(x || "").toLowerCase());
  const curve = (ids) => d.some((x) => ids.includes(x)), grad = (ids) => d.some((x) => !ids.includes(x)); // trades elsewhere = graduated
  if (chain === "solana") {
    if (/LoL$/.test(a)) return { n: "launched.lol", k: "lol", g: null };
    if (/pump$/.test(a) || curve(["pumpfun", "pumpswap"])) return { n: "Pump.fun", k: "pump", g: !d.includes("pumpfun") || grad(["pumpfun"]) };
    if (/bonk$/.test(a) || curve(["bonkfun", "letsbonk"])) return { n: "LetsBonk", k: "bonk", g: grad(["raydium", "bonkfun", "letsbonk"]) || null };
    if (curve(["moonshot"])) return { n: "Moonshot", k: "moon", g: grad(["moonshot"]) };
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
};
const launchpadByCreator = (chain, creator) => (creator && BY_CREATOR[chain] && BY_CREATOR[chain][String(creator).toLowerCase()]) || null;

module.exports = { launchpadOf, launchpadByCreator, PAD_INFO, BY_CREATOR, LP_DEX };
