require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // "paris" avoids newer opcodes (PUSH0 etc.) that some EVM chains don't support yet.
      evmVersion: "paris",
    },
  },
  networks: {
    // Mezo testnet ("matsnet"). Gas is paid in BTC (18 decimals).
    // Faucet: https://faucet.test.mezo.org  Explorer: https://explorer.test.mezo.org
    mezotestnet: {
      url: process.env.MEZO_TESTNET_RPC_URL || "https://rpc.test.mezo.org",
      chainId: 31611,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    portaldot: {
      url: process.env.PORTALDOT_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev",
      chainId: 420420777,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
