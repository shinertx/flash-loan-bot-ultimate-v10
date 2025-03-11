const { ethers } = require("hardhat");
const { checkArbitrageOpportunities } = require("./arbitrage_logic");
require('dotenv').config();
const axios = require('axios');

async function main() {
    const BOT_ADDRESS = process.env.BOT_ADDRESS;
    if (!BOT_ADDRESS) {
        console.error("BOT_ADDRESS not set in .env");
        process.exit(1);
    }
    const [owner] = await ethers.getSigners();
    const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);
    console.log("Autonomous Controller started. Bot:", BOT_ADDRESS);

    // Event listeners for safety (optional, but good practice)
    bot.on("CircuitBreakerSet", (status) => {
        console.warn(`Circuit breaker set to: ${status}`);
    });
    bot.on("EmergencySet", (status) => {
        console.warn(`Emergency stop set to: ${status}`);
    });

    // --- Main Loop ---
    setInterval(async () => {
        try {
            // --- 1. Get AI Prediction (Optional - if used) ---
            let aiAction = "wait"; // Default to waiting
            let recommendedSlippageBP = parseInt(process.env.SLIPPAGE_TOLERANCE, 10); // Default from .env

            try {
                const aiResponse = await axios.get(process.env.AI_CONTROLLER_URL + "/predict");
                const aiData = aiResponse.data;
                aiAction = aiData.action; // "trade" or "wait"
                if (aiData.recommended_slippageBP) {
                    recommendedSlippageBP = parseInt(aiData.recommended_slippageBP, 10);
                }
                console.log(`AI Action: ${aiAction}, Recommended Slippage: ${recommendedSlippageBP} BP`);
            } catch (aiError) {
                console.error("AI prediction failed:", aiError.message);
                // Fallback: Don't trade if AI is unavailable.  Or use a default action.
                return; // Exit this iteration of the loop
            }

            // --- 2. Check for Arbitrage Opportunities (if AI allows) ---
            if (aiAction === "trade") {
                const amountIn = ethers.parseEther("1000"); // Example: 1000 DAI
                const opportunities = await checkArbitrageOpportunities(amountIn);

                if (opportunities.length > 0) {
                    // Prioritize opportunities (highest profit)
                    let bestOpportunity = opportunities.reduce((prev, current) => (prev.profit > current.profit) ? prev : current);
                    console.log("Best arbitrage opportunity found:", bestOpportunity);

                    // --- 3. Execute Flash Loan (with gas estimation) ---
                    try {
                        let gasEstimate;
                        let tx;

                        if (bestOpportunity.type === "TWO_TOKEN") {
                            gasEstimate = await bot.executeFlashLoan.estimateGas(
                                bestOpportunity.amountIn,
                                bestOpportunity.tokenA,
                                bestOpportunity.tokenB,
                                ethers.ZeroAddress, // No token2 for two-token
                                0, // ArbitrageType.TWO_TOKEN
                                recommendedSlippageBP, // Use AI-recommended slippage (or default)
                                "0x" // No MEV data for regular arbitrage
                            );

                            tx = await bot.executeFlashLoan(
                                bestOpportunity.amountIn,
                                bestOpportunity.tokenA,
                                bestOpportunity.tokenB,
                                ethers.ZeroAddress,
                                0,
                                recommendedSlippageBP,
                                "0x",
                                { gasLimit: BigInt(Math.floor(Number(gasEstimate) * 1.2)) } // +20% buffer
                            );

                        } else if (bestOpportunity.type === "THREE_TOKEN") {
                            gasEstimate = await bot.executeFlashLoan.estimateGas(
                                bestOpportunity.amountIn,
                                bestOpportunity.tokenA,
                                bestOpportunity.tokenB,
                                bestOpportunity.tokenC, // Use tokenC
                                1, // ArbitrageType.THREE_TOKEN
                                recommendedSlippageBP,
                                "0x"
                            );

                            tx = await bot.executeFlashLoan(
                                bestOpportunity.amountIn,
                                bestOpportunity.tokenA,
                                bestOpportunity.tokenB,
                                bestOpportunity.tokenC,
                                1,
                                recommendedSlippageBP,
                                "0x",
                                { gasLimit: BigInt(Math.floor(Number(gasEstimate) * 1.2)) } // +20% buffer

                            );

                        } else {
                            console.error("Invalid opportunity type");
                            return; // Exit this iteration
                        }

                        const receipt = await tx.wait(); // Wait for transaction confirmation
                        console.log("Flash loan executed. Transaction Hash:", receipt.hash);
                         // Log all events from the transaction (for debugging)
                        for (const log of receipt.logs) {
                            try{
                                const parsedLog = bot.interface.parseLog(log);
                                console.log(`Event: ${parsedLog.name}, Args:`, parsedLog.args);
                            } catch(error) {}

                        }

                    } catch (executionError) {
                        console.error("Gas estimation or flash loan execution failed:", executionError.message);
                        // Handle execution errors (log, potentially blacklist pair/token, etc.)
                        // IMPORTANT:  Consider *not* blacklisting on *every* failure.  Temporary
                        // network congestion or slight miscalculations can cause reverts.  Implement
                        // a more robust error handling strategy (e.g., retry a few times, then
                        // blacklist only after repeated failures).
                    }

                } else {
                    console.log("No arbitrage opportunities found.");
                }
            } else {
                console.log("AI action is wait. Not checking for arbitrage.");
            }

        } catch (error) {
            console.error("Error in main loop:", error);
        }
    }, 60000); // Run every 60 seconds (adjust as needed)
}

main().catch((error) => {
    console.error("Autonomous Controller failed:", error);
    process.exit(1);
});
