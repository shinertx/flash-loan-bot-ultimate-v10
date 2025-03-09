const fs = require('fs');
const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
  const configYaml = fs.readFileSync("config.yaml", "utf8");
  const testMode = configYaml.includes("test_mode: true") || process.env.TEST_MODE === "true";

  console.log("=== Scenario Runner: Starting... ===");
  const BOT_ADDRESS = process.env.BOT_ADDRESS || "0xYourMegaFlashBotAddress";
  const [owner] = await ethers.getSigners();
  const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);

  if (testMode) {
    console.log("TEST MODE: Executing small flash loan...");
    await bot.executeFlashLoan(
      ethers.utils.parseEther("1000"),
      process.env.DAI_ADDRESS,
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      ethers.constants.AddressZero,  // token2 placeholder for two-token arbitrage
      0,                             // arbType: 0 for two-token arbitrage
      process.env.SLIPPAGE_TOLERANCE
    );
  } else {
    console.log("LIVE MODE: Executing mainnet flash loan (start small)...");
    await bot.executeFlashLoan(
      ethers.utils.parseEther("50000"),
      process.env.DAI_ADDRESS,
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      ethers.constants.AddressZero,
      0,
      process.env.SLIPPAGE_TOLERANCE
    );
  }
  console.log("Scenario complete.");
}

main().catch(console.error);
