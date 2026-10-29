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

## Token Radar (radar.html and /radar)

Trending, new and boosted tokens on all scanner chains, each with a CBL score. Sources: DexScreener (boosts, profiles, community takeovers, market data) and GeckoTerminal (trending and new pools). No keys needed.

- `/api/cron?job=radar` (called by the same GitHub workflow every 5 minutes) builds a snapshot: ~150 tokens with $1K+ liquidity and volume, ranked by 1h momentum, and scores the most active ones with the Coin Sniffer engine (scores are reused for 30 minutes, about 30–50 new scores per run).
- The page reads it from `/api/scan?radar=1` (market numbers refreshed, edge-cached 60s) and auto-refreshes every minute. Tabs: Trending, New pairs, Gainers, Safer picks (score 70+, $20K+ liquidity, no honeypot). Filters: chain, liquidity, volume, age, hide high risk.
- Bot: `/radar` (safer picks), `/radar trending`, `/radar new`, `/radar gainers`, with buttons to switch.
- **Setup:** run the `radar_cache` table at the end of `supabase.sql` and upload the updated workflow. The first snapshot appears after the next cron run (up to 5 minutes).

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
