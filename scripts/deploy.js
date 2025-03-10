const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
    const { LENDING_POOL, UNISWAP_ROUTER, DAI_ADDRESS, PROFIT_THRESHOLD, SLIPPAGE_TOLERANCE, CHAINLINK_ORACLE } = process.env;

    const MegaFlashBot = await ethers.getContractFactory("MegaFlashBot");
    const bot = await MegaFlashBot.deploy(
        LENDING_POOL,
        UNISWAP_ROUTER,
        DAI_ADDRESS,
        PROFIT_THRESHOLD,
        SLIPPAGE_TOLERANCE,
        CHAINLINK_ORACLE // Pass the Chainlink oracle address
    );

    await bot.deployed();
    console.log("MegaFlashBot deployed to:", bot.address);

}

main().catch(console.error);
