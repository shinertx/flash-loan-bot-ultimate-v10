// arbitrage_logic.js (Updated with Gas Oracle)

const { ethers } = require("hardhat");
const { calculateUniswapV2Output } = require("../utils/arbitrage_utils");
require('dotenv').config();
const axios = require('axios'); // Add axios for HTTP requests

// --- Configuration ---
const UNISWAP_ROUTER_ADDRESS = process.env.UNISWAP_ROUTER;
const DAI_ADDRESS = process.env.DAI_ADDRESS;
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const CHAINLINK_ETH_USD_ADDRESS = process.env.CHAINLINK_ORACLE;
const BOT_ADDRESS = process.env.BOT_ADDRESS;

// --- Interfaces (for easy interaction) ---
const uniswapRouterABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];
const chainlinkABI = [
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

const provider = ethers.provider;

// --- Helper Functions ---
async function getEthUsdPrice() {
    const chainlink = new ethers.Contract(CHAINLINK_ETH_USD_ADDRESS, chainlinkABI, provider);
    const roundData = await chainlink.latestRoundData();
    return roundData.answer;
}

async function getReserves(tokenA, tokenB) {
    const factoryAddress = await (new ethers.Contract(UNISWAP_ROUTER_ADDRESS, ["function factory() external view returns (address)"], provider)).factory();
    const factory = new ethers.Contract(factoryAddress, ["function getPair(address tokenA, address tokenB) external view returns (address)"], provider);

    const pairAddress = await factory.getPair(tokenA, tokenB);
    if (pairAddress === ethers.ZeroAddress) {
        return null;
    }

    const token0 = await pair.token0();
    const reserves = await pair.getReserves();
    return tokenA == token0 ? { reserveA: reserves[0], reserveB: reserves[1] } : { reserveA: reserves[1], reserveB: reserves[0] };
}

// --- Gas Oracle Integration ---
async function getGasPrice() {
    try {
        const response = await axios.get('https://ethgasstation.info/json/ethgasAPI.json');
        const gasData = response.data;
        // Use 'fast' gas price (divided by 10 to convert from Gwei*10 to Gwei)
        return ethers.parseUnits((gasData.fast / 10).toString(), 'gwei');
    } catch (error) {
        console.error("Error fetching gas price:", error);
        // Fallback to provider's gas price
        return (await provider.getFeeData()).gasPrice;
    }
}
// --- Profit Calculation ---

async function calculateTwoTokenProfit(amountIn, tokenA, tokenB) {
    const ethUsdPrice = await getEthUsdPrice();
    const reserves = await getReserves(tokenA, tokenB);
    if (!reserves) {
        return { profit: 0, canTrade: false };
    }

    const amountOut = calculateUniswapV2Output(amountIn, reserves.reserveA, reserves.reserveB);

    // Use Gas Oracle
    const gasPrice = await getGasPrice();
    const gasCost = gasPrice * BigInt(200000); // Still a rough estimate, but uses dynamic price

    let profitInTokenB = amountOut - BigInt(amountIn);
    let profit;
	if(tokenB == DAI_ADDRESS){
		profit = profitInTokenB - gasCost // Subtract gas cost
	}
    else{
		const daiReserves = await getReserves(tokenB, DAI_ADDRESS);
		let amountOutDAI = calculateUniswapV2Output(profitInTokenB, daiReserves.reserveA, daiReserves.reserveB)
		profit = amountOutDAI - gasCost
	}

    const profitThreshold = BigInt(process.env.PROFIT_THRESHOLD);
    const canTrade = profit > profitThreshold;


    return { profit, canTrade, amountOut, gasCost};
}
async function calculateTriangularProfit(amountIn, tokenA, tokenB, tokenC) {
    const ethUsdPrice = await getEthUsdPrice();

    const reservesAB = await getReserves(tokenA, tokenB);
    const reservesBC = await getReserves(tokenB, tokenC);
    const reservesCA = await getReserves(tokenC, tokenA);

    if (!reservesAB || !reservesBC || !reservesCA) {
        return { profit: 0, canTrade: false };
    }

    const amountOutB = calculateUniswapV2Output(amountIn, reservesAB.reserveA, reservesAB.reserveB);
    const amountOutC = calculateUniswapV2Output(amountOutB, reservesBC.reserveB, reservesBC.reserveC);
    const amountOutA = calculateUniswapV2Output(amountOutC, reservesCA.reserveC, reservesCA.reserveA);

    // Use Gas Oracle
    const gasPrice = await getGasPrice();
    const gasCost = gasPrice * BigInt(300000); // Still a rough estimate, but uses dynamic price
    let profitInTokenA = amountOutA - BigInt(amountIn) // Profit before gas
	let profit;
	if(tokenA == DAI_ADDRESS){
		profit = profitInTokenA - gasCost // Subtract gas cost
	}
    else{
		const daiReserves = await getReserves(tokenA, DAI_ADDRESS);
		let amountOutDAI = calculateUniswapV2Output(profitInTokenA, daiReserves.reserveA, daiReserves.reserveB)
		profit = amountOutDAI - gasCost
	}
    const profitThreshold = BigInt(process.env.PROFIT_THRESHOLD);
    const canTrade = profit > profitThreshold;

    return { profit, canTrade, amountOutB, amountOutC, amountOutA, gasCost };
}

// --- Main Arbitrage Logic ---
async function checkArbitrageOpportunities(amountIn) {
    const opportunities = [];
	const tokenPairs = [
		{tokenA:DAI_ADDRESS, tokenB:WETH_ADDRESS},
		{tokenA:DAI_ADDRESS, tokenB:"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"}, //UNI
		{tokenA:WETH_ADDRESS, tokenB:"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"}  //UNI
	]
    // Check two-token arbitrage opportunities
    for (const pair of tokenPairs) {
        const twoTokenResult = await calculateTwoTokenProfit(amountIn, pair.tokenA, pair.tokenB);
        if (twoTokenResult.canTrade) {
            opportunities.push({
                type: "TWO_TOKEN",
                tokenA: pair.tokenA,
                tokenB: pair.tokenB,
                amountIn: amountIn,
				preliminaryProfit: twoTokenResult.profit,
                ...twoTokenResult
            });
        }
		//check reverse
		 const reverseTwoTokenResult = await calculateTwoTokenProfit(amountIn, pair.tokenB, pair.tokenA);
        if (reverseTwoTokenResult.canTrade) {
            opportunities.push({
                type: "TWO_TOKEN",
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
                tokenA: pair.tokenA,
                tokenB: pair.tokenB,
                tokenC: pair.tokenC,
                amountIn: amountIn,
				preliminaryProfit: triangularResult.profit,
                ...triangularResult
            });
        }
    }

    return opportunities;
}

module.exports = { checkArbitrageOpportunities, getEthUsdPrice, getGasPrice};
