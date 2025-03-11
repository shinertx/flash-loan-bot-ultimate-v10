const { ethers } = require("hardhat");
const axios = require('axios'); // For gas price and Chainlink
require('dotenv').config();

// --- Configuration ---
const UNISWAP_ROUTER_ADDRESS = process.env.UNISWAP_V2_ROUTER;
const SUSHISWAP_ROUTER_ADDRESS = process.env.SUSHISWAP_ROUTER; // Add other routers here
const DAI_ADDRESS = process.env.DAI_ADDRESS;
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // Standard WETH address.
const CHAINLINK_ETH_USD_ADDRESS = process.env.CHAINLINK_ORACLE;

// --- ABIs (Minimal for efficiency) ---
const uniswapRouterABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function factory() external view returns (address)" //  Needed to get the factory
];
const uniswapFactoryABI = [
    "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];
const uniswapPairABI = [
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)", //  Need token0
    "function token1() external view returns (address)"  //  Need token1
];
const chainlinkABI = [
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];


// --- Provider ---
const provider = ethers.provider;

// --- Helper Functions ---
async function getEthUsdPrice() {
    const chainlink = new ethers.Contract(CHAINLINK_ETH_USD_ADDRESS, chainlinkABI, provider);
    const roundData = await chainlink.latestRoundData();
    return roundData.answer;
}
//gets the reserves ensuring the ordering is tokenA/tokenB
async function getReserves(tokenA, tokenB, routerAddress) {
    const router = new ethers.Contract(routerAddress, uniswapRouterABI, provider);
    const factoryAddress = await router.factory();
    const factory = new ethers.Contract(factoryAddress, uniswapFactoryABI, provider);
    const pairAddress = await factory.getPair(tokenA, tokenB);

    if (pairAddress === ethers.ZeroAddress) {
        return null; // Pair doesn't exist
    }

    const pair = new ethers.Contract(pairAddress, uniswapPairABI, provider);
    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();


    //Adjust for the token ordering.
    const [reserveA, reserveB] = tokenA == token0 ? [reserve0, reserve1] : [reserve1, reserve0];
    return {reserveA, reserveB};
}

// --- Core Calculation Logic (from utils, but included here for completeness)---

function calculateUniswapV2Output(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = BigInt(amountIn) * 997n;
  const numerator = amountInWithFee * BigInt(reserveOut);
  const denominator = (BigInt(reserveIn) * 1000n) + amountInWithFee;
  return numerator / denominator;
}

function calculateUniswapV2Input(amountOut, reserveIn, reserveOut) {
  const numerator = BigInt(reserveIn) * BigInt(amountOut) * 1000n;
  const denominator = (BigInt(reserveOut) - BigInt(amountOut)) * 997n;
  return (numerator / denominator) + 1n;
}


