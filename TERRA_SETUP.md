# Terra Classic on CBL Swap + Bridge: setup

Vercel → Project → Settings → Environment Variables, then redeploy.

| Variable | Value | Needed for |
|---|---|---|
| `TERRA_FEE_ADDRESS` | your `terra1...` wallet (44 characters) | swap fee. No fee is charged if it's missing |
| `TERRA_FEE_BPS` | `50` (= 0.5%, max 300) | swap fee rate |
| `SKIP_AFFILIATES` | `{"osmosis-1":"osmo1..."}` | bridge fee. Skip Go takes the fee on the chain where the swap happens, which is almost always Osmosis for LUNC/USTC. Add more chains the same way if routes swap elsewhere |
| `SKIP_FEE_BPS` | `50` (= 0.5%) | bridge fee rate |
| `SKIP_CLIENT_ID` | optional, from the Skip Go team | higher Skip Go rate limits |
| `TERRA_LCD` | optional, your own Terra Classic LCD URL | faster/more reliable quotes and scans |
| `TERRA_GAS_PRICE` | optional, default `28.325` (uluna) | network fee |

Your osmo1 address: open Keplr or Leap with the same seed you use for Terra, switch to Osmosis and copy the address.

How the fees work:
- **Swap:** the fee goes to `TERRA_FEE_ADDRESS` in LUNC/USTC inside the same transaction as the swap (one signature; if the swap fails, no fee is taken).
- **Bridge:** the fee is added by the server as a Skip Go affiliate fee, so it can't be removed in the browser. If a route swaps on a chain without an affiliate address, that route runs without a fee.
