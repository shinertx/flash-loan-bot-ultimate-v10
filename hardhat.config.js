require('dotenv').config();
require('@nomicfoundation/hardhat-toolbox');

const { RPC_URL, WALLET_PRIVATE_KEY } = process.env;

module.exports = {
  solidity: "0.8.19",
  networks: {
    sepolia: {
      url: RPC_URL,
      accounts: [WALLET_PRIVATE_KEY]
    },
    hardhat: {
      forking: {
        url: RPC_URL,
        blockNumber: 17400000
      },
      allowUnlimitedContractSize: true
    }
  }
};

