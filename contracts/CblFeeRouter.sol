// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IPancakeRouter {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minOut, address[] calldata path, address to, uint256 deadline) external payable;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256 deadline) external;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256 deadline) external;
}

/// Thin wrapper around PancakeSwap V2 that keeps a small fee.
/// Buys: fee is taken from the input (BNB or stablecoin). Sells: fee is taken from the output (BNB or stablecoin).
/// The contract never holds user funds between transactions.
contract CblFeeRouter {
    IPancakeRouter public immutable router;
    address public owner;
    address public feeRecipient;
    uint256 public feeBps;              // e.g. 50 = 0.5%
    uint256 public constant MAX_FEE_BPS = 300; // hard cap 3%
    uint256 private _lock = 1;

    event FeeChanged(uint256 feeBps);
    event Swap(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 fee);

    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    constructor(address _router, address _feeRecipient, uint256 _feeBps) {
        require(_router != address(0) && _feeRecipient != address(0) && _feeBps <= MAX_FEE_BPS, "bad args");
        router = IPancakeRouter(_router);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    receive() external payable {}

    // ---- buys: BNB or stablecoin in, project token out ----
    function buyWithBNB(address[] calldata path, uint256 minOut, address to, uint256 deadline) external payable nonReentrant {
        require(path.length >= 2 && to != address(0), "bad path");
        uint256 fee = (msg.value * feeBps) / 10000;
        if (fee > 0) _sendBNB(feeRecipient, fee);
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value - fee}(minOut, path, to, deadline);
        emit Swap(msg.sender, address(0), path[path.length - 1], fee);
    }

    function buyWithToken(address[] calldata path, uint256 amountIn, uint256 minOut, address to, uint256 deadline) external nonReentrant {
        require(path.length >= 2 && to != address(0), "bad path");
        IERC20 t = IERC20(path[0]);
        uint256 got = _pull(t, amountIn);
        uint256 fee = (got * feeBps) / 10000;
        if (fee > 0) _safeTransfer(t, feeRecipient, fee);
        _approve(t, got - fee);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(got - fee, minOut, path, to, deadline);
        emit Swap(msg.sender, path[0], path[path.length - 1], fee);
    }

    // ---- sells: project token in, BNB or stablecoin out ----
    function sellForBNB(address[] calldata path, uint256 amountIn, uint256 minOut, address to, uint256 deadline) external nonReentrant {
        require(path.length >= 2 && to != address(0), "bad path");
        IERC20 t = IERC20(path[0]);
        uint256 got = _pull(t, amountIn);
        _approve(t, got);
        uint256 before = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(got, minOut, path, address(this), deadline);
        uint256 out = address(this).balance - before;
        uint256 fee = (out * feeBps) / 10000;
        if (fee > 0) _sendBNB(feeRecipient, fee);
        _sendBNB(to, out - fee);
        emit Swap(msg.sender, path[0], address(0), fee);
    }

    function sellForToken(address[] calldata path, uint256 amountIn, uint256 minOut, address to, uint256 deadline) external nonReentrant {
        require(path.length >= 2 && to != address(0), "bad path");
        IERC20 t = IERC20(path[0]);
        IERC20 o = IERC20(path[path.length - 1]);
        uint256 got = _pull(t, amountIn);
        _approve(t, got);
        uint256 before = o.balanceOf(address(this));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(got, minOut, path, address(this), deadline);
        uint256 out = o.balanceOf(address(this)) - before;
        uint256 fee = (out * feeBps) / 10000;
        if (fee > 0) _safeTransfer(o, feeRecipient, fee);
        _safeTransfer(o, to, out - fee);
        emit Swap(msg.sender, path[0], path[path.length - 1], fee);
    }

    // ---- admin ----
    function setFee(uint256 bps) external onlyOwner { require(bps <= MAX_FEE_BPS, "too high"); feeBps = bps; emit FeeChanged(bps); }
    function setFeeRecipient(address a) external onlyOwner { require(a != address(0), "zero"); feeRecipient = a; }
    function transferOwnership(address a) external onlyOwner { require(a != address(0), "zero"); owner = a; }
    /// Recover anything accidentally sent here.
    function rescue(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) _sendBNB(owner, amount); else _safeTransfer(IERC20(token), owner, amount);
    }

    // ---- internals ----
    function _pull(IERC20 t, uint256 amount) private returns (uint256) {
        uint256 b = t.balanceOf(address(this));
        (bool ok, bytes memory r) = address(t).call(abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, address(this), amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "pull failed");
        return t.balanceOf(address(this)) - b; // handles tokens that take a fee on transfer
    }
    function _approve(IERC20 t, uint256 amount) private {
        (bool ok, bytes memory r) = address(t).call(abi.encodeWithSelector(IERC20.approve.selector, address(router), amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "approve failed");
    }
    function _safeTransfer(IERC20 t, address to, uint256 amount) private {
        (bool ok, bytes memory r) = address(t).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer failed");
    }
    function _sendBNB(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "bnb send failed");
    }
}
