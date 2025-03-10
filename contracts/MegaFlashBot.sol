// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IFlashLoanSimpleReceiver.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IAavePool.sol";
import "./interfaces/IUniswapV2Factory.sol"; // Add for factory
import "./interfaces/IUniswapV2Pair.sol";   // Add for pair

// Chainlink AggregatorV3Interface
interface AggregatorV3Interface {
  function latestRoundData()
    external
    view
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    );
}

error InsufficientProfit(uint256 expected, uint256 actual);
error FlashLoanFailed(string reason);
error InsufficientBalance(uint256 required, uint256 available);
error InvalidPath();
error MaxSlippageExceeded();
error CircuitBreakerActive();
error EmergencyStopActive();
error InvalidArbitrageType();
error NoProfit();
error LowLiquidity(uint256 available, uint256 minRequired); // Added


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

    // NEW: Chainlink price feed
    AggregatorV3Interface internal priceFeed;
    mapping(address => bool) public blacklistedPairs; // Add blacklisting

    // --- Events ---
    event EmergencyStopTriggered();
    event EmergencyStopReleased();
    event TradeExecuted(uint256 tradeAmount, uint256 profit);
    event FlashLoanExecuted(address asset, uint256 amount);
    event RepaymentExecuted(address asset, uint256 amount);
    event RegimeUpdated(uint256 newRegime);
    event HedgingExecuted(uint256 hedgeAmount, uint256 profit); // Placeholder
    event ProfitThresholdUpdated(uint256 newThreshold);
    event MaxSlippageUpdated(uint256 maxSlippage);
    event SlippageToleranceUpdated(uint256 slippageTolerance);
    event CircuitBreakerStatus(bool status);
    event PairBlacklisted(address pairAddress, bool isBlacklisted); // Add event

    modifier checkCircuitBreaker() {
         if(!circuitBreaker) revert CircuitBreakerActive(); // Use custom errors.
        _;
    }

    modifier notEmergency() {
       if(emergency) revert EmergencyStopActive();
        _;
    }

 constructor(
        address _lendingPool,
        address _uniswapV2Router,
        address _dai,
        uint256 _profitThreshold,
        uint256 _slippageTolerance,
        address _chainlinkFeed  // NEW: Chainlink feed address
    ) {
        lendingPool = _lendingPool;
        uniswapV2Router = _uniswapV2Router;
        dai = _dai;
        profitThreshold = _profitThreshold;
        slippageTolerance = _slippageTolerance;
        maxDailyLoss = 1000 ether; // Example: Can lose 1000 DAI
        initialBalance = 0;
        marketRegime = 0; // Default regime.
        priceFeed = AggregatorV3Interface(_chainlinkFeed); // Initialize Chainlink feed
    }

    // --- Control Functions ---
      function setProfitThreshold(uint256 newThreshold) external onlyOwner {
        profitThreshold = newThreshold;
        emit ProfitThresholdUpdated(newThreshold);
    }
     function setPreliminaryProfitThreshold(uint256 _preliminaryProfitThreshold) external onlyOwner {
        preliminaryProfitThreshold = _preliminaryProfitThreshold;
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
    // NEW: Update market regime (e.g., normal, volatile, etc.)
    function setMarketRegime(uint256 newRegime) external onlyOwner {
        marketRegime = newRegime;
        emit RegimeUpdated(newRegime);
    }
    // NEW: Execute a hedging trade to mitigate risk.
    function executeHedgeTrade(uint256 hedgeAmount) external onlyOwner notEmergency {
        // Placeholder: implement dynamic hedging logic.
        // For example, buy a correlated asset or use options.
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

    // NEW: Blacklist a pair (to prevent trading on it)
    function blacklistPair(address _pair, bool _isBlacklisted) external onlyOwner {
        blacklistedPairs[_pair] = _isBlacklisted;
        emit PairBlacklisted(_pair, _isBlacklisted);
    }

    enum ArbitrageType { TWO_TOKEN, THREE_TOKEN }

    function executeFlashLoan(
        uint256 amount,
        address token0,
        address token1,
        address token2,
        ArbitrageType arbType,
        uint256 _slippageTolerance

    ) external onlyOwner nonReentrant checkCircuitBreaker notEmergency returns(bool) {

       // Calculate the expected final amount after trades based on type
        uint256 finalAmount = amount; // Start with the flash loan amount
        if (arbType == ArbitrageType.THREE_TOKEN) {
            address[] memory path1 = new address[](2);
            path1[0] = token0;
            path1[1] = token1;

            address[] memory path2 = new address[](2);
            path2[0] = token1;
            path2[1] = token2;

            address[] memory path3 = new address[](2);
            path3[0] = tokenC;
            path3[1] = tokenA;

            // Calculate expected outputs for triangular arbitrage.
            uint256[] memory amounts1 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amount, path1);
            uint256[] memory amounts2 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amounts1[1], path2);
            uint256[] memory amounts3 = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amounts2[1], path3);
            finalAmount = amounts3[1];

        } else {
           // For two-token arbitrage, calculate the expected final amount
            address[] memory path = new address[](2);
            path[0] = token0;
            path[1] = token1;
            uint256[] memory amounts = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amount, path);
            finalAmount = amounts[1];
        }

        if(finalAmount <= amount) revert NoProfit();
        bytes memory params = abi.encode(arbType, token0, token1, token2, amount, _slippageTolerance);
        // Reset approval before setting it
        IERC20(dai).safeApprove(address(lendingPool), 0);
        IERC20(dai).safeApprove(address(lendingPool), amount);
        IAavePool(lendingPool).flashLoanSimple(address(this), dai, amount, params, 0); // referralCode = 0
        emit FlashLoanExecuted(dai, amount);
        return true; // Explicitly return true
    }


    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /*initiator*/,
        bytes calldata params
    )
        external
        override
        nonReentrant
        checkCircuitBreaker
        notEmergency
        returns (bool)
    {
        require(msg.sender == lendingPool, "Only lendingPool");
        require(asset == dai, "Asset must be DAI");

        (ArbitrageType arbType, address token0, address token1, address token2, uint256 amountIn, uint256 _slippageTolerance)
            = abi.decode(params, (ArbitrageType, address, address, address, uint256, uint256));

        uint256 balanceBefore = IERC20(dai).balanceOf(address(this));

         // OPTIONAL: Validate liquidity for the primary trading pair.
        validateLiquidity(token0, token1, 1000e18);

        // Execute trade based on arbitrage type
        if (arbType == ArbitrageType.TWO_TOKEN) {
            _executeTradeWithSlippage(amountIn, token0, token1, _slippageTolerance);
        } else if (arbType == ArbitrageType.THREE_TOKEN) {
            executeTriangularArbitrage(token0, token1, token2, amountIn, _slippageTolerance);
        } else {
            revert InvalidArbitrageType(); // Use the custom error
        }
        uint256 balanceAfter = IERC20(dai).balanceOf(address(this));
        uint256 totalOwed = amount + premium;

        // Check for sufficient balance after the trade to repay the loan and profit
        if (balanceAfter < totalOwed) revert InsufficientBalance(totalOwed, balanceAfter);
        if (balanceAfter < totalOwed + profitThreshold) revert InsufficientProfit(profitThreshold, balanceAfter - totalOwed);

        // Calculate profit
        uint256 profit = balanceAfter - totalOwed;
        IERC20(dai).safeTransfer(owner(), profit);  // Transfer profit to owner

        // Approve and repay the flash loan
        IERC20(dai).safeApprove(address(lendingPool), 0); // Always set to 0 first
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
     // New: Triangular arbitrage function with slippage control.
    function executeTriangularArbitrage(
        address tokenA,
        address tokenB,
        address tokenC,
        uint256 amountIn,
        uint256 _slippageTolerance
    ) internal {
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
    // NEW: Internal liquidity validation function.
    function validateLiquidity(address tokenA, address tokenB, uint256 minLiquidity) internal view {
        // Get the factory address from the Uniswap router.
        address factory = IUniswapV2Router02(uniswapV2Router).factory();
        // Get the pair address from the factory.
        address pair = IUniswapV2Factory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert InvalidPath();
        // Retrieve reserves from the pair contract.
        (uint112 reserve0, uint112 reserve1, ) = IUniswapV2Pair(pair).getReserves();
        // For simplicity, we check if either reserve is below the minimum liquidity.
        if (reserve0 < minLiquidity || reserve1 < minLiquidity) {
            // Revert with the lower of the two reserve values and the required minimum.
            uint256 available = reserve0 < minLiquidity ? reserve0 : reserve1;
            revert LowLiquidity(available, minLiquidity);
        }
    }

      // NEW: Get the latest ETH/USD price from Chainlink.
    function getChainlinkETHUSD() public view returns (int256) {
        (, int256 price, , , ) = priceFeed.latestRoundData();
        return price;
    }

    receive() external payable {}
}
