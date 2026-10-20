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
