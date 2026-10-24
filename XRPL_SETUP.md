# XRPL on CBL Swap

XRP Ledger tokens trade inside the existing CBL Swap, using the same Buy/Sell box and the same Get quote → Confirm flow. Trades go through the XRPL's native AMM and order book.

## Vercel environment variables

| Variable | Value |
|---|---|
| `XAMAN_API_KEY` | API key from https://apps.xaman.dev (add `https://cryptobarlounge.space` to the app's origins/redirect URIs) |
| `XRPL_FEE_ACCOUNT` | Your XRPL dev wallet (r…). Must be activated (≥ 1 XRP). Leave empty for no fee. |
| `XRPL_FEE_BPS` | Fee in basis points, default `50` (0.5%), max `300` |
| `THOR_AFFILIATE` | Your THORName (e.g. `cbl`) or a `thor1...` address. Receives the XRP bridge fee. |
| `THOR_AFFILIATE_BPS` | Bridge fee in basis points, default `50` (0.5%), max `300` |

Redeploy after adding them.

## Bridge to/from XRP (THORChain)

LI.FI doesn't support the XRP Ledger, so any bridge with **XRP Ledger** on either side goes through THORChain. All other bridges still use LI.FI.

- **Into XRP:** ETH, BNB, AVAX, ETH on Base, and USDT/USDC on Ethereum, BNB Chain, Base and Avalanche. Signed with the user's EVM wallet via THORChain's router (plus an approve step for stablecoins).
- **Out of XRP:** to any of the above or to BTC. The user signs an XRP payment with a memo in Xaman, Joey, Crossmark or GemWallet.
- **Fee:** your 0.5% is added on the server as a THORChain affiliate fee, so it can't be removed in the browser.
- **Limits:** delivery takes a few minutes; THORChain's outbound fee (about $1) means the page enforces a minimum per route. If price moves too far, THORChain refunds automatically.

### Getting paid the bridge fee

THORChain pays affiliate fees on THORChain itself.
- **Simplest:** set `THOR_AFFILIATE` to a `thor1...` address (Vultisig, Keplr, Ledger). Fees build up there in RUNE.
- **Nicer:** register a THORName (about 10 RUNE) and set its preferred asset to XRP or BNB with your address; THORChain then pays out in that asset. Put the THORName in `THOR_AFFILIATE`.

## How it works

- **Wallets:** "Connect XRPL wallet" offers Xaman (QR on desktop, opens the app on mobile), Joey (browser extension if installed, otherwise the Joey app via WalletConnect: QR on desktop, opens the app on mobile; uses the same `WC_PROJECT_ID`), Crossmark and GemWallet.
- **Tokens:** paste `CODE.rIssuer` in "Any token by address", or link `/?swap=CODE.rIssuer&chain=xrpl#swap`. The Telegram bot's 💱 Swap button and the scanner's "Buy on CBL Swap" button now open this flow instead of xrpl.to.
- **First buy of a token:** the user approves a trust line once. This locks 0.2 XRP reserve, which is refundable.
- **Fee:** always paid in XRP to `XRPL_FEE_ACCOUNT`.
  - Buy: the fee % comes out of the XRP paid.
  - Sell: the fee % is taken from the guaranteed minimum XRP received.
  - When the XRPL Batch amendment is live, the swap and fee go in one atomic transaction with one signature. If the swap fails, no fee is charged.
  - Otherwise, the user signs the swap, then the fee payment.
  - The quote text shows "includes 0.5% CBL fee", the same as the PancakeSwap route. The fee also appears in the user's wallet when they sign.
- **Slippage:** enforced on-chain (Fill-or-Kill). If the price moves too far, nothing trades.

## Listing an XRPL project

Add it to `P` in `index.html` with `c:"XRP Ledger"` and `a:"CODE.rIssuer"`, e.g.

```js
{n:"Sologenic (SOLO)",c:"XRP Ledger",k:"Utility",s:"v",a:"SOLO.rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz",d:"..."}
```

The XRP Ledger chain filter chip is already added.

## Files

- `xrpl-swap.js` — XRPL module (wallets, quote, trust line, swap, fee)
- `index.html` — wiring: XRPL wallet button, XRPL tokens in the swap box, XRP pay option, links
- `api/config.js` — exposes the Xaman key, XRPL fee and bridge fee rate to the page
- `api/thor.js` — THORChain proxy (adds your affiliate fee server-side)
- `api/_lib/format.js` — bot swap button points to CBL Swap for XRPL tokens
