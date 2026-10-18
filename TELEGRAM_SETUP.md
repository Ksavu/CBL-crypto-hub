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
