// Promos shown in the bot (Bartender menu, Trending + recap posts) and their commands.
// Change them any time in Vercel without code:
//   Degen Galaxy (/game):  PROMO_TEXT, PROMO_URL, PROMO_ABOUT, PROMO_OFF=1 hides it
//   MintMelt (/mintmelt):  MINTMELT_TEXT, MINTMELT_URL, MINTMELT_ABOUT, MINTMELT_OFF=1 hides it
const env = (k) => String(process.env[k] || "").trim();
const off = (k) => /^(1|true|yes)$/i.test(env(k));

const PROMOS = {
  galaxy: {
    off: () => off("PROMO_OFF"),
    url: () => env("PROMO_URL") || "https://degengalaxy.space",
    text: () => env("PROMO_TEXT") || "🪐 Play Degen Galaxy · win SOL",
    about: () => env("PROMO_ABOUT") || "🪐 <b>DEGEN GALAXY</b> ($DGALAXY)\n\nA 3D Solana meme strategy game: pick a meme faction, conquer planets and win a share of the <b>SOL prize pool</b> each epoch.\n\nConnect Phantom or Solflare and launch into the galaxy 🚀",
    cta: "🚀 Launch into Degen Galaxy",
  },
  mintmelt: {
    off: () => off("MINTMELT_OFF"),
    url: () => env("MINTMELT_URL") || "https://www.mintmelt.fun",
    text: () => env("MINTMELT_TEXT") || "🫠 Launch on BNB · MintMelt",
    about: () => env("MINTMELT_ABOUT") || "🫠 <b>MINTMELT</b> · mint tokens, melt jeets\n\nLaunch a BNB Chain token in one click: fair bonding curve, automatic graduation to <b>PancakeSwap V2</b>, and <b>creator fee sharing</b> on every trade.\n\nAlso: BEP-20 token factory and LP / team locker. Launch fee 0.005 BNB.",
    cta: "🫠 Launch on MintMelt",
  },
};

const live = () => Object.keys(PROMOS).filter((k) => !PROMOS[k].off());
/** Inline-keyboard rows, one button per live promo (spread into a keyboard). */
const rows = () => live().map((k) => [{ text: PROMOS[k].text(), url: PROMOS[k].url() }]);
/** Old single-row helper: first live promo, or null. */
const row = () => rows()[0] || null;
/** Full message for a promo's command (/game, /mintmelt). */
const msg = (key = "galaxy") => {
  const p = PROMOS[key] || PROMOS.galaxy;
  return { text: p.about(), reply_markup: { inline_keyboard: [[{ text: p.cta, url: p.url() }]] } };
};
const on = (key = "galaxy") => !!PROMOS[key] && !PROMOS[key].off();
const url = (key = "galaxy") => (PROMOS[key] || PROMOS.galaxy).url();
module.exports = { on, row, rows, msg, url };
