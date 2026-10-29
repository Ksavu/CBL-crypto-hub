# CBL Crypto Hub — member platform setup

## Preview
Open `index.html` or serve these static files on your hosting platform. New pages: `account.html`, `radar.html`, `rewards.html`.

## Authentication (not live until configured)
1. Create a Supabase project. Put the public project URL and anon/publishable key in `config.js`. **Never** put `service_role` keys in browser code.
2. Enable email OTP, Google, Apple, and Discord providers under Supabase Authentication. Configure OAuth client IDs, secrets and allowed redirect URLs in the Supabase console; do not commit secrets.
3. Set allowed redirect URLs and use HTTPS. Test the flows and email OTP template configuration. All OAuth sign-in buttons use the real Supabase SDK only after configuration.
4. Implement wallet login separately: use Reown AppKit/WalletConnect or thirdweb and a server-verified nonce/signature challenge (SIWE for EVM, chain-appropriate signed challenge for Solana). Connecting a wallet alone is NOT an authenticated account. No signature requests are implemented in this preview.
5. Add Postgres tables `profiles`, `watchlists`, `saved_scans`, `linked_wallets`, `chat_messages`, `reward_events` and `reward_balances` with mandatory Row Level Security (RLS). Only the authenticated user can read/write their own scans/watchlists; reward balances/events are server-controlled, never client-awarded. Use server timestamps, idempotency keys, rate limits and audit logs.

## Community rewards (planned only)
Link community chat to authenticated users, establish moderation and reporting tools, cap rewardable events per day, prohibit self-spam or farming, and credit points only for server-verified approved events. No cash value or token payout implied. Do not use Telegram or Discord message counts as a reliable reward source without verification.

## Token Radar (read-only market screening)
`radar.html` samples recent DexScreener token profiles, fetches available pairs, filters liquidity and trading volume. It is NOT an exhaustive universe or verified safe-token feed. Market data can be missing, delayed or blocked by CORS/rate limits. No trading is executed. Contract safety needs separate verification by CBL Coin Sniffer/GoPlus before making decisions. For production, use a backend scheduled indexing pipeline with explicit network support, cached security scans, timestamps, rate-limits, wallet-history evidence, and source references. Never mark a token guaranteed safe.

## Other login options
Microsoft, passkeys, Telegram, X and GitHub can be considered depending on supported provider/integration and demand; prioritize email, Google, Apple and wallet sign-in. Social providers are not yet all enabled on this static prototype.

## Contact
cryptobarlounge@gmail.com; Telegram link is a placeholder until the correct URL is supplied.
