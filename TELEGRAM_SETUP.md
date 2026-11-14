# CBL Telegram scanner bot: setup

1. In Telegram, open @BotFather, send /newbot, pick a name and username. Copy the token (keep it secret).
2. In BotFather: /setprivacy -> choose your bot -> Disable (so it can read contract addresses posted in groups).
   Optional: /setcommands -> `scan - Scan a token contract` and `help - How to use the bot`.
3. In Vercel: Project -> Settings -> Environment Variables. Add:
   - TELEGRAM_BOT_TOKEN = the token from BotFather
   - TELEGRAM_WEBHOOK_SECRET = a long random string you invent (letters and numbers only, e.g. 40 characters)
   - TELEGRAM_BOT_USERNAME = your bot username, with or without @
   - SITE_URL = https://cryptobarlounge.space
   Then redeploy (push any commit, or Deployments -> Redeploy).
4. Register the webhook (run once on your computer; put your own values in):
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://cryptobarlounge.space/api/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d "allowed_updates=[\"message\",\"callback_query\"]"
   You should get {"ok":true,...}.
5. Test: message your bot a contract address. In a group, add the bot and paste an address.

Never paste the bot token in chat or commit it to Git. If it leaks, revoke it in BotFather (/revoke).

---
## Watchlist and rug alerts (setup)

1. **Supabase**: create a free project at supabase.com. SQL Editor, New query, paste the whole `supabase.sql` file, Run.
2. **Vercel env vars** (Settings, Environment Variables, Production), then redeploy:
   - `SUPABASE_URL` = Project Settings, API, Project URL
   - `SUPABASE_SERVICE_KEY` = Project Settings, API, `service_role` key (server only, never put it in index.html or chat)
   - `CRON_SECRET` = any random 30+ character string you make up
3. **GitHub secret**: repo, Settings, Secrets and variables, Actions, New repository secret: name `CRON_SECRET`, same value as above.
4. The file `.github/workflows/alerts.yml` runs every 5 minutes and calls `/api/cron`. Check it under the repo's Actions tab (you can press "Run workflow" to test).
5. In the bot: `/watch <address>`, the 👁 Watch button on a scan, `/unwatch <address>`, `/list`. Alerts arrive in the user's DM (they must have pressed Start once).

Alerts: liquidity drop of 50%+ in an hour, price down 40%+ in an hour, deployer sells half or more (Solana, needs HELIUS_API_KEY), mint or freeze authority active (Solana), honeypot flag, sell tax jump of 10+ points, owner change, risk score down 20+ points. Each type repeats at most once per 3 hours per token. Limit: 10 tokens per user, 30 tokens checked per run.

---
## Wallet tracker (/track, /wallet, 👤 Track dev)

Users follow any wallet and get a DM when it **buys, sells, swaps, creates a new token or sends tokens out**. Chains: all EVM chains the scanner supports, Solana, XRP Ledger and Terra Classic.

Commands: `/track <wallet> [chain] [name]`, `/untrack <wallet>`, `/wallets`, `/wallet <wallet>` (developer report: every token it created with live/dead status, plus 7 days of trades). Scan results show a **👤 Track dev** button when the token's creator is known. If someone pastes a wallet instead of a token, the bot offers to show or track it. Max 10 wallets per user.

Setup:
1. **Supabase:** run the `wallets` and `tracked` part at the end of `supabase.sql`.
2. **GitHub workflow:** `.github/workflows/alerts.yml` now also calls `/api/cron?job=wallets` every 5 minutes (same `CRON_SECRET`). Upload the updated file.
3. **Keys** (Vercel env):
   - `ETHERSCAN_API_KEY` (free at etherscan.io): one key for every EVM chain. The free plan does not cover **BNB Chain, Base, Optimism and Avalanche**. Base, Optimism and Avalanche fall back to free Blockscout/Routescan automatically; **BNB Chain wallets need a paid Etherscan plan** (otherwise BSC is skipped).
   - `HELIUS_API_KEY`: Solana (already used by the deep scan).
   - XRPL and Terra Classic need no keys.
