require('dotenv').config();
const { ethers } = require("hardhat");
const axios = require('axios'); // For fetching external data (e.g., volatility)

async function shouldHedge(provider, botAddress) {
    // 1. Get Current Portfolio State (from MegaFlashBot and HedgingModule)
    const bot = await ethers.getContractAt("MegaFlashBot", botAddress, provider);
    const hedgingModuleAddress = await bot.hedgingModule();

    if (hedgingModuleAddress === ethers.ZeroAddress) {
        console.log("Hedging module not set. Skipping hedge check.");
        return { shouldHedge: false, hedgePercentage: 0 }; // No hedging module.
    }
    const hedgingModule = await ethers.getContractAt("HedgingModule", hedgingModuleAddress, provider);

    const daiBalance = await (await ethers.getContractAt("IERC20", process.env.DAI_ADDRESS, provider)).balanceOf(botAddress);
    const wethBalance = await (await ethers.getContractAt("IERC20", process.env.WETH_ADDRESS, provider)).balanceOf(hedgingModuleAddress);

    console.log(`Current Balances: DAI=${ethers.formatUnits(daiBalance, 18)}, WETH=${ethers.formatUnits(wethBalance, 18)}`);

    // 2. Get Market Data (Volatility, Sentiment, etc.) - Placeholder/Example
    //    In a real system, you'd fetch this from reliable sources (e.g.,
    //    volatility indices, sentiment analysis APIs, on-chain data).
    let marketVolatility = 0.05; // Example: 5% volatility (replace with real data)
    let marketSentiment = 0.2;    // Example: Slightly positive (replace)

    // 3. Get AI Recommendation (if using AI) - Placeholder
    let aiRecommendation = "neutral"; //  "buy", "sell", "hold", "neutral"
    try {
        const aiResponse = await axios.get(process.env.AI_CONTROLLER_URL + "/predict");
        aiRecommendation = aiResponse.data.action; //  Or a more specific recommendation
    } catch (error) {
        console.error("Error fetching AI prediction:", error.message);
        // Fallback to a default action if AI is unavailable
    }

     // **Hedging Strategy Logic (VERY Simplified Example):**
    // This is where you implement your actual hedging logic.  This is just
    // a *basic demonstration* to show how the different pieces fit together.
    // A real hedging strategy would be *far* more complex.

    let hedgePercentage = 0;

    if (marketVolatility > 0.10) { // High volatility
        hedgePercentage = 20;  // Hedge 20% of DAI into WETH
    } else if (marketSentiment < -0.5) {  // Very negative sentiment
        hedgePercentage = 30;  // Hedge 30%
    } else if (aiRecommendation === "sell") {
        hedgePercentage = 50;
    }

    // Don't hedge more than the available balance.
    const daiBalanceBigInt = BigInt(daiBalance.toString());
    if( (daiBalanceBigInt * BigInt(hedgePercentage) / BigInt(100)) > daiBalanceBigInt) {
        hedgePercentage = 100;
    }

    console.log(`Hedging decision: Hedge ${hedgePercentage}% of DAI into WETH`);
    return { shouldHedge: hedgePercentage > 0, hedgePercentage };
}

module.exports = { shouldHedge };
