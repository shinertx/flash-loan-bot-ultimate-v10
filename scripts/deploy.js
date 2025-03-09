const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
  const { LENDING_POOL, DAI_ADDRESS, UNISWAP_ROUTER, PROFIT_THRESHOLD, SLIPPAGE_TOLERANCE } = process.env;

  const MegaFlashBot = await ethers.getContractFactory("MegaFlashBot");
  const bot = await MegaFlashBot.deploy(
    LENDING_POOL,
    UNISWAP_ROUTER,
    DAI_ADDRESS,
    PROFIT_THRESHOLD,
    SLIPPAGE_TOLERANCE
  );
  await bot.deployed();
  console.log("MegaFlashBot deployed at:", bot.address);
}

main().catch(console.error);
