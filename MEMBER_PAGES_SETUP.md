# CBL member accounts + community chat — setup

Uses the same Supabase project as the bot.

1. **Database:** Supabase → SQL Editor → New query → paste `members.sql` → Run.
2. **Keys in Vercel** (Settings → Environment Variables), then redeploy:
   - `SUPABASE_ANON_KEY` = Supabase → Project Settings → API Keys → `anon` / publishable key (public, safe in the browser).
   - `SUPABASE_URL` is already set for the bot.
3. **Auth URLs:** Supabase → Authentication → URL Configuration
   - Site URL: `https://cryptobarlounge.space`
   - Redirect URLs: `https://cryptobarlounge.space/account`
4. **Sign-in methods:** Supabase → Authentication → Sign In / Providers
   - Email: on (works right away). For a 6-digit code instead of only a link, add `{{ .Token }}` to the Magic Link email template.
   - Web3 Wallet: turn on Solana and Ethereum.
   - Google: Google Cloud Console → Credentials → OAuth client ID (Web). Authorized redirect URI = the callback URL Supabase shows (`https://<project>.supabase.co/auth/v1/callback`). Paste Client ID + Secret into Supabase.
   - Discord: discord.com/developers → New Application → OAuth2 → add the same callback URL → paste Client ID + Secret.
5. **Chat admin:** sign in once on /account, then run in SQL Editor:
   `insert into chat_admins (user_id) select id from auth.users where email = 'you@example.com';`
   Admins see "delete" on messages. Mute a user: `insert into chat_bans (user_id) values ('<user uuid>');`

Chat rules enforced in the database: signed-in users only, 1 message per 3 seconds, 500 characters max, muted users blocked.

## Rewards (next)
Points will be awarded only by the server (cron), from verified actions — never from the browser.