4. Optional: in BotFather, `/setcommands` and add `track`, `wallet`, `wallets`, `untrack` so they show in the menu.

How it decides: each transaction is reduced to how the wallet's balances changed. Token in + native coin or stablecoin out = buy, the reverse = sell, token for token = swap, a contract deploy / new Solana mint / new XRPL AMM pool = new token, tokens leaving with nothing back = transfer. EVM wallets are checked on the chains they used in the last 180 days (up to 6); add one with `/track <wallet> <chain>`. Alerts never replay anything older than 30 minutes.

Limits: on EVM chains, tokens created through a launchpad factory (e.g. four.meme, Clanker) are reported as a buy or transfer, not as "new token", because the dev didn't deploy the contract. Alerts arrive within about 5 minutes, not instantly.

## Token Radar (/radar)

Trending, new and boosted tokens on all scanner chains, each with a CBL score. Sources: DexScreener (boosts, profiles, community takeovers, market data) and GeckoTerminal (trending and new pools). No keys needed.

- `/api/cron?job=radar` (called by the same GitHub workflow every 5 minutes) builds a snapshot: ~150 tokens with $1K+ liquidity and volume, ranked by 1h momentum, and scores the most active ones with the Coin Sniffer engine (scores are reused for 30 minutes, about 30–50 new scores per run).
- The page reads it from `/api/scan?radar=1` (market numbers refreshed, edge-cached 60s) and auto-refreshes every minute. Tabs: Trending, New pairs, Gainers, Safer picks (score 70+, $20K+ liquidity, no honeypot). Filters: chain, liquidity, volume, age, hide high risk.
- Bot: `/radar` (safer picks), `/radar trending`, `/radar new`, `/radar gainers`, with buttons to switch.
- **Setup:** run the `radar_cache` table at the end of `supabase.sql` and upload the updated workflow. The first snapshot appears after the next cron run (up to 5 minutes).

## Bonding curves on the Radar

The Radar's **🎢 Bonding curves** tab (and the homepage "Curves" tab, and `/radar curves` in the bot) lists tokens still on a launchpad curve, before they hit a DEX: sort by 🔥 Hot now, 🆕 Newest or 🎓 Near graduation.
- Pump.fun: its public coin lists (live trades, market cap, king of the hill), refreshed on every page load.
- Moonshot, LetsBonk/LaunchLab, Meteora DBC, Boop, Four.meme, Flap, Virtuals: GeckoTerminal's pool lists for those launchpad DEXes. The DEX ids are discovered once a day, so new launchpads show up automatically.
- Pons, Hood.fun, RobinFun (Robinhood Chain): launch events from their factory contracts on the Robinhood Blockscout explorer.
- `/api/cron?job=curves` (same GitHub workflow) rebuilds the list every 5 minutes and scores the hottest 40 with the Coin Sniffer. Stored in `radar_cache` (no new table).

## Group first calls (like Phanes)

In groups, the first person to post a token's contract address gets the **call**. The scan card shows it: "🎯 First call by @alice at $1.0M MC" for the first post, then "🏆 First call: @alice · $1.0M → $2.5M (2.5x)" whenever anyone posts it again.
- `/api/cron?job=calls` (same GitHub workflow, every 5 minutes) refreshes market caps of calls from the last 14 days, records the peak, and posts **X alerts** in the group when a call crosses 2x, 3x, 5x, 10x, 20x, 50x, 100x... (replying to the original post).
- `/lb [24h|7d|30d|all]`: top callers ranked by average peak X, with hit rate (2x+) and best calls. Buttons switch the period.
- `/calls`: your calls in this group, or reply to someone's message to see theirs.
- `/xalerts on|off`: group admins can mute X alerts.
- Setup: run the `calls` and `group_settings` part of `supabase.sql`, upload the updated workflow. The bot needs privacy mode off in BotFather (it already does to scan addresses in groups).

