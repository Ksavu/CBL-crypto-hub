// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// CBL swap router: native coin <-> token swaps through Uniswap v4 style pool managers (any fork), v3 style pools and
// v2 style pairs, in up to four hops, with a small fee paid in the native coin.
//   buy : native in  -> token out. The fee is taken from the native sent.
//   sell: token in   -> native out. The fee is taken from the native received.
// The router holds nothing between transactions, only ever pulls tokens from the caller of sell(), and accepts
// pool callbacks only from the pool it is calling at that moment.

interface IERC20 { function balanceOf(address) external view returns (uint256); }
interface IWNative { function deposit() external payable; function withdraw(uint256) external; }
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
interface IV2Pair { function getReserves() external view returns (uint112, uint112, uint32); function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external; }

/// One step of a route.
///  kind 4: `pool` is the pool manager; tokenIn/tokenOut are the pool's currencies (address(0) = native); fee, tickSpacing, hooks complete the pool key.
///  kind 3: `pool` is a v3 style pool. kind 2: `pool` is a v2 style pair; `fee` is its swap fee in millionths (0 = 3000 = 0.3%).
///  For kinds 3 and 2 the native coin is used through its wrapper (WNATIVE); the router wraps and unwraps between hops.
struct Hop { uint8 kind; address pool; address tokenIn; address tokenOut; uint24 fee; int24 tickSpacing; address hooks; }

