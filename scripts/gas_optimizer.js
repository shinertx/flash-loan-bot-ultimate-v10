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
  await bot.executeFlashLoan(
      ethers.utils.parseEther("5000"),
      process.env.DAI_ADDRESS,
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      ethers.constants.AddressZero,
      0,
      process.env.SLIPPAGE_TOLERANCE,
      { maxFeePerGas, maxPriorityFeePerGas }
  );
  console.log("Flash loan executed with EIP-1559 parameters.");
}

main().catch(console.error);
