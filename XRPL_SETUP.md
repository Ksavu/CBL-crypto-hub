# XRPL on CBL Swap

XRP Ledger tokens trade inside the existing CBL Swap, using the same Buy/Sell box and the same Get quote → Confirm flow. Trades go through the XRPL's native AMM and order book.

## Vercel environment variables

| Variable | Value |
|---|---|
| `XAMAN_API_KEY` | API key from https://apps.xaman.dev (add `https://cryptobarlounge.space` to the app's origins/redirect URIs) |
| `XRPL_FEE_ACCOUNT` | Your XRPL dev wallet (r…). Must be activated (≥ 1 XRP). Leave empty for no fee. |
| `XRPL_FEE_BPS` | Fee in basis points, default `50` (0.5%), max `300` |

Redeploy after adding them.

## How it works

- **Wallets:** "Connect XRPL wallet" offers Xaman (QR on desktop, opens the app on mobile), Crossmark and GemWallet.
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
- `api/config.js` — exposes `XAMAN_API_KEY`, `XRPL_FEE_ACCOUNT`, `XRPL_FEE_BPS` to the page
- `api/_lib/format.js` — bot swap button points to CBL Swap for XRPL tokens
