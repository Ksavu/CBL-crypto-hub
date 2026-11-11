// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// CBL token probe: a buy -> wallet transfer -> sell rehearsal for one token on one pool.
//
// It is never deployed and never needs funds. The scanner sends its creation code in an eth_call (no "to"),
// the constructor runs the rehearsal and hands the measurements back as the call's return data.
// Uniswap v4 (and forks): swaps inside PoolManager.unlock() using flash accounting, then reverts.
// Uniswap v3 / v2 (and forks): takes the tokens in a flash swap and measures inside the callback, then reverts.
// Nothing is ever paid for, so every state change is rolled back.

struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}
interface IV3Pool { function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256); }
interface IV2Pair { function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external; }

struct Result {
    uint256 magic;      // MAGIC: tells real measurements from an unrelated revert
    uint256 failAt;     // 0 = everything worked, else the step that failed (see F_*)
    uint256 quoteIn;    // quote spent on the buy (v4, v3)
    uint256 buyOut;     // tokens the pool sent
    uint256 buyGot;     // tokens that arrived
    uint256 xferSent;   // wallet -> wallet
    uint256 xferGot;
    uint256 sellSent;   // wallet -> pool
    uint256 sellPaid;   // what the pool was credited
    uint256 quoteOut;   // quote returned by the sell swap (v4 only)
    bytes err;          // revert data of the failed step (first 96 bytes)
}

contract CblProbeRunner {
    uint256 constant MAGIC = 0xCB1CB1CB1;
    uint256 constant F_BUY = 1; uint256 constant F_RECEIVE = 2; uint256 constant F_TRANSFER = 3; uint256 constant F_TO_POOL = 4; uint256 constant F_SELL = 5;
    uint160 constant MIN_PRICE = 4295128739 + 1;
    uint160 constant MAX_PRICE = 1461446703485210103287273052203988822378723970342 - 1;
    address constant OTHER = 0x00000000000000000000000000000000cB1c0dE1; // stand-in for a second wallet

    uint8 mode; address pool; address token; bool tokenIs0; uint256 amount; PoolKey key;

    function run(uint8 mode_, address pool_, PoolKey calldata key_, address token_, bool tokenIs0_, uint256 amount_) external {
        mode = mode_; pool = pool_; token = token_; tokenIs0 = tokenIs0_; amount = amount_; key = key_;
        if (mode_ == 4) { IPoolManager(pool_).unlock(""); }
        else if (mode_ == 3) { // buy = quote in, token out. Exact input of `amount` quote.
            bool zeroForOne = !tokenIs0_; // selling quote: quote is token0 when the scanned token is token1
            IV3Pool(pool_).swap(address(this), zeroForOne, int256(amount_), zeroForOne ? MIN_PRICE : MAX_PRICE, hex"01");
        } else { // v2: ask for `amount` tokens out as a flash swap
            IV2Pair(pool_).swap(tokenIs0_ ? amount_ : 0, tokenIs0_ ? 0 : amount_, address(this), hex"01");
        }
        _done(_blank(), 99, ""); // a pool that never called back
    }

    // ---- Uniswap v4 ----
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        Result memory r = _blank();
        IPoolManager pm = IPoolManager(pool);
        bool buyZeroForOne = !tokenIs0;
        r.quoteIn = amount;
        try pm.swap(key, SwapParams(buyZeroForOne, -int256(amount), buyZeroForOne ? MIN_PRICE : MAX_PRICE), "") returns (int256 d) {
            int256 t = tokenIs0 ? int256(int128(d >> 128)) : int256(int128(d));
            if (t <= 0) _done(r, F_BUY, "");
            r.buyOut = uint256(t);
        } catch (bytes memory e) { _done(r, F_BUY, e); }
        uint256 b0 = _bal(address(this));
        try pm.take(token, address(this), r.buyOut) {} catch (bytes memory e) { _done(r, F_RECEIVE, e); }
        r.buyGot = _bal(address(this)) - b0;
        if (r.buyGot == 0) _done(r, F_RECEIVE, "");
        _walletTransfer(r);
        r.sellSent = _bal(address(this));
        pm.sync(token);
        (bool ok, bytes memory e2) = _send(address(pm), r.sellSent);
        if (!ok) _done(r, F_TO_POOL, e2);
        r.sellPaid = pm.settle();
        if (r.sellPaid == 0) _done(r, F_TO_POOL, "");
        try pm.swap(key, SwapParams(!buyZeroForOne, -int256(r.sellPaid), !buyZeroForOne ? MIN_PRICE : MAX_PRICE), "") returns (int256 d) {
            int256 q = tokenIs0 ? int256(int128(d)) : int256(int128(d >> 128));
            if (q <= 0) _done(r, F_SELL, "");
            r.quoteOut = uint256(q);
        } catch (bytes memory e) { _done(r, F_SELL, e); }
        _done(r, 0, "");
        return "";
    }

    // ---- Uniswap v3 / v2 callbacks under any name (uniswapV3SwapCallback, pancakeV3SwapCallback, uniswapV2Call, ...) ----
    fallback() external {
        require(msg.sender == pool && mode != 4, "probe");
        Result memory r = _blank();
        if (mode == 3) {
            (int256 a0, int256 a1) = abi.decode(msg.data[4:68], (int256, int256));
            int256 t = tokenIs0 ? a0 : a1; int256 q = tokenIs0 ? a1 : a0;
            r.quoteIn = q > 0 ? uint256(q) : 0;
            r.buyOut = t < 0 ? uint256(-t) : 0;
        } else r.buyOut = amount;
        r.buyGot = _bal(address(this));
        if (r.buyGot == 0) _done(r, F_RECEIVE, "");
        _walletTransfer(r);
        r.sellSent = _bal(address(this));
        uint256 p0 = _bal(pool);
        (bool ok, bytes memory e) = _send(pool, r.sellSent);
        if (!ok) _done(r, F_TO_POOL, e);
        r.sellPaid = _bal(pool) - p0;
        if (r.sellPaid == 0) _done(r, F_TO_POOL, "");
        _done(r, 0, "");
    }

    function _walletTransfer(Result memory r) internal {
        r.xferSent = r.buyGot / 10;
        if (r.xferSent == 0) return;
        uint256 o0 = _bal(OTHER);
        (bool ok, bytes memory e) = _send(OTHER, r.xferSent);
        if (!ok) _done(r, F_TRANSFER, e);
        r.xferGot = _bal(OTHER) - o0;
    }
    function _bal(address a) internal view returns (uint256 b) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, a));
        if (ok && ret.length >= 32) b = abi.decode(ret, (uint256));
    }
    function _send(address to, uint256 amt) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amt));
        if (ok && ret.length >= 32 && !abi.decode(ret, (bool))) ok = false; // returned false instead of reverting
    }
    function _blank() internal pure returns (Result memory r) { r.magic = MAGIC; }
    function _done(Result memory r, uint256 failAt, bytes memory e) internal pure {
        r.failAt = failAt;
        if (e.length > 96) { assembly { mstore(e, 96) } }
        r.err = e;
        bytes memory out = abi.encode(r);
        assembly { revert(add(out, 32), mload(out)) }
    }
}

contract CblTokenProbe {
    constructor(uint8 mode, address pool, PoolKey memory key, address token, bool tokenIs0, uint256 amount) {
        CblProbeRunner runner = new CblProbeRunner();
        bytes memory out;
        try runner.run(mode, pool, key, token, tokenIs0, amount) {} catch (bytes memory e) { out = e; }
        assembly { return(add(out, 32), mload(out)) } // returned as this call's "code": the scanner reads it, nothing is deployed
    }
}
