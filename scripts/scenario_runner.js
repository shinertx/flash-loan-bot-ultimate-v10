const fs = require('fs');
const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
  const configYaml = fs.readFileSync("config.yaml", "utf8");
  const testMode = configYaml.includes("test_mode: true") || process.env.TEST_MODE === "true";

  console.log("=== scenario_runner: starting... ===");
  const BOT_ADDRESS = process.env.BOT_ADDRESS || "0xYourMegaFlashBotAddress";
  const [owner] = await ethers.getSigners();
  const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);

  if (testMode) {
    console.log("TEST MODE: Executing small flash loan...");
    await bot.executeFlashLoan(ethers.utils.parseEther("1000"));
  } else {
    console.log("LIVE MODE: Executing mainnet flash loan (start small)...");
    await bot.executeFlashLoan(ethers.utils.parseEther("50000"));
  }

  console.log("Scenario complete.");
}

main().catch(console.error);