contract CblSwapRouter {
    uint256 public constant MAX_FEE_BPS = 300; // hard cap 3%
    uint160 private constant MIN_PRICE = 4295128739 + 1;
    uint160 private constant MAX_PRICE = 1461446703485210103287273052203988822378723970342 - 1;

    address public immutable WNATIVE;
    address public owner;
    address public feeRecipient;

    uint256 private _lock = 1;   // 2 while a swap is running
    address private _pool;       // the only address allowed to call back right now
    address private _payToken;   // v3: token owed to the pool in its callback
    uint256 private _paid;       // v3: what the callback paid

    event Swap(address indexed user, address indexed token, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee);
    event FeeRecipientChanged(address feeRecipient);
    event OwnerChanged(address owner);

    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    constructor(address wnative, address feeRecipient_) {
        require(wnative != address(0) && feeRecipient_ != address(0), "bad args");
        WNATIVE = wnative; owner = msg.sender; feeRecipient = feeRecipient_;
    }

    /// Native coin arrives only mid-swap: from the wrapper (unwrap) or from a pool manager (take).
    receive() external payable { require(_lock == 2, "no direct deposits"); }

    /// Buy: send native, receive the last hop's tokenOut at `to`. Returns the amount that arrived at `to`.
    function buy(Hop[] calldata hops, uint256 minOut, address to, uint256 deadline, uint256 feeBps) external payable nonReentrant returns (uint256 out) {
        _check(hops, to, deadline, feeBps);
        address token = hops[hops.length - 1].tokenOut;
        require(token != address(0) && token != WNATIVE && msg.value > 0, "bad buy");
        uint256 fee = (msg.value * feeBps) / 10000;
        (uint256 got, address cur) = _run(hops, msg.value - fee, address(0));
        require(cur == token, "path");
        uint256 before = IERC20(token).balanceOf(to);
        _send(token, to, got);
        out = IERC20(token).balanceOf(to) - before;
        require(out >= minOut && out > 0, "slippage");
        if (fee > 0) _sendNative(feeRecipient, fee);
        emit Swap(msg.sender, token, true, msg.value, out, fee);
    }

    /// Sell: pull `amountIn` of the first hop's tokenIn from the caller (needs approval), send native to `to`. Returns the native paid out.
    function sell(Hop[] calldata hops, uint256 amountIn, uint256 minOut, address to, uint256 deadline, uint256 feeBps) external nonReentrant returns (uint256 out) {
        _check(hops, to, deadline, feeBps);
        address token = hops[0].tokenIn;
        require(token != address(0) && token != WNATIVE && amountIn > 0, "bad sell");
        uint256 before = IERC20(token).balanceOf(address(this));
        _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amountIn), "transferFrom");
        uint256 pulled = IERC20(token).balanceOf(address(this)) - before; // what really arrived (transfer taxes)
        (uint256 got, address cur) = _run(hops, pulled, token);
        if (cur == WNATIVE) { IWNative(WNATIVE).withdraw(got); cur = address(0); }
        require(cur == address(0), "path");
        uint256 fee = (got * feeBps) / 10000;
        out = got - fee;
        require(out >= minOut && out > 0, "slippage");
        if (fee > 0) _sendNative(feeRecipient, fee);
        _sendNative(to, out);
        emit Swap(msg.sender, token, false, amountIn, out, fee);
    }

    // ---- route ----
    function _check(Hop[] calldata hops, address to, uint256 deadline, uint256 feeBps) private view {
        require(block.timestamp <= deadline, "expired");
        require(hops.length > 0 && hops.length <= 4 && to != address(0) && feeBps <= MAX_FEE_BPS, "bad args");
    }
    function _run(Hop[] calldata hops, uint256 amt, address cur) private returns (uint256, address) {
        for (uint256 i = 0; i < hops.length; i++) {
            Hop calldata h = hops[i];
            require(h.tokenIn != h.tokenOut && h.pool != address(0), "bad hop");
            if (cur != h.tokenIn) { // native <-> wrapper between hops
                if (cur == address(0) && h.tokenIn == WNATIVE) IWNative(WNATIVE).deposit{value: amt}();
                else if (cur == WNATIVE && h.tokenIn == address(0)) IWNative(WNATIVE).withdraw(amt);
                else revert("path");
            }
            if (h.kind == 4) amt = _v4(h, amt);
            else if (h.kind == 3) amt = _v3(h, amt);
            else if (h.kind == 2) amt = _v2(h, amt);
            else revert("bad hop");
            require(amt > 0, "no output");
            cur = h.tokenOut;
        }
        return (amt, cur);
    }

    // ---- Uniswap v4 style ----
    function _v4(Hop calldata h, uint256 amt) private returns (uint256) {
        _pool = h.pool;
        bytes memory ret = IPoolManager(h.pool).unlock(abi.encode(h, amt));
        _pool = address(0);
        return abi.decode(ret, (uint256));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == _pool && _lock == 2, "callback");
        (Hop memory h, uint256 amt) = abi.decode(data, (Hop, uint256));
        IPoolManager pm = IPoolManager(msg.sender);
        // pay first, then swap exactly what the manager was credited (a taxed token credits less than was sent)
        pm.sync(h.tokenIn);
        uint256 paid;
        if (h.tokenIn == address(0)) paid = pm.settle{value: amt}();
        else { _send(h.tokenIn, msg.sender, amt); paid = pm.settle(); }
        require(paid > 0 && paid <= uint256(type(int256).max), "not credited");
        bool zeroForOne = h.tokenIn < h.tokenOut;
        PoolKey memory key = zeroForOne ? PoolKey(h.tokenIn, h.tokenOut, h.fee, h.tickSpacing, h.hooks) : PoolKey(h.tokenOut, h.tokenIn, h.fee, h.tickSpacing, h.hooks);
        int256 d = pm.swap(key, SwapParams(zeroForOne, -int256(paid), zeroForOne ? MIN_PRICE : MAX_PRICE), "");
        int256 d0 = int256(int128(d >> 128)); int256 d1 = int256(int128(d));
        (int256 spent, int256 bought) = zeroForOne ? (d0, d1) : (d1, d0);
        require(spent == -int256(paid), "partial fill");
        require(bought > 0, "no output");
        uint256 b0 = _bal(h.tokenOut);
        pm.take(h.tokenOut, address(this), uint256(bought));
        return abi.encode(_bal(h.tokenOut) - b0);
    }

    // ---- v3 style: the pool sends the output, then calls back for the input (uniswapV3SwapCallback, pancakeV3SwapCallback, ...) ----
    function _v3(Hop calldata h, uint256 amt) private returns (uint256) {
        require(h.tokenIn != address(0) && h.tokenOut != address(0) && amt <= uint256(type(int256).max), "bad hop");
        bool zeroForOne = h.tokenIn < h.tokenOut;
        uint256 b0 = _bal(h.tokenOut);
        _pool = h.pool; _payToken = h.tokenIn; _paid = 0;
        IV3Pool(h.pool).swap(address(this), zeroForOne, int256(amt), zeroForOne ? MIN_PRICE : MAX_PRICE, "");
        _pool = address(0); _payToken = address(0);
        require(_paid == amt, "partial fill");
        return _bal(h.tokenOut) - b0;
    }
    fallback() external {
        require(msg.sender == _pool && _lock == 2 && _payToken != address(0) && msg.data.length >= 68, "callback");
        (int256 a0, int256 a1) = abi.decode(msg.data[4:68], (int256, int256));
        uint256 owed = a0 > 0 ? uint256(a0) : a1 > 0 ? uint256(a1) : 0;
        require(owed > 0, "callback");
        _paid += owed;
        _send(_payToken, msg.sender, owed);
    }

    // ---- v2 style ----
    function _v2(Hop calldata h, uint256 amt) private returns (uint256) {
        require(h.tokenIn != address(0) && h.tokenOut != address(0) && h.fee < 1000000, "bad hop");
        bool inIs0 = h.tokenIn < h.tokenOut;
        (uint112 r0, uint112 r1, ) = IV2Pair(h.pool).getReserves();
        (uint256 rIn, uint256 rOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        _send(h.tokenIn, h.pool, amt);
        uint256 actualIn = IERC20(h.tokenIn).balanceOf(h.pool) - rIn; // what the pair really received
        uint256 keep = 1000000 - (h.fee == 0 ? 3000 : h.fee);
        uint256 out = (actualIn * keep * rOut) / (rIn * 1000000 + actualIn * keep);
        uint256 b0 = _bal(h.tokenOut);
        IV2Pair(h.pool).swap(inIs0 ? 0 : out, inIs0 ? out : 0, address(this), "");
        return _bal(h.tokenOut) - b0;
    }

    // ---- helpers ----
    function _bal(address currency) private view returns (uint256) { return currency == address(0) ? address(this).balance : IERC20(currency).balanceOf(address(this)); }
    function _send(address token, address to, uint256 amount) private { _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount), "transfer"); }
    function _call(address token, bytes memory data, string memory what) private {
        require(token.code.length > 0, "not a token");
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) { if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } } revert(what); }
        require(ret.length == 0 || abi.decode(ret, (bool)), what);
    }
    function _sendNative(address to, uint256 amount) private { (bool ok, ) = payable(to).call{value: amount}(""); require(ok, "native send"); }

    // ---- owner ----
    function setFeeRecipient(address a) external onlyOwner { require(a != address(0), "zero"); feeRecipient = a; emit FeeRecipientChanged(a); }
    function setOwner(address a) external onlyOwner { require(a != address(0), "zero"); owner = a; emit OwnerChanged(a); }
    /// Recover anything left behind (dust, tokens sent by mistake). The router never holds user funds between transactions.
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) _sendNative(to, amount); else _send(token, to, amount);
    }
}
