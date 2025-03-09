// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IFlashLoanSimpleReceiver.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IAavePool.sol";

error InsufficientProfit(uint256 expected, uint256 actual);
error FlashLoanFailed(string reason);
error InsufficientBalance(uint256 required, uint256 available);
error InvalidPath();
error MaxSlippageExceeded();
error CircuitBreakerActive();
error EmergencyStopActive();
error InvalidArbitrageType();
error NoProfit();

// NEW: Define a custom error for low liquidity.
error LowLiquidity(uint256 available, uint256 minRequired);

contract MegaFlashBot is IFlashLoanSimpleReceiver, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable lendingPool;
    address public immutable uniswapV2Router;
    address public immutable dai;

    uint256 public profitThreshold;
    uint256 public maxDailyLoss;
    uint256 public initialBalance;
    bool public circuitBreaker = true;
    bool public emergency = false;
    uint256 public maxSlippage = 50;      // Basis points (50 = 0.5%)
    uint256 public slippageTolerance = 100; // Basis points

    // Market regime: 0 = normal, 1 = high volatility, etc.
    uint256 public marketRegime;

    // --- Events ---
    event EmergencyStopTriggered();
    event EmergencyStopReleased();
    event TradeExecuted(uint256 tradeAmount, uint256 profit);
    event FlashLoanExecuted(address asset, uint256 amount);
    event RepaymentExecuted(address asset, uint256 amount);
    event RegimeUpdated(uint256 newRegime);
    event HedgingExecuted(uint256 hedgeAmount, uint256 profit);
    event ProfitThresholdUpdated(uint256 newThreshold);
    event MaxSlippageUpdated(uint256 maxSlippage);
    event SlippageToleranceUpdated(uint256 slippageTolerance);
    event CircuitBreakerStatus(bool status);

    modifier checkCircuitBreaker() {
        if (!circuitBreaker) revert CircuitBreakerActive();
        _;
    }

    modifier notEmergency() {
        if (emergency) revert EmergencyStopActive();
        _;
    }

    constructor(
        address _lendingPool,
        address _uniswapV2Router,
        address _dai,
        uint256 _profitThreshold,
        uint256 _slippageTolerance
    ) {
        lendingPool = _lendingPool;
        uniswapV2Router = _uniswapV2Router;
        dai = _dai;
        profitThreshold = _profitThreshold;
        slippageTolerance = _slippageTolerance;
        maxDailyLoss = 1000 ether;
        initialBalance = 0;
        marketRegime = 0;
    }

    function setProfitThreshold(uint256 newThreshold) external onlyOwner {
        profitThreshold = newThreshold;
        emit ProfitThresholdUpdated(newThreshold);
    }

    function setMaxSlippage(uint256 _maxSlippage) external onlyOwner {
        maxSlippage = _maxSlippage;
        emit MaxSlippageUpdated(_maxSlippage);
    }

    function setSlippageTolerance(uint256 newSlippageTolerance) external onlyOwner {
        if(newSlippageTolerance > 10000) revert MaxSlippageExceeded();
        slippageTolerance = newSlippageTolerance;
        emit SlippageToleranceUpdated(newSlippageTolerance);
    }

    function setInitialBalance(uint256 bal) external onlyOwner {
        initialBalance = bal;
    }

    function setMaxDailyLoss(uint256 loss) external onlyOwner {
        maxDailyLoss = loss;
    }

    function setMarketRegime(uint256 newRegime) external onlyOwner {
        marketRegime = newRegime;
        emit RegimeUpdated(newRegime);
    }

    function executeHedgeTrade(uint256 hedgeAmount) external onlyOwner notEmergency {
        // Placeholder: implement dynamic hedging logic.
        revert("Not Implemented");
    }

    function toggleCircuitBreaker() external onlyOwner {
        circuitBreaker = !circuitBreaker;
        emit CircuitBreakerStatus(circuitBreaker);
    }

    function triggerEmergencyStop() external onlyOwner {
        emergency = true;
        emit EmergencyStopTriggered();
    }

    function resumeOperation() external onlyOwner {
        emergency = false;
        emit EmergencyStopReleased();
    }

    enum ArbitrageType { TWO_TOKEN, THREE_TOKEN }

    function executeFlashLoan(
        uint256 amount,
        address token0,
        address token1,
        address token2, // For triangular arbitrage; use address(0) for two-token
        ArbitrageType arbType,
        uint256 _slippageTolerance
    ) external onlyOwner nonReentrant checkCircuitBreaker notEmergency returns (bool) {
        // Add slippage validation
        if (_slippageTolerance > maxSlippage) revert MaxSlippageExceeded();

        uint256 finalAmount = amount;
        if (arbType == ArbitrageType.THREE_TOKEN) {
            // Simulate triangular arbitrage expected final amount.
            address[] memory path1 = new address[](2);
            path1[0] = token0;
            path1[1] = token1;
            address[] memory path2 = new address[](2);
            path2[0] = token1;
            path2[1] = token2;
            address[] memory path3 = new address[](2);
            path3[0] = token2;
            path3[1] = token0;
            uint256[] memory amounts1 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amount, path1);
            uint256[] memory amounts2 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amounts1[1], path2);
            uint256[] memory amounts3 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amounts2[1], path3);
            finalAmount = amounts3[1];
        } else {
            // Two-token arbitrage.
            address[] memory path1 = new address[](2);
            path1[0] = token0;
            path1[1] = token1;
            uint256[] memory amounts1 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amount, path1);
            finalAmount = amounts1[1];
        }
        if(finalAmount <= amount) revert NoProfit();
        bytes memory params = abi.encode(arbType, token0, token1, token2, amount, _slippageTolerance);
        IERC20(dai).safeApprove(address(lendingPool), 0);
        IERC20(dai).safeApprove(address(lendingPool), amount);
        IAavePool(lendingPool).flashLoanSimple(address(this), dai, amount, params, 0);
        emit FlashLoanExecuted(dai, amount);
        return true;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata params
    ) external override nonReentrant checkCircuitBreaker notEmergency returns (bool) {
        if(msg.sender != lendingPool) revert FlashLoanFailed("Sender not lending pool");
        if(asset != dai) revert FlashLoanFailed("Asset not dai");

        (ArbitrageType arbType, address token0, address token1, address token2, uint256 amountIn, uint256 _slippageTolerance)
            = abi.decode(params, (ArbitrageType, address, address, address, uint256, uint256));

        uint256 balanceBefore = IERC20(dai).balanceOf(address(this));
        if (arbType == ArbitrageType.TWO_TOKEN) {
            _executeTradeWithSlippage(amountIn, token0, token1, _slippageTolerance);
        } else if (arbType == ArbitrageType.THREE_TOKEN) {
            executeTriangularArbitrage(token0, token1, token2, amountIn, _slippageTolerance);
        } else {
            revert InvalidArbitrageType();
        }
        uint256 balanceAfter = IERC20(dai).balanceOf(address(this));
        uint256 totalOwed = amount + premium;
        if (balanceAfter < totalOwed) revert InsufficientBalance(totalOwed, balanceAfter);
        if (balanceAfter < totalOwed + profitThreshold) revert InsufficientProfit(profitThreshold, balanceAfter - totalOwed);
        uint256 profit = balanceAfter - totalOwed;
        IERC20(dai).safeTransfer(owner(), profit);
        IERC20(dai).safeApprove(address(lendingPool), 0);
        IERC20(dai).safeApprove(address(lendingPool), totalOwed);
        emit TradeExecuted(amount, profit);
        emit RepaymentExecuted(asset, totalOwed);
        return true;
    }

    function _executeTradeWithSlippage(
        uint256 amountIn,
        address tokenIn,
        address tokenOut,
        uint256 _slippageTolerance
    ) internal {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        IERC20(tokenIn).safeApprove(address(uniswapV2Router), 0);
        IERC20(tokenIn).safeApprove(address(uniswapV2Router), amountIn);
        uint256[] memory amounts = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amountIn, path);
        uint256 amountOutMin = (amounts[1] * (10000 - _slippageTolerance)) / 10000;
        if (_slippageTolerance > maxSlippage) revert MaxSlippageExceeded();
        IUniswapV2Router02(uniswapV2Router).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            block.timestamp
        );
    }

    function executeTriangularArbitrage(
        address tokenA,
        address tokenB,
        address tokenC,
        uint256 amountIn,
        uint256 _slippageTolerance
    ) public onlyOwner nonReentrant {
        // Add slippage validation
        if (_slippageTolerance > maxSlippage) revert MaxSlippageExceeded();

        address[] memory path1 = new address[](2);
        path1[0] = tokenA;
        path1[1] = tokenB;
        address[] memory path2 = new address[](2);
        path2[0] = tokenB;
        path2[1] = tokenC;
        address[] memory path3 = new address[](2);
        path3[0] = tokenC;
        path3[1] = tokenA;

        uint256[] memory amounts1 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amountIn, path1);
        uint256[] memory amounts2 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amounts1[1], path2);
        uint256[] memory amounts3 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amounts2[1], path3);

        uint256 finalAmount = amounts3[1];
        if(finalAmount <= amountIn) revert NoProfit();

        uint256 amount1OutMin = (amounts1[1] * (10000 - _slippageTolerance)) / 10000;
        uint256 amount2OutMin = (amounts2[1] * (10000 - _slippageTolerance)) / 10000;
        uint256 amount3OutMin = (amounts3[1] * (10000 - _slippageTolerance)) / 10000;

        IERC20(tokenA).safeApprove(address(uniswapV2Router), 0);
        IERC20(tokenA).safeApprove(address(uniswapV2Router), amountIn);
        IUniswapV2Router02(uniswapV2Router).swapExactTokensForTokens(amountIn, amount1OutMin, path1, address(this), block.timestamp);

        IERC20(tokenB).safeApprove(address(uniswapV2Router), 0);
        IERC20(tokenB).safeApprove(address(uniswapV2Router), amounts1[1]);
        IUniswapV2Router02(uniswapV2Router).swapExactTokensForTokens(amounts1[1], amount2OutMin, path2, address(this), block.timestamp);

        IERC20(tokenC).safeApprove(address(uniswapV2Router), 0);
        IERC20(tokenC).safeApprove(address(uniswapV2Router), amounts2[1]);
        IUniswapV2Router02(uniswapV2Router).swapExactTokensForTokens(amounts2[1], amount3OutMin, path3, address(this), block.timestamp);

        uint256 profit = finalAmount - amountIn;
        IERC20(tokenA).transfer(owner(), profit);
        emit TradeExecuted(amountIn, profit);
    }

    receive() external payable {}
}
