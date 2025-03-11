const { ethers } = require("hardhat");
const { checkArbitrageOpportunities } = require("./arbitrage_logic");
require('dotenv').config();

async function main() {
    const BOT_ADDRESS = process.env.BOT_ADDRESS;
    if (!BOT_ADDRESS) {
        console.error("BOT_ADDRESS not set in .env");
        process.exit(1);
    }
    const [owner] = await ethers.getSigners();
    const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);
    console.log("Advanced Execution module started. Bot:", BOT_ADDRESS);

    setInterval(async () => {
        try {
            const amountIn = ethers.parseEther("1000"); // Example: 1000 DAI
            const opportunities = await checkArbitrageOpportunities(amountIn);

            if (opportunities.length > 0) {
                // Improved Opportunity Selection: Choose the BEST opportunity
                let bestOpportunity = opportunities[0];
                for (const opportunity of opportunities) {
                    if (opportunity.profit > bestOpportunity.profit) {
                        bestOpportunity = opportunity;
                    }
                }

                console.log("Best arbitrage opportunity found:", bestOpportunity);

                try {
                    let gasEstimate;
                    if (bestOpportunity.type === "TWO_TOKEN") {
                        gasEstimate = await bot.executeFlashLoan.estimateGas(
                            bestOpportunity.amountIn,
                            bestOpportunity.tokenA,
                            bestOpportunity.tokenB,
                            ethers.ZeroAddress,
                            0,
                            process.env.SLIPPAGE_TOLERANCE
                        );
                    } else if (bestOpportunity.type === "THREE_TOKEN") {
                        gasEstimate = await bot.executeFlashLoan.estimateGas(
                            bestOpportunity.amountIn,
                            bestOpportunity.tokenA,
                            bestOpportunity.tokenB,
                            bestOpportunity.tokenC,
                            1,
                            process.env.SLIPPAGE_TOLERANCE
                        );
                    }

					// Add a buffer to the gas estimate
                    const gasLimit = gasEstimate * BigInt(120) / BigInt(100);  // +20% buffer

					//If we get here, it means gas estimation didn't revert, proceed
					let tx;
					if (bestOpportunity.type === "TWO_TOKEN") {
                        tx = await bot.executeFlashLoan(
                            bestOpportunity.amountIn,
                            bestOpportunity.tokenA,
                            bestOpportunity.tokenB,
                            ethers.ZeroAddress,
                            0,
                            process.env.SLIPPAGE_TOLERANCE,
							{ gasLimit }
                        );

                    } else if (bestOpportunity.type === "THREE_TOKEN") {
                        tx = await bot.executeFlashLoan(
                            bestOpportunity.amountIn,
                            bestOpportunity.tokenA,
                            bestOpportunity.tokenB,
                            bestOpportunity.tokenC,
                            1,
                            process.env.SLIPPAGE_TOLERANCE,
							{ gasLimit }
                        );
                    }
                    await tx.wait();
                    console.log("Flash loan executed. Tx:", tx.hash);


                } catch (error) {
                    console.error("Gas estimation or execution failed:", error);
                    // Handle the error (e.g., log it, try a different opportunity, etc.)
                }

            } else {
                console.log("No arbitrage opportunities found.");
            }

        } catch (error) {
            console.error("Advanced Execution Error:", error);
        }
    }, 60000);
}

main().catch(console.error);
