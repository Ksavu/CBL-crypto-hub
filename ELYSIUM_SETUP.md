# Elysium (Kinetiq's Hyperliquid L2)

Elysium is in the scanner (site + CBLScannerBot), the Token Radar, the contract audit and the wallet tracker.
Trading (Bartender), CBL Swap and the bridge are not wired yet.

## Network

| | |
|---|---|
| Chain ID | `99901` |
| Gas | HYPE (bridged 1:1 from HyperEVM) |
| Public RPC | `https://rpc.elysium.kinetiq.xyz` |
| Explorer | `https://elysium.kinetiq.xyz/explorer` (tx pages: `/transaction/<hash>`) |
| DexScreener / GeckoTerminal id | `elysium` |
| WHYPE | `0xbA876237B0F021A6c6D852d6c26E107997cC5E81` |

Source: https://elysium.kinetiq.xyz/docs/connecting-to-elysium

This is **not** the older Vulcan Forged "Elysium" (chain 1338/1339, LAVA). `viem/chains` still exports that one as
`elysiumTestnet`, so define chain 99901 by hand wherever viem/wagmi is used.

## After deploying

Open `https://cryptobarlounge.space/api/scan?chaindiag=elysium`.

- `rpc.ok` must be `true` (chain id 99901).
- `dexscreener.elysiumPairs` and `geckoterminal.pools` should be above 0.
- `blockscout[].ok`: if none is `true`, set `ELYSIUM_EXPLORER_API` (below). Scans still work without it
  (market data, owner, supply, snipers/bundlers from the RPC), but holder counts, top holders, the deployer,
  verified-source checks, audits and the wallet tracker need the explorer API.

## Vercel env (all optional)

- `ELYSIUM_RPC`: private RPC (Alchemy `https://elysium-mainnet.g.alchemy.com/v2/<key>`, Quicknode, Chainstack).
  The public RPC is shared by everyone, so set this before real traffic.
- `ELYSIUM_EXPLORER_API`: Blockscout API v2 base, e.g. `https://<host>/api/v2`. Kinetiq documents the explorer
  page but not its API host; the built-in default is Conduit's usual host name and is unconfirmed.
- `ELYSIUM_LOG_RANGE`: block span per `eth_getLogs` call (default `2000`). Raise it if your RPC allows more:
  with 100 ms blocks, 2000 blocks is only ~3 minutes, so the sniper/bundle trace reaches further back with a bigger span.

## Bot

`/scan <0x…> elysium` (or `ely`). Auto-detect also works once DexScreener or GeckoTerminal lists the token,
or when the contract exists on Elysium and not on Robinhood Chain.

## Known gaps

- GoPlus and honeypot.is don't cover chain 99901, so there is no sell-tax / honeypot simulation yet
  (the card says "Limited coverage on this chain").
- Launchpad detection only knows the pads DexScreener lists as their own DEX (BOXA, Kleos). Add factory
  contracts to `BY_CREATOR.elysium` in `api/_lib/launchpads.js` to tag more.
