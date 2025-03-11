require('dotenv').config();
require('@nomicfoundation/hardhat-toolbox');

const { RPC_URL, PRIVATE_KEY } = process.env;

module.exports = {
  solidity: "0.8.19",
  networks: {
    sepolia: {
      url: RPC_URL,
      accounts: [PRIVATE_KEY]
    },
    hardhat: {
      forking: {
        // For local mainnet fork, adjust as needed:
        url: RPC_URL,
        blockNumber: 17400000 
      },
      allowUnlimitedContractSize: true
    }
  }
};
