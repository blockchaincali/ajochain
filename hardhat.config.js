require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // "paris" avoids newer opcodes (PUSH0 etc.) that some Substrate EVMs don't support yet.
      evmVersion: "paris",
    },
  },
  networks: {
    portaldot: {
      url: process.env.PORTALDOT_RPC_URL || "https://test-evm-rpc-v3.portaldot.dev",
      chainId: 420420777,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