async function calculateTwoTokenProfit(amountIn, tokenA, tokenB, routerAddress = UNISWAP_ROUTER_ADDRESS) {

    const reserves = await getReserves(tokenA, tokenB, routerAddress);
    if (!reserves) {
        return { profit: 0n, canTrade: false }; // Or throw an error
    }
    const amountOut = calculateUniswapV2Output(amountIn, reserves.reserveA, reserves.reserveB);

    //Get gas price estimate:
    const gasPrice = await provider.getFeeData(); // Use hardhat provider for gas

    let profit;
    if (tokenB.toLowerCase() == DAI_ADDRESS.toLowerCase()){
      profit = amountOut - BigInt(amountIn) - (gasPrice.gasPrice * BigInt(200000) );
    }
     // Convert profit back to DAI if necessary
    else{
      const daiReserves = await getReserves(tokenB, DAI_ADDRESS, UNISWAP_ROUTER_ADDRESS);
      if(!daiReserves){
          return { profit: 0n, canTrade: false }; // Can't do the conversion
      }
      const daiAmount = calculateUniswapV2Output(amountOut, daiReserves.reserveA, daiReserves.reserveB);
      profit = daiAmount - BigInt(amountIn) - (gasPrice.gasPrice * BigInt(200000));
    }

    const profitThreshold = BigInt(process.env.PROFIT_THRESHOLD);
    const canTrade = profit > profitThreshold;

    return { profit, canTrade, amountOut, gasCost: gasPrice.gasPrice * BigInt(200000) };
}
//Updated to calculate the reserves correctly. 
async function calculateTriangularProfit(amountIn, tokenA, tokenB, tokenC, routerAddress = UNISWAP_ROUTER_ADDRESS) {
    const reservesAB = await getReserves(tokenA, tokenB, routerAddress);
    const reservesBC = await getReserves(tokenB, tokenC, routerAddress);
    const reservesCA = await getReserves(tokenC, tokenA, routerAddress);

    if (!reservesAB || !reservesBC || !reservesCA) {
        return { profit: 0n, canTrade: false };
    }

    const amountOutB = calculateUniswapV2Output(amountIn, reservesAB.reserveA, reservesAB.reserveB);
    const amountOutC = calculateUniswapV2Output(amountOutB, reservesBC.reserveA, reservesBC.reserveB);
    const amountOutA = calculateUniswapV2Output(amountOutC, reservesCA.reserveA, reservesCA.reserveB);

    const gasPrice = await provider.getFeeData();
    const gasCost = gasPrice.gasPrice * BigInt(300000); // Estimate

    let profit = amountOutA - BigInt(amountIn);
    // Convert profit back to DAI if necessary
   if (tokenA.toLowerCase() != DAI_ADDRESS.toLowerCase()){
        const daiReserves = await getReserves(tokenA, DAI_ADDRESS, UNISWAP_ROUTER_ADDRESS);
        if(!daiReserves){
            return { profit: 0n, canTrade: false };
        }
        const daiAmount = calculateUniswapV2Output(profit, daiReserves.reserveA, daiReserves.reserveB);
        profit = daiAmount - gasCost;
    }
    else {
        profit -= gasCost;
    }
    const profitThreshold = BigInt(process.env.PROFIT_THRESHOLD);
    const canTrade = profit > profitThreshold;

    return { profit, canTrade, amountOutB, amountOutC, amountOutA, gasCost };
}

// --- Main Function ---

async function checkArbitrageOpportunities(amountIn) {
    const opportunities = [];
		const tokenPairs = [
		{tokenA:DAI_ADDRESS, tokenB:WETH_ADDRESS},
		{tokenA:DAI_ADDRESS, tokenB:"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"}, //UNI
		{tokenA:WETH_ADDRESS, tokenB:"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"}  //UNI
	]

    // Two-token arbitrage (Uniswap V2 and Sushiswap).
    for (const pair of tokenPairs) {
        const uniswapResult = await calculateTwoTokenProfit(amountIn, pair.tokenA, pair.tokenB, UNISWAP_ROUTER_ADDRESS);
        if (uniswapResult.canTrade) {
            opportunities.push({
                type: "TWO_TOKEN",
                router: UNISWAP_ROUTER_ADDRESS,
                tokenA: pair.tokenA,
                tokenB: pair.tokenB,
                amountIn: amountIn,
                profit: uniswapResult.profit,
                ...uniswapResult,
            });
        }
         //check reverse
		 const reverseTwoTokenResult = await calculateTwoTokenProfit(amountIn, pair.tokenB, pair.tokenA);
         if (reverseTwoTokenResult.canTrade) {
             opportunities.push({
                 type: "TWO_TOKEN",
                 router: UNISWAP_ROUTER_ADDRESS,
                 tokenA: pair.tokenB,
                 tokenB: pair.tokenA,
                 amountIn: amountIn,
                 preliminaryProfit: reverseTwoTokenResult.profit,
                 ...reverseTwoTokenResult
             });
         }
     }
		// Check triangular arbitrage opportunities (example with DAI, WETH, and UNI)
		const triangularPairs = [
			{tokenA:DAI_ADDRESS, tokenB:WETH_ADDRESS, tokenC:"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"}, //UNI
		]
    for (const pair of triangularPairs) {
        const triangularResult = await calculateTriangularProfit(amountIn, pair.tokenA, pair.tokenB, pair.tokenC);
        if (triangularResult.canTrade) {
            opportunities.push({
                type: "THREE_TOKEN",
                router: UNISWAP_ROUTER_ADDRESS,
                tokenA: pair.tokenA,
                tokenB: pair.tokenB,
                tokenC: pair.tokenC,
                amountIn: amountIn,
				preliminaryProfit: triangularResult.profit,
                ...triangularResult
            });
        }
    }
    // TODO: Add checks for other DEXes (Sushiswap, etc.) using the same pattern.

    return opportunities;
}
//Make sure we export the getGasPrice
module.exports = { checkArbitrageOpportunities, getEthUsdPrice, getGasPrice};
