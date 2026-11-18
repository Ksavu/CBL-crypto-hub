// Partner promo shown in the bot (Bartender menu, /game, Trending + recap posts).
// Change it any time in Vercel without code: PROMO_TEXT, PROMO_URL, PROMO_ABOUT. PROMO_OFF=1 hides it everywhere.
const env = (k) => String(process.env[k] || "").trim();
const on = () => !/^(1|true|yes)$/i.test(env("PROMO_OFF"));
const url = () => env("PROMO_URL") || "https://degengalaxy.space";
const text = () => env("PROMO_TEXT") || "🪐 Play Degen Galaxy · win SOL";
const about = () => env("PROMO_ABOUT") || "🪐 <b>DEGEN GALAXY</b> ($DGALAXY)\n\nA 3D Solana meme strategy game: pick a meme faction, conquer planets and win a share of the <b>SOL prize pool</b> each epoch.\n\nConnect Phantom or Solflare and launch into the galaxy 🚀";
/** One inline-keyboard row with the promo button, or null when switched off. */
const row = () => (on() ? [{ text: text(), url: url() }] : null);
const msg = () => ({ text: about(), reply_markup: { inline_keyboard: [[{ text: "🚀 Launch into Degen Galaxy", url: url() }]] } });
module.exports = { on, row, msg, url };
