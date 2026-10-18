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