## Solana swap (Jupiter) and swap links from the bot

1. Get a free Jupiter API key: developers.jup.ag/portal, sign in, create a key.
2. Vercel env var `JUP_API_KEY` = that key (Production), then redeploy. Without it the site says "Solana swaps are not switched on yet."
3. The bot's 💱 Swap button now opens `/?swap=<token address>&chain=<network>` so the token and network are already set on the site. For taxed EVM tokens the link also carries the sell tax so slippage starts at 6%.
4. Later, to earn a fee on Solana swaps: create a Jupiter referral account in the portal, then add `JUP_REFERRAL_ACCOUNT` (its address) and `JUP_REFERRAL_FEE` (50 to 255, in basis points). Nothing shows in the UI.

## Hidden swap fees (set in Vercel > Settings > Environment Variables, then Redeploy)
Fees are added on the server (api/jup.js and api/li.js), so the UI never shows them and the browser can't remove them.

**Solana (Jupiter):** go to referral.jup.ag, create a referral account, then create token accounts for SOL and USDC.
- JUP_REFERRAL_ACCOUNT = your referral account address
- JUP_REFERRAL_FEE = 50 to 255 (basis points; 50 = 0.5%)

**EVM (LI.FI):** go to portal.li.fi, create an integrator ID, set your fee wallet, copy the free API key.
- LIFI_INTEGRATOR = your integrator ID
- LIFI_FEE = 0.005 (0.5%, max accepted 0.05)
- LIFI_API_KEY = key from the portal
Collect EVM fees in the portal (Claim). On Solana LI.FI pays straight to your wallet.

**Not covered:** the direct PancakeSwap V2 route (BSC tokens found on Pancake) has no fee.

## XRP tokens
- XRPL native tokens: send `CODE.rIssuerAddress` (e.g. `SOLO.rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz`) to the bot or the website scanner. No keys needed (public XRPL RPC + DexScreener). Scan only, no swap.

## WalletConnect project ID
Set `WC_PROJECT_ID` in Vercel (Settings, Environment Variables) and redeploy. The site reads it from `/api/config`, so pushing a new zip no longer wipes it. The value in `index.html` stays empty.

## Contract audit
- Bot: `/audit 0x... [network]` (eth, bsc, base, poly, arb, op, avax, linea, scroll, zksync, blast, mantle, and more; leave it out to auto-detect) or the 🛡 Audit button on EVM scan cards. Website: Scanner section, "Contract audit" tab (address, or paste code that is not published yet).
- Source comes from Sourcify (free, no key). Add `ETHERSCAN_API_KEY` in Vercel (free key at etherscan.io, works for Ethereum, BNB Chain and Base) to find more verified contracts.
- The checks are offline pattern rules (mint, blacklist, uncapped fees, trading switch, router/pair changes, upgradeable code, selfdestruct, tx.origin, old compilers and more). Not a manual audit.
- AI review can be added later: the result already carries an `audit.ai` slot, and `api/audit.js` is the single place to call it from.

## 🍸 CBL Bartender — trading bot (/trade), BonkBot-style custodial wallets

Each Telegram user gets one Solana wallet and one EVM wallet (same address on BNB Chain, Base and Robinhood Chain).
Private keys are encrypted with AES-256-GCM using `BOT_WALLET_KEY` and stored in Supabase (`bot_wallets`). Trading works only in private chat.

1. **Supabase:** run `trading.sql` in SQL Editor.
2. **Vercel env vars**, then redeploy:
   - `BOT_WALLET_KEY` — 64 hex characters. Generate in any browser console:
     `[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('')`
     ⚠️ Back it up offline. If it is lost or changed, every user wallet becomes unreadable (funds stuck). Never put it in the website or GitHub.
   - `BOT_SOL_FEE_ACCOUNT` — your Solana wallet that receives the trading fee.
   - `BOT_EVM_FEE_ACCOUNT` — your EVM wallet for the fee (falls back to `EVM_FEE_ACCOUNT`).
   - `BOT_FEE_BPS` — optional, default `100` (1%).
   - Already used: `JUP_API_KEY` (Solana swaps), `LIFI_API_KEY` (EVM swaps), `HELIUS_API_KEY` (Solana RPC).
   - Optional faster RPCs: `BSC_RPC`, `BASE_RPC`, `ROBINHOOD_RPC`.
