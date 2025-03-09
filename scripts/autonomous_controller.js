const { ethers } = require("hardhat");
const axios = require("axios");
require('dotenv').config();

async function main() {
    const BOT_ADDRESS = process.env.BOT_ADDRESS;
    if (!BOT_ADDRESS) {
        console.error("Please set BOT_ADDRESS in your .env file");
        process.exit(1);
    }
    const [owner] = await ethers.getSigners();
    const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);
    console.log("Autonomous Controller started for MegaFlashBot at", BOT_ADDRESS);

    bot.on("EmergencyStopTriggered", () => {
        console.log("Emergency stop triggered! Operations halted.");
    });
    bot.on("EmergencyStopReleased", () => {
        console.log("Emergency stop released! Resuming operations.");
    });

    setInterval(async () => {
        try {
            const response = await axios.get(process.env.AI_CONTROLLER_URL);
            const prediction = response.data;
            console.log("AI Prediction:", prediction);
            if (prediction.action === "trade") {
                console.log("AI recommends trading. Executing flash loan...");
                const tx = await bot.executeFlashLoan(
                    ethers.utils.parseEther("1000"),
                    process.env.DAI_ADDRESS,
                    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                    ethers.constants.AddressZero,
                    0
                );
                await tx.wait();
                console.log("Flash loan executed.");
            } else {
                console.log("AI recommends waiting.");
            }
        } catch (error) {
            console.error("Autonomous Controller Error:", error);
        }
    }, 60000);
}

main().catch((error) => {
    console.error("Autonomous Controller failed:", error);
    process.exit(1);
});
