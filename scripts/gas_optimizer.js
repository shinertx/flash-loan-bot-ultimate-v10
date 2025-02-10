const { ethers } = require("hardhat");

async function main() {
  console.log("=== EIP-1559 Gas Optimizer ===");
  const provider = ethers.provider;
  const block = await provider.getBlock("latest");
  if (!block.baseFeePerGas) {
    console.log("EIP-1559 not supported; skipping gas optimization.");
    return;
  }
  const baseFee = block.baseFeePerGas;
  const maxFeePerGas = baseFee.mul(2);
  const maxPriorityFeePerGas = baseFee.div(10);

  const BOT_ADDRESS = process.env.BOT_ADDRESS || "0xYourMegaFlashBotAddress";
  const [owner] = await ethers.getSigners();
  const bot = await ethers.getContractAt("MegaFlashBot", BOT_ADDRESS, owner);

  console.log("Using maxFeePerGas:", maxFeePerGas.toString(), "and priority fee:", maxPriorityFeePerGas.toString());
  await bot.executeFlashLoan(ethers.utils.parseEther("5000"), { maxFeePerGas, maxPriorityFeePerGas });
  console.log("Flash loan executed with EIP-1559 parameters.");
}

main().catch(console.error);