3. **BotFather → /setcommands**, add: `trade - Trading wallet`, `positions - Holdings and PnL`, `buy - Buy a token`, `sell - Sell a token`, `withdraw - Withdraw coins`, `export - Export private keys`, `settings - Trading settings`. Optional: `BSC_MEV_RPC` (default PancakeSwap MEV Guard).

How it works: paste a token in DM → 🟢 Buy (presets or ✏️ custom) / 🔴 Sell 25/50/100%. Solana routes through Jupiter (incl. pump.fun curves),
EVM through LI.FI, and Four.meme / Pons curve tokens trade on the launchpad contract directly. The fee is a separate transfer after each successful trade.
In groups, scans show "🍸 Order it from the Bartender", which opens the token in DM.

### Take profit / stop loss
On a token panel: 🎯 Take profit / 🛑 Stop loss (e.g. `100 50` = at +100% from entry sell 50%). Settings → Auto TP / Auto SL attaches them to every buy.
Checked by `/api/cron?job=orders` (first step of the GitHub Actions workflow, every 5 minutes). Prices are DEX Screener native-pair prices.

### Bundles (Solana)
Run `bundles.sql` once. In 👛 Wallet: ➕ add up to 5 Solana wallets, 💸 spread SOL from W1, turn 📦 Bundles on.
Every Solana buy/sell then runs from all wallets in one Jito bundle (same block, all or nothing). Tip is set per user (default 0.001 SOL).
Optional env: `JITO_URL` (default https://mainnet.block-engine.jito.wtf/api/v1/bundles).

## 🍸 CBL Bartender web page (/bartender) + install as app
Same wallets as the Telegram bot, at https://cryptobarlounge.space/bartender. Login is "Log in with Telegram" (no passwords). Private-key export stays in Telegram only.
The Telegram bot stays as it is; its home screen just has a 🌐 link to the web page.
1. **BotFather → /setdomain** → choose your bot → `cryptobarlounge.space` (needed for the "Log in with Telegram" button).
2. **PC / Android / iPhone install:** open /bartender in Chrome or Edge → "Install app" (iPhone: Share → Add to Home Screen).
3. **Android APK:** https://www.pwabuilder.com → enter `https://cryptobarlounge.space/bartender` → Package for stores → Android → Download. Put the `.apk` in the repo root as `cbl-bartender.apk` (the page then shows a "Download Android app" button) and copy the `assetlinks.json` from the PWABuilder zip to `.well-known/assetlinks.json` so it opens full-screen. Keep the signing key for future updates.

## higher.fun (Solana)
higher.fun coins run on Raydium LaunchLab, so CBL Swap, the Bartender and the scanner already trade/scan them (Jupiter routes LaunchLab).
They are labelled ⬆️ higher.fun by their `…high` address ending and by higher.fun's LaunchLab platform config `7mT6fb3m6W2886ymKsShBBcnX3TYb9ZsnkDJtACsVt8V` (built in; extra ids can go in `HIGHER_PLATFORM_ID`). Check any coin with `/api/scan?padinfo=<address>`.

## CBL Trending channel
- `TRENDING_CHANNEL` = `@yourchannel` (bot is admin: post, edit, pin) · `ADMIN_IDS` = your Telegram id(s) · `TRENDING_CONTACT` = `@yourhandle`
- Admin commands: `/boost <ca> [hours] [chain]`, `/unboost <ca>`, `/boosts`, `/trendpost` (preview)

## Bartender referrals
- Run `refs.sql` in Supabase once.
- Inviters earn `REF_SHARE_PCT` (default 25) % of their invitees' trading fees; they claim in 🤝 Referrals.
- Automatic payouts (optional): `REF_PAYOUT_SOL_KEY` (base58 key of a small SOL hot wallet), `REF_PAYOUT_EVM_KEY` (0x key, needs BNB/ETH on Base/ETH on Robinhood). Keep a small float there only.
- Without payout keys, claims are queued and admins get a DM: pay it, then `/refpaid <id> <tx>`. `/refclaims` lists pending ones.

## Copy trading
- Run `copy.sql` in Supabase once.
- Bartender → 👥 Copy trade → ➕ Follow a wallet. Max 5 wallets per user.
- Solana is instant: the bot registers a Helius webhook (needs `HELIUS_API_KEY` and `CRON_SECRET`, both already set) pointing to `/api/cron?job=copyhook`. It updates itself when users follow / unfollow.
- BNB / Base / Robinhood and a Solana backup are checked every 5 minutes by the orders job. Trades older than 10 minutes are never copied.

## Group buy-bot
- Run `buybot.sql` in Supabase once.
- In a project group (bot added as admin): `/buybot <token address>`; options `/buybot min 50`, `step 20`, `emoji 🚀`, `media <url>`, `off` / `on`.
- Solana buys come through the Helius webhook (instant); all chains are also checked every 5 minutes (`/api/cron?job=buybot`, GitHub Actions).
- Busy Solana tokens send many webhook calls to Vercel; watch your Vercel usage if many big tokens use the buy bot.

## Daily recap
- Posted once a day in `RECAP_CHANNEL` (or `TRENDING_CHANNEL`) at `RECAP_HOUR_UTC` (default 8 = 9:00 Belgrade winter time).
- Admins: `/recap` preview, `/recap now` post it right away.

## CBL Points and group ranking
- Run `points.sql` in Supabase once.
- `/points` (also ⭐ Points in the Bartender menu) and `/rank` (top calling groups, 7 days).
- Points recalculate every 30 min (trending cron). Monday at `WEEKLY_HOUR_UTC` (default 10) a winners post goes to the channel.
- Optional `WEEKLY_PRIZE` text, e.g. `free 24h Trending boost` — shown on /points and in the winners post.

## Predict (prediction markets in the Bartender)

🔮 Predict in the Bartender menu, or `/predict` (trending) and `/predict <words>` (search), opens prediction markets from
Polymarket and Kalshi through Jupiter's Prediction API (`api/_lib/predict.js`).

- Uses the same `JUP_API_KEY` as Solana swaps. Without it the screen says Predict is not switched on.
- Buy: open a market, tap Yes or No, pick $5 / $10 / $25 / $50 or another amount, confirm. Orders are paid in USDC; if
  the wallet is short, the bot first swaps the missing USDC from the user's SOL. Minimum $5 (Jupiter's minimum),
  maximum `PREDICT_MAX_USD` (default 1000).
- 📊 My predictions: positions with value and profit, 🔴 Sell (all shares, at market), 💰 Claim for a won market,
  and 💵 USDC → SOL to turn proceeds back into SOL (plain swap, no CBL fee).
- Fee: `BOT_FEE_BPS` (1%) of the order value on buys and of the proceeds on sells, sent in SOL to `BOT_SOL_FEE_ACCOUNT`
  only after the order is filled. No fee on failed orders or claims. The fee is written to `bot_trades`
  (token `pred:<marketId>`), so referral earnings count it like any other Solana trade.
- An order that has not filled when the request ends is kept in `bot_orders` (kind `pred`). The existing cron
  `orders` job finishes it, charges the fee and messages the user. No new table and no new cron entry are needed.
- The API is in beta, and Jupiter blocks requests from US and South Korea IPs. If Predict answers "not available from
  this server's region", move the Vercel function region away from the US (Project → Settings → Functions → Region).
  The confirm screen has the user state they are not a US or South Korea resident.
