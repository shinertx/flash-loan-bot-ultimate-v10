const { ethers } = require("hardhat");
require('dotenv').config();

async function main() {
  const { RPC_URL, WALLET_PRIVATE_KEY, AAVE_LENDING_POOL, DAI_ADDRESS, UNISWAP_ROUTER } = process.env;
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const blockNumber = await provider.getBlockNumber();
  console.log("Connected to RPC. Current block:", blockNumber);

  const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  console.log("Wallet address:", wallet.address);

  const addresses = { AAVE_LENDING_POOL, DAI_ADDRESS, UNISWAP_ROUTER };
  for (const [name, addr] of Object.entries(addresses)) {
    const code = await provider.getCode(addr);
    if (code === "0x") {
      console.error(`No contract code at ${name}:${addr}`);
    } else {
      console.log(`${name}:${addr} is a valid contract`);
    }
  }
}

main().catch(console.error);

