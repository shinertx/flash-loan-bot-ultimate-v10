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

    const pair = new ethers.Contract(pairAddress, ["function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function token0() external view returns (address)"], provider);
    const token0 = await pair.
