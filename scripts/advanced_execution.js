const { ethers } = require("hardhat");
const axios = require("axios");
require("dotenv").config();

async function main() {
  const BOT_ADDRESS = process.env.BOT_ADDRESS;
  if (!BOT_ADDRESS) {
    console.error("BOT_ADDRESS not set in your .env file");
    process.exit(1);
  }
  const [owner] = await ethers.getSigners();
  const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);
  console.log("Advanced Execution module started for MegaFlashBot at", BOT_ADDRESS);

  setInterval(async () => {
    try {
      const [aiResponse, regimeResponse] = await Promise.all([
        axios.get(process.env.AI_CONTROLLER_URL),
        axios.get("http://localhost:5000/regime")
      ]);
      const aiPrediction = aiResponse.data;
      const regime = regimeResponse.data;
      console.log("AI Prediction:", aiPrediction, "Regime:", regime);

      let flashLoanSize = ethers.utils.parseEther("1000");
      if (regime.regime === 1) {
        flashLoanSize = ethers.utils.parseEther("500");
      }
      if (aiPrediction.action === "trade") {
        console.log("Advanced Execution: Trading with flash loan size:", flashLoanSize.toString());
        const tx = await bot.executeFlashLoan(
            flashLoanSize,
            process.env.DAI_ADDRESS,
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            ethers.constants.AddressZero,
            0
        );
        await tx.wait();
        console.log("Advanced flash loan executed.");
      } else {
        console.log("Advanced Execution: No trade executed.");
      }
    } catch (error) {
      console.error("Advanced Execution Error:", error);
    }
  }, 60000);
}

main().catch((error) => {
  console.error("Advanced Execution failed:", error);
  process.exit(1);
});

