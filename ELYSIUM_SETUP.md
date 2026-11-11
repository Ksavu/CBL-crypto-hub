# Elysium (Kinetiq's Hyperliquid L2)

Elysium is in the scanner (site + CBLScannerBot), the Token Radar, the contract audit and the wallet tracker.
Trading (Bartender), CBL Swap and the bridge are not wired yet.

## Network

| | |
|---|---|
| Chain ID | `99901` |
| Gas | HYPE (bridged 1:1 from HyperEVM) |
| Public RPC | `https://rpc.elysium.kinetiq.xyz` |
| Explorer | `https://elysium.kinetiq.xyz` (Blockscout: `/tx/`, `/address/`, `/token/`) |
| DexScreener / GeckoTerminal id | `elysium` |
| WHYPE | `0xbA876237B0F021A6c6D852d6c26E107997cC5E81` |

Source: https://elysium.kinetiq.xyz/docs/connecting-to-elysium

This is **not** the older Vulcan Forged "Elysium" (chain 1338/1339, LAVA). `viem/chains` still exports that one as
`elysiumTestnet`, so define chain 99901 by hand wherever viem/wagmi is used.

## After deploying

Open `https://cryptobarlounge.space/api/scan?chaindiag=elysium`.

- `rpc.ok` must be `true` (chain id 99901).
- `dexscreener.elysiumPairs` and `geckoterminal.pools` should be above 0.
- `indexer.token.ok` and `indexer.holders.ok` should be `true`: that is elysiumexplore.com ("opsis"), a free
  third-party indexer (docs: https://elysiumexplore.com/api-docs). It supplies holder count, top holders,
  the deployer, the launchpad and verified source for audits.
- `sellCheck.findings` should show `"honeypot": false` and tax figures for KNTQ. That is the honeypot and tax
  check (below). Add `&probe=<token address>` to the URL to run it on any token and see the raw result.
- `kinetiqExplorer` is Kinetiq's own explorer API (undocumented). It refuses server requests with `429`, so
  it is only a backup for holders and the source of the blocked/taxed check when it does answer.
- `blockscout` is empty unless `ELYSIUM_EXPLORER_API` is set. Only the wallet tracker still needs it.

## Vercel env (all optional)

- `ELYSIUM_RPC`: private RPC (Alchemy `https://elysium-mainnet.g.alchemy.com/v2/<key>`, Quicknode, Chainstack).
  The public RPC is shared by everyone, so set this before real traffic.
- `ELYSIUM_EXPLORER_API`: Blockscout API v2 base, e.g. `https://<host>/api/v2`, if you find one. No public
  one is known. A host is only used if it knows mainnet WHYPE as a contract.
- `ELYSIUM_INDEXER_API`: base URL of the indexer if it moves (default `https://elysiumexplore.com`).
- `ELYSIUM_LOG_RANGE`: block span per `eth_getLogs` call (default `2000`). Raise it if your RPC allows more:
  with 100 ms blocks, 2000 blocks is only ~3 minutes, so the sniper/bundle trace reaches further back with a bigger span.

## Honeypot and tax check

GoPlus and honeypot.is don't cover chain 99901, so the scanner runs its own rehearsal on the token's main pool:
buy a little, move some to another wallet, send the rest back to the pool and sell. It is one `eth_call` carrying
the creation code of `contracts/CblTokenProbe.sol` (compiled copy in `api/_lib/tokenprobe.json`); nothing is
deployed, signed or paid, and the chain rolls everything back. Logic and wording live in `api/_lib/tokenprobe.js`.

- Uniswap v4 pools (and the launchpads' own pool managers): real swaps both ways, so hook restrictions and
  hook fees show up. Needs the pool key from the indexer.
- v3 and v2 style pools: tokens are taken in a flash swap; buy, transfer and sell taxes are measured and a blocked
  transfer to the pool is caught, but the final sell swap itself is not executed.
- Results: "Honeypot confirmed by simulation" when the sale fails, buy/sell/transfer tax lines, a warning when
  wallet-to-wallet transfers fail, and a pool-fee warning when a buy plus a sell costs 15% or more in a v4 pool.
- Limits: a token that only blocks some wallets, or that switches a block on later, passes. Tokens with a
  same-block sell cooldown or a no-contracts rule can fail the rehearsal without being honeypots.

To rebuild the compiled copy: solc 0.8.26, optimizer 200 runs, EVM version shanghai, contract `CblTokenProbe`.

## Bot

`/scan <0x…> elysium` (or `ely`). Auto-detect also works once DexScreener or GeckoTerminal lists the token,
or when the contract exists on Elysium and not on Robinhood Chain.

## Known gaps

- Mint, blacklist, pause and hidden-owner functions are not checked (the card says "Limited coverage on this
  chain"): the rehearsal shows what happens to a trade now, not what the owner can still change.
- Launchpads tagged: BOXA, Kleos, ElysPump (factories and pool contracts in `api/_lib/launchpads.js`), Montra
  by DEX name, plus whatever the indexer reports for a token.
