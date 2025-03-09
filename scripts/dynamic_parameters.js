const { ethers } = require("hardhat");
const axios = require("axios");
require("dotenv").config();

async function main() {
  const BOT_ADDRESS = process.env.BOT_ADDRESS;
  if (!BOT_ADDRESS) {
    console.error("BOT_ADDRESS not set in .env file");
    process.exit(1);
  }
  const [owner] = await ethers.getSigners();
  const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);
  console.log("Dynamic Parameter Adjustment started for MegaFlashBot at", BOT_ADDRESS);

  setInterval(async () => {
    try {
      const response = await axios.get(process.env.DYNAMIC_PARAMETERS_URL);
      const params = response.data;
      console.log("Parameter recommendations received:", params);

      if (params.profitThreshold && typeof params.profitThreshold === "number") {
        console.log("Updating profitThreshold to:", params.profitThreshold);
        const tx = await bot.setProfitThreshold(params.profitThreshold);
        await tx.wait();
        console.log("profitThreshold updated.");
      }
      if (params.maxDailyLoss && typeof params.maxDailyLoss === "number") {
        console.log("Updating maxDailyLoss to:", params.maxDailyLoss);
        const tx2 = await bot.setMaxDailyLoss(params.maxDailyLoss);
        await tx2.wait();
        console.log("maxDailyLoss updated.");
      }
    } catch (error) {
      console.error("Error in dynamic parameter adjustment:", error);
    }
  }, 300000);
}

main().catch((error) => {
  console.error("Dynamic Parameter Adjustment failed:", error);
  process.exit(1);
});

