const { ethers } = require("hardhat");
require('dotenv').config();
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");
const axios = require('axios');

async function executeArbitrage(provider, bot, tradeDetails, owner, arbType = 0) {
    console.log("Executing Arbitrage...");
    const { FLASHBOTS_AUTH_KEY, SLIPPAGE_TOLERANCE } = process.env;
    const authSigner = new ethers.Wallet(FLASHBOTS_AUTH_KEY, provider);
    if (!FLASHBOTS_AUTH_KEY) {
        console.log("No Flashbots auth key. Skipping submission.");
        return;
    }
    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, authSigner, "https://relay.flashbots.net");

    let maxFeePerGas, maxPriorityFeePerGas;
    try {
        const gasPriceResponse = await axios.get(process.env.GAS_ORACLE_URL, {
            headers: { 'Authorization': `Bearer ${process.env.BLOCKNATIVE_API_KEY}` }
        });
        maxFeePerGas = ethers.utils.parseUnits(gasPriceResponse.data.fast.maxFeePerGas, 'gwei');
        maxPriorityFeePerGas = ethers.utils.parseUnits(gasPriceResponse.data.fast.maxPriorityFeePerGas, 'gwei');
    } catch (error) {
        console.warn("Blocknative gas oracle failed. Falling back to Etherscan...");
        try {
            const etherscanResponse = await axios.get(`https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${process.env.ETHERSCAN_API_KEY}`);
            maxFeePerGas = ethers.utils.parseUnits(etherscanResponse.data.result.FastGasPrice, 'gwei');
            maxPriorityFeePerGas = ethers.utils.parseUnits("2", "gwei");
        } catch (fallbackError) {
            console.error("Fallback gas oracle failed. Using default values.");
           
