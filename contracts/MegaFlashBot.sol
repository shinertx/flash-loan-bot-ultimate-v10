// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/console.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IAavePool.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./modules/BridgeModule.sol";
import "./modules/MEVModule.sol";
import "./modules/HedgingModule.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

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

contract MegaFlashBot is IFlashLoanSimpleReceiver, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // --- State Variables (Optimized for Gas) ---

    // Use smaller uint types where appropriate
    uint256 public immutable override flashLoanPremium; // Keep this for now
    uint256 public slippageTolerance;     // Maximum slippage (basis points)
    address public lendingPool;             // Aave Lending Pool
    address public uniswapRouter;       // Uniswap V2 Router
		address public dai;
	address public chainlinkOracle;
	// Use a mapping for blacklisted pairs (efficient lookups)
    mapping(address => mapping(address => bool)) public blacklistedPairs;
    bool public circuitBreaker; // Emergency stop
    bool public emergency;
    uint256 public profitThreshold; // Minimum profit threshold

    // --- Events ---
    event FlashLoanExecuted(address token, uint256 amount);
    event TradeExecuted(uint256 amount, uint256 profit);
    event RepaymentExecuted(address token, uint256 amount);
	event BlacklistedPairStatus(address token0, address token1, bool blacklisted);
    event CircuitBreakerStatus(bool status);
    event EmergencyStatus(bool status);
    event SetPreliminaryProfitThreshold(uint256 indexed _preliminaryProfitThreshold); //make events to show changes.
    event SetSlippage(uint256 indexed _slippage);
    event ProfitThreshold(uint256 indexed _profitThreshold);
    // --- Enums ---
    enum ArbitrageType { TWO_TOKEN, THREE_TOKEN }

    // --- Custom Errors ---

    error InvalidArbitrageType();
    error InsufficientBalance(uint256 required, uint256 current);
    error InsufficientProfit(uint256 required, uint256 current);
	error NoProfit();
    error MaxSlippageExceeded();

     // --- Modules ---
    BridgeModule public bridgeModule;
    MEVModule public mevModule;
    HedgingModule public hedgingModule;

    // --- Constructor ---

    constructor(
        address _lendingPool,
        address _uniswapRouter,
				address _dai,
        uint256 _flashLoanPremium,
        uint256 _slippageTolerance,
		address _chainlinkOracle,
        address _owner
    ) {
        lendingPool = _lendingPool;
        uniswapRouter = _uniswapRouter;
				dai = _dai;
        flashLoanPremium = _flashLoanPremium;
        slippageTolerance = _slippageTolerance;
				chainlinkOracle = _chainlinkOracle;
		if(_owner != address(0)){ //to test with no deployer.
		    _transferOwnership(_owner);
		}
    }
		function setProfitThreshold(uint256 _profitThreshold) external onlyOwner {
        profitThreshold = _profitThreshold;
        emit ProfitThreshold(_profitThreshold);
    }

    function setSlippage(uint256 _slippage) external onlyOwner {
        require(_slippage <= 10000, "Max slippage is 100%"); // 10000 basis points = 100%
        slippageTolerance = _slippage;
        emit SetSlippage(_slippage);

    }
    function setCircuitBreaker(bool _status) external onlyOwner {
        circuitBreaker = _status;
         emit CircuitBreakerStatus(_status);
    }

    function setEmergency(bool _status) external onlyOwner {
        emergency = _status;
         emit EmergencyStatus(_status);
    }
    function setBridgeModule(address _bridgeModule) external onlyOwner {
      bridgeModule = BridgeModule(_bridgeModule);
    }

    function setMEVModule(address _mevModule) external onlyOwner {
        mevModule = MEVModule(_mevModule);
    }

    function setHedgingModule(address _hedgingModule) external onlyOwner {
        hedgingModule = HedgingModule(_hedgingModule);
    }
     function blacklistPair(address _pairAddress, bool _isBlacklisted) external onlyOwner {
        // Extract token0 and token1 from the pair contract
        (address token0, address token1) = _getTokensFromPair(_pairAddress);
        blacklistedPairs[token0][token1] = _isBlacklisted;
        blacklistedPairs[token1][token0] = _isBlacklisted; // Ensure both directions are blacklisted

        emit BlacklistedPairStatus(token0, token1, _isBlacklisted);
    }
		//Internal function to handle getting tokens.
		 function _getTokensFromPair(address _pairAddress) internal view returns (address token0, address token1) {
        try IUniswapV2Pair(_pairAddress).token0() returns (address _token0) {
            token0 = _token0;
        } catch {
            revert("Invalid pair address or not a Uniswap V2 pair");
        }

        try IUniswapV2Pair(_pairAddress).token1() returns (address _token1) {
            token1 = _token1;
        } catch {
            revert("Invalid pair address or not a Uniswap V2 pair");
        }
    }
	    // Add a view function to check if a pair is blacklisted
    function isPairBlacklisted(address _token0, address _token1) public view returns (bool) {
        return blacklistedPairs[_token0][_token1] || blacklistedPairs[_token1][_token0];
    }

    // --- Modifiers ---
    modifier checkCircuitBreaker() {
        require(!circuitBreaker, "Circuit breaker is active");
        _;
    }

    modifier notEmergency() {
        require(!emergency, "Emergency is active");
        _;
    }

	 // --- Core Functions ---
		//Use calldata for all external function parameters that are read-only
  function executeFlashLoan(
    uint256 amount,
    address token0,
    address token1,
    address token2, // Only used for THREE_TOKEN
    ArbitrageType arbType,
    uint256 _slippageTolerance
  )
    external
    onlyOwner
    nonReentrant
    checkCircuitBreaker
    notEmergency
    returns (bool)
  {
        require(!isPairBlacklisted(token0, token1), "Blacklisted pair"); //check if its blacklisted
        if (arbType == ArbitrageType.THREE_TOKEN) {
           require(!isPairBlacklisted(token1, token2) && !isPairBlacklisted(token2, token0), "Blacklisted pair"); //check if its blacklisted
         }
        // NO PROFIT CHECK HERE.  This is done off-chain.

        bytes memory params = abi.encode(arbType, token0, token1, token2, amount, _slippageTolerance);

        // Approve the lending pool for flash loan repayment
        IERC20(dai).safeApprove(address(lendingPool), 0);
        IERC20(dai).safeApprove(address(lendingPool), amount);

        // Initiate flash loan
        //estimate gas here to make sure its a valid tx.

        IAavePool(lendingPool).flashLoanSimple(address(this), dai, amount, params, 0);
        emit FlashLoanExecuted(dai, amount);
        return true;
  }


  function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address /*initiator*/,
    bytes calldata params  // Use calldata
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

      // OPTIONAL: Check liquidity for the primary pair
     if (arbType == ArbitrageType.TWO_TOKEN) {
        validateLiquidity(token0, token1, 1000e18); // Example minimum liquidity
     }

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


		 // These checks are still important, but the initial decision is made off-chain
    if (balanceAfter < totalOwed) {
      revert InsufficientBalance(totalOwed, balanceAfter);
    }
    if (balanceAfter < totalOwed + profitThreshold) {
		emit NoProfit(); //emit this for easy tracking.
      revert InsufficientProfit(profitThreshold, balanceAfter - totalOwed);
    }

    uint256 profit = balanceAfter - totalOwed;

    // Transfer profit to owner
    IERC20(dai).safeTransfer(owner(), profit);

    // Repay flash loan
    IERC20(dai).safeApprove(address(lendingPool), 0);
    IERC20(dai).safeApprove(address(lendingPool), totalOwed);

    emit TradeExecuted(amount, profit);
    emit RepaymentExecuted(asset, totalOwed);
    return true;
  }

    // Optimized _executeTradeWithSlippage (using internal, calldata)
    function _executeTradeWithSlippage(
        uint256 amountIn,
        address tokenIn,
        address tokenOut,
        uint256 _slippage
    ) internal {
        // Approve Uniswap to spend tokens
        IERC20(tokenIn).safeApprove(uniswapRouter, 0); //always reset it.
        IERC20(tokenIn).safeApprove(uniswapRouter, amountIn);

        // Calculate minimum amount out with slippage
        uint256 amountOutMin = _calculateAmountOutMin(amountIn, tokenIn, tokenOut, _slippage);

        // Construct path for Uniswap trade (calldata for efficiency)
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        // Execute the trade
        IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this), // Send output to this contract
            block.timestamp // Use current block timestamp as deadline
        );
				IERC20(tokenIn).safeApprove(uniswapRouter, 0); //always reset it.

    }

    // Optimized executeTriangularArbitrage (using internal, calldata)
   function executeTriangularArbitrage(
    address token0,
    address token1,
    address token2,
    uint256 amountIn,
    uint256 _slippageTolerance
) internal {
    // Step 1: token0 -> token1
    IERC20(token0).safeApprove(uniswapRouter, 0);
    IERC20(token0).safeApprove(uniswapRouter, amountIn);
    uint256 amountOutMin1 = _calculateAmountOutMin(amountIn, token0, token1, _slippageTolerance);
    address[] memory path1 = new address[](2);
    path1[0] = token0;
    path1[1] = token1;
    IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(amountIn, amountOutMin1, path1, address(this), block.timestamp);
    uint256 amountOut1 = IERC20(token1).balanceOf(address(this));
	IERC20(token0).safeApprove(uniswapRouter, 0); //always set it back to zero.

    // Step 2: token1 -> token2
	IERC20(token1).safeApprove(uniswapRouter, 0);
    IERC20(token1).safeApprove(uniswapRouter, amountOut1);
    uint256 amountOutMin2 = _calculateAmountOutMin(amountOut1, token1, token2, _slippageTolerance);
    address[] memory path2 = new address[](2);
    path2[0] = token1;
    path2[1] = token2;
    IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(amountOut1, amountOutMin2, path2, address(this), block.timestamp);
    uint256 amountOut2 = IERC20(token2).balanceOf(address(this));
	IERC20(token1).safeApprove(uniswapRouter, 0);

    // Step 3: token2 -> token0
	IERC20(token2).safeApprove(uniswapRouter, 0);
    IERC20(token2).safeApprove(uniswapRouter, amountOut2);
    uint256 amountOutMin3 = _calculateAmountOutMin(amountOut2, token2, token0, _slippageTolerance);
    address[] memory path3 = new address[](2);
    path3[0] = token2;
    path3[1] = token0;
    IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(amountOut2, amountOutMin3, path3, address(this), block.timestamp);
	IERC20(token2).safeApprove(uniswapRouter, 0);

}

    function _calculateAmountOutMin(
        uint256 amountIn,
        address tokenIn,
        address tokenOut,
        uint256 _slippage
    ) internal view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory amounts = IUniswapV2Router02(uniswapRouter).getAmountsOut(amountIn, path);
		//added extra require.
		require(_slippage <= 10000, "_slippage value exceeds maximum (10000)");
        return amounts[1] * (10000 - _slippage) / 10000;
    }

      // Function to validate liquidity (to mitigate sandwich attacks)
    function validateLiquidity(address _token0, address _token1, uint256 _minLiquidity) public view returns (bool) {

        address pair = IUniswapV2Factory(IUniswapV2Router02(uniswapRouter).factory()).getPair(_token0, _token1);

        require(pair != address(0), "Pair does not exist");
        uint256 liquidity = IERC20(_token0).balanceOf(pair);
        if(liquidity < _minLiquidity)
        {
            return false;
        }
        return true;
    }
		 // --- Chainlink Price Feed ---
    function getChainlinkETHUSD() public view returns (int256) {
        (, int256 price, , , ) = AggregatorV3Interface(chainlinkOracle).latestRoundData();
        return price;
    }
}
