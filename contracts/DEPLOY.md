# CblFeeRouter: PancakeSwap fee on BNB Chain

1. Open remix.ethereum.org, create `CblFeeRouter.sol`, paste the file from this folder.
2. Compiler 0.8.20 or newer, Advanced: EVM version `paris`, optimizer on (200 runs). Compile.
3. Deploy (Injected Provider, wallet on BNB Chain) with constructor args:
   - `_router`: 0x10ED43C718714eb63d5aA57B78B54704E256024E (PancakeSwap V2 router)
   - `_feeRecipient`: the wallet that receives fees
   - `_feeBps`: 50 (= 0.5%, hard cap in the contract is 300 = 3%)
4. Verify the source on BscScan (Remix "Contract Verification" plugin, or bscscan.com -> Verify).
5. In `index.html` set `var FEE_ROUTER="0xYourDeployedAddress";` then push.
6. Test with a tiny buy and sell of NXS. The swap message shows "includes 0.5% CBL fee".

Later: `setFee(bps)` and `setFeeRecipient(addr)` (owner only). If the contract misbehaves, set `FEE_ROUTER=""` and the site goes back to the direct Pancake route (no fee).
Fees arrive as BNB or USDT/USDC at the fee recipient, never in project tokens.


# CblSwapRouter: Bartender trading on Elysium

No aggregator covers Elysium yet, so Bartender trades there through this router. It swaps HYPE for a token and back
on Uniswap v4 style pool managers (including the launchpads' own), v3 style pools and v2 style pairs, in up to four
hops, and takes the trading fee inside the same transaction. It holds nothing between transactions.
The contract is tested on a local chain against the real Uniswap v4, v3 and v2 builds but has not been audited.

1. Add Elysium to your wallet: chain ID `99901`, RPC `https://rpc.elysium.kinetiq.xyz`, currency `HYPE`,
   explorer `https://elysium.kinetiq.xyz`. Bridge a little HYPE over for gas.
2. Open remix.ethereum.org, create `CblSwapRouter.sol`, paste the file from this folder.
3. Compiler 0.8.26, optimizer on (200 runs), EVM version `shanghai` or `cancun`. Compile, and choose the contract
   `CblSwapRouter` (not one of the interfaces).
4. Deploy (Injected Provider, wallet on Elysium) with constructor args:
   - `wnative`: `0xbA876237B0F021A6c6D852d6c26E107997cC5E81` (wrapped HYPE). Check it first: the health check
     `/api/scan?chaindiag=elysium` shows `trading.wrapperSymbol`, which should read `WHYPE`.
   - `feeRecipient_`: the wallet that receives the trading fees (HYPE).
5. In Vercel set `ELYSIUM_ROUTER` to the deployed address and redeploy. Elysium then appears in Bartender (Telegram
   and web). Without the variable nothing changes for users.
6. Open `/api/scan?chaindiag=elysium`: `trading` should show `deployed: true`, `wrapperOk: true` and your fee wallet.
7. Test with a tiny buy and sell of a liquid token (for example KNTQ) from your own Bartender wallet.

The fee rate is the bot's `BOT_FEE_BPS` (default 1%), passed with each trade; the contract refuses anything above 3%.
Owner only: `setFeeRecipient(addr)`, `setOwner(addr)`, `rescue(token, to, amount)` for dust or tokens sent by mistake.
To switch Elysium trading off again, remove `ELYSIUM_ROUTER` and redeploy.
