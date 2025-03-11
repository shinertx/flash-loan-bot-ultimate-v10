// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/console.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/IAavePool.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IUniswapV2Factory.sol";
import "./modules/BridgeModule.sol";
import "./modules/MEVModule.sol";
import "./modules/HedgingModule.sol";

// Example aggregator for Uniswap v3 or others
interface IUniV3Like {
    function exactInputSingle(
        bytes calldata params
    ) external payable returns (uint256 amountOut);
}

interface AggregatorV3Interface {
    function latestRoundData() external view returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    );
}

contract MegaFlashBot is IFlashLoanSimpleReceiver, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // Arbitrage & system config
    enum ArbitrageType { TWO_TOKEN, THREE_TOKEN, ADVANCED }
    bool public circuitBreaker;
    bool public emergency;
    uint256 public maxSlippageBP;      // e.g. 100 => 1%, 500 => 5%
    uint256 public profitThreshold;    // Minimum profit in DAI
    address public dai;

    // Main external addresses
    address public lendingPool;        // e.g. AAVE v2/v3
    address public chainlinkOracle;    // e.g. ETH/USD aggregator
    address public uniswapV2Router;    // fallback for standard swaps
    address public uniswapV3Router;    // example for advanced aggregator

    // Modules
    BridgeModule public bridgeModule;
    MEVModule public mevModule;
    HedgingModule public hedgingModule;

    // Blacklist pairs or tokens
    mapping(address => mapping(address => bool)) public blacklistedPairs;

    //--- Events
    event FlashLoanExecuted(address indexed asset, uint256 amount);
    event TradeExecuted(uint256 flashAmount, uint256 profit);
    event RepaymentExecuted(address indexed asset, uint256 totalOwed);
    event BridgeExecuted(address indexed token, uint256 amountBridged);
    event HedgingExecuted(uint256 hedgeSize, uint256 hedgeProfit);
    event NoProfit();
    event CircuitBreakerSet(bool status);
    event EmergencySet(bool status);
    event MEVBundleExecuted(uint256 profit);

    //--- Errors
    error CircuitBreakerActive();
    error EmergencyActive();
    error BlacklistedPair();
    error MaxSlippageExceeded(uint256 requested, uint256 allowed);
    error NoProfitError(uint256 finalAmount, uint256 initialAmount);
    error InsufficientProfit(uint256 required, uint256 actual);
    error InsufficientBalance(uint256 required, uint256 actual);
    error InvalidPath();
    error InvalidArbType();
    error MEVExecutionFailed();

    constructor(
        address _lendingPool,
        address _dai,
        address _chainlinkOracle,
        address _uniswapV2Router,
        address _uniswapV3Router
    ) {
        lendingPool = _lendingPool;
        dai = _dai;
        chainlinkOracle = _chainlinkOracle;
        uniswapV2Router = _uniswapV2Router;
        uniswapV3Router = _uniswapV3Router;
        circuitBreaker = false;
        emergency = false;
        maxSlippageBP = 300;    // 3% default
        profitThreshold = 100 ether;  // default
    }

    // --- Owner Controls ---
    function setCircuitBreaker(bool _status) external onlyOwner {
        circuitBreaker = _status;
        emit CircuitBreakerSet(_status);
    }
    function setEmergency(bool _status) external onlyOwner {
        emergency = _status;
        emit EmergencySet(_status);
    }
    function setMaxSlippageBP(uint256 _bp) external onlyOwner {
        require(_bp <= 5000, "Cannot exceed 50%");
        maxSlippageBP = _bp;
    }
    function setProfitThreshold(uint256 _pt) external onlyOwner {
        profitThreshold = _pt;
    }

    function setBridgeModule(address _bridge) external onlyOwner {
        bridgeModule = BridgeModule(_bridge);
    }
    function setMEVModule(address _mev) external onlyOwner {
        mevModule = MEVModule(_mev);
    }
    function setHedgingModule(address _hedge) external onlyOwner {
        hedgingModule = HedgingModule(_hedge);
    }

    // Blacklisting
    function blacklistPair(address tokenA, address tokenB, bool status) external onlyOwner {
        blacklistedPairs[tokenA][tokenB] = status;
        blacklistedPairs[tokenB][tokenA] = status;
    }
    function isPairBlacklisted(address tokenA, address tokenB) public view returns (bool) {
        return blacklistedPairs[tokenA][tokenB];
    }

    modifier checkBreaker() {
        if(circuitBreaker) revert CircuitBreakerActive();
        if(emergency) revert EmergencyActive();
        _;
    }

    // ============== FLASH LOAN =============
    function executeFlashLoan(
        uint256 amount,                   // flash loan size in DAI
        address token0,
        address token1,
        address token2,                  // used only for triangular or advanced
        ArbitrageType arbType,
        uint256 slippageToleranceBP,
        bytes calldata mevData // For MEV Bundles
    ) external onlyOwner nonReentrant checkBreaker returns (bool) {
        if(slippageToleranceBP > maxSlippageBP) {
            revert MaxSlippageExceeded(slippageToleranceBP, maxSlippageBP);
        }
        // basic blacklist check
        if(isPairBlacklisted(token0, token1)) {
            revert BlacklistedPair();
        }
        // for triangular or advanced, also check token2
        if(arbType != ArbitrageType.TWO_TOKEN && token2 != address(0)) {
            if(isPairBlacklisted(token1, token2)) revert BlacklistedPair();
        }

        bytes memory params = abi.encode(arbType, token0, token1, token2, amount, slippageToleranceBP, mevData);

        // Approve for repayment
        IERC20(dai).safeApprove(lendingPool, 0);
        IERC20(dai).safeApprove(lendingPool, amount);

        IAavePool(lendingPool).flashLoanSimple(address(this), dai, amount, params, 0);
        emit FlashLoanExecuted(dai, amount);
        return true;
    }

    // Callback from AAVE
     function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override nonReentrant checkBreaker returns (bool) {
        require(msg.sender == lendingPool, "Only LendingPool");
        require(asset == dai, "Must be DAI asset");

        (
            ArbitrageType arbType,
            address token0,
            address token1,
            address token2,
            uint256 amountIn,
            uint256 slippageBP,
            bytes memory mevData
        ) = abi.decode(params, (ArbitrageType, address, address, address, uint256, uint256, bytes));

        // --- MEV Execution (if any) ---
        if (mevData.length > 0) {
            MEVModule.Opportunity memory mevOpportunity = abi.decode(mevData, (MEVModule.Opportunity));
            mevModule.executeMEVOpportunity(mevOpportunity);
        }


        // unify advanced arb
        if(arbType == ArbitrageType.TWO_TOKEN) {
            _twoTokenSwap(token0, token1, amountIn, slippageBP);
        } else if(arbType == ArbitrageType.THREE_TOKEN) {
            _triangularSwap(token0, token1, token2, amountIn, slippageBP);
        } else if(arbType == ArbitrageType.ADVANCED) {
            _advancedAggregatorSwap(token0, token1, token2, amountIn, slippageBP);
        } else {
            revert InvalidArbType();
        }

        // after the trades
        uint256 balanceAfter = IERC20(dai).balanceOf(address(this));
        uint256 totalOwed = amount + premium;
        if(balanceAfter < totalOwed) {
            revert InsufficientBalance(totalOwed, balanceAfter);
        }

        uint256 netProfit = balanceAfter - totalOwed;
        if(netProfit < profitThreshold) {
            emit NoProfit();
            revert InsufficientProfit(profitThreshold, netProfit);
        }

        // repay
        IERC20(dai).safeApprove(lendingPool, 0);
        IERC20(dai).safeApprove(lendingPool, totalOwed);
        IERC20(dai).safeTransfer(lendingPool, totalOwed);

        // optional hedge
        if(address(hedgingModule) != address(0)) {
            // e.g. hedge 10% of final profit
            uint256 hedgeAmt = netProfit / 10;
            if(hedgeAmt > 0) {
                uint256 hedgeProfit = hedgingModule.executeHedge(hedgeAmt);
                emit HedgingExecuted(hedgeAmt, hedgeProfit);
            }
        }

        // final profit to owner
        IERC20(dai).safeTransfer(owner(), netProfit);
        emit TradeExecuted(amountIn, netProfit);
        emit RepaymentExecuted(asset, totalOwed);

        // bridging half or all?
        if(address(bridgeModule) != address(0)) {
            // e.g. bridge 50%
            uint256 bridgingAmt = netProfit / 2;
            IERC20(dai).safeApprove(address(bridgeModule), 0);
            IERC20(dai).safeApprove(address(bridgeModule), bridgingAmt);
            bridgeModule.bridgeTokens(dai, bridgingAmt);
            emit BridgeExecuted(dai, bridgingAmt);
        }

        return true;
    }

    // ========== Internal Swap Logic ==========

    function _twoTokenSwap(address t0, address t1, uint256 amountIn, uint256 slipBP) internal {
        // standard uniswap v2 approach
        _validateLiquidity(t0, t1, 1_000e18);
        IERC20(t0).safeApprove(uniswapV2Router, 0);
        IERC20(t0).safeApprove(uniswapV2Router, amountIn);

        address[] memory path = new address[](2);
        path[0] = t0;
        path[1] = t1;

        uint256[] memory out = IUniswapV2Router02(uniswapV2Router).getAmountsOut(amountIn, path);
        uint256 minOut = (out[1] * (10000 - slipBP)) / 10000;


        IUniswapV2Router02(uniswapV2Router).swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            block.timestamp
        );
    }

    function _triangularSwap(address t0, address t1, address t2, uint256 amountIn, uint256 slipBP) internal {
        // step1: t0->t1
        _twoTokenSwap(t0, t1, amountIn, slipBP);
        uint256 t1Bal = IERC20(t1).balanceOf(address(this));
        // step2: t1->t2
        _twoTokenSwap(t1, t2, t1Bal, slipBP);
        uint256 t2Bal = IERC20(t2).balanceOf(address(this));
        // step3: t2->t0
        _twoTokenSwap(t2, t0, t2Bal, slipBP);
    }

    function _advancedAggregatorSwap(
        address t0,
        address t1,
        address t2,
        uint256 amountIn,
        uint256 slipBP
    ) internal {
        // example: partial uniswap v3 approach
        // user can define bridging or aggregator logic

        // 1) partial swap on uniswap v2
        uint256 half = amountIn / 2;
        _twoTokenSwap(t0, t1, half, slipBP);

        // 2) partial swap on uniswap v3
        // we skip multiple hops for brevity
        IERC20(t0).safeApprove(uniswapV3Router, 0);
        IERC20(t0).safeApprove(uniswapV3Router, half);

        // sample v3 exactInputSingle
        // 3000 = fee tier 0.3%
        bytes memory params = abi.encodeWithSelector(
            IUniV3Like.exactInputSingle.selector,
            abi.encode(
                t0,
                t2,
                3000,
                address(this),
                block.timestamp,
                half,
                0,
                0
            )
        );
        (bool success, bytes memory data) = uniswapV3Router.call(params);
        require(success, "V3 aggregator call failed");
    }

    // ========== Helpers ==========
    function _validateLiquidity(address _tokenA, address _tokenB, uint256 minLiquidity) internal view {
        address factory = IUniswapV2Router02(uniswapV2Router).factory();
        address pair = IUniswapV2Factory(factory).getPair(_tokenA, _tokenB);
        require(pair != address(0), "No Pair found");
        // You could also read reserves if you want to revert if < minLiquidity
    }

    // chainlink example
    function getLatestETHUSD() external view returns (int256) {
        (, int256 price,,,) = AggregatorV3Interface(chainlinkOracle).latestRoundData();
        return price;
    }
}
