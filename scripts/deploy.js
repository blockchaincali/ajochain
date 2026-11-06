// Deploys AjoBadge and AjoManager, wires the badge minter, saves addresses and
// transaction hashes to deployments/<network>.json, and points
// frontend/config.js at the new contracts.
//
//   npm run deploy:mezo       Mezo testnet: uses Mezo's real MUSD, MEZO and
//                             MUSD Stability Pool (nothing mocked)
//   npm run deploy:localhost  local node: deploys mock MUSD/MEZO + a mock Stability Pool
//   npm run deploy:portaldot  Portaldot testnet: mock stablecoin, no yield
//
// The script is resumable: re-run it after topping up gas and it skips
// contracts that are already deployed.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

// Mezo testnet ("matsnet", chain 31611). MUSD and StabilityPool are from
// github.com/mezo-org/musd solidity/artifacts/deployments/matsnet; the MUSD
// address matches mezo.org/docs. MEZO is the chain's MEZO token precompile.
const MEZO_TESTNET = {
  MUSD: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  StabilityPool: "0x1CCA7E410eE41739792eA0A24e00349Dd247680e",
  MEZO: "0x7b7c000000000000000000000000000000000001",
};

const NETWORKS = {
  mezotestnet: {
    chainName: "Mezo Testnet",
    nativeSymbol: "BTC",
    explorer: "https://explorer.test.mezo.org",
    gasFaucet: "https://faucet.test.mezo.org",
    musdHelp: "https://testnet.mezo.org",
  },
  portaldot: { chainName: "Portaldot Testnet V3", nativeSymbol: "POT", legacyGas: true },
  localhost: { chainName: "Hardhat Local", nativeSymbol: "ETH", rpcUrl: "http://127.0.0.1:8545" },
  hardhat: { chainName: "Hardhat Local", nativeSymbol: "ETH", rpcUrl: "http://127.0.0.1:8545" },
};

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const me = deployer.address;
  const p = ethers.provider;
  const net = NETWORKS[network.name];
  if (!net) throw new Error(`No deploy profile for network "${network.name}"`);
  const isLocal = network.name === "localhost" || network.name === "hardhat";
  const isMezo = network.name === "mezotestnet";

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  const out = !isLocal && fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { network: network.name, contracts: {} };
  out.network = network.name;
  out.chainId = Number((await p.getNetwork()).chainId);
  out.deployer = me;
  const save = () => fs.writeFileSync(file, JSON.stringify(out, null, 2));

  const fmt = (wei) => Number(ethers.formatEther(wei)).toFixed(6);
  console.log(`Network:  ${network.name} (chainId ${out.chainId})`);
  console.log(`Deployer: ${me}`);
  console.log(`Balance:  ${fmt(await p.getBalance(me))} ${net.nativeSymbol}\n`);

  // Portaldot's eth-rpc proxy needs legacy txs priced at the node's gas price,
  // with an affordability check (see git history for the details).
  const gasPrice = net.legacyGas ? BigInt(await p.send("eth_gasPrice", [])) : undefined;
  async function overridesFor(txRequest, label) {
    if (!net.legacyGas) return {};
    const gasLimit = await p.estimateGas({ ...txRequest, from: me });
    const cost = gasLimit * gasPrice;
    const bal = await p.getBalance(me);
    console.log(`${label.padEnd(16)} needs up to ${fmt(cost)} ${net.nativeSymbol} (balance ${fmt(bal)})`);
    if (cost > bal) {
      save();
      throw new Error(`Not enough ${net.nativeSymbol} for ${label}. Top up and re-run; finished steps are kept.`);
    }
    return { type: 0, gasPrice, gasLimit };
  }

  // key = name in deployments/<network>.json, artifact = contract to deploy.
  async function deploy(key, artifact, args = []) {
    const done = out.contracts[key];
    if (done?.address && (await p.getCode(done.address)) !== "0x") {
      console.log(`${key.padEnd(16)} already at ${done.address}, skipping`);
      return ethers.getContractAt(artifact, done.address);
    }
    const F = await ethers.getContractFactory(artifact);
    const req = await F.getDeployTransaction(...args);
    const c = await F.deploy(...args, await overridesFor(req, key));
    const tx = c.deploymentTransaction();
    await c.waitForDeployment();
    const address = await c.getAddress();
    console.log(`${key.padEnd(16)} ${address}  tx ${tx.hash}`);
    out.contracts[key] = { address, txHash: tx.hash };
    save();
    return c;
  }

  // 1. Tokens and Stability Pool: Mezo's real ones, or mocks.
  let musd, mezo, pool;
  if (isMezo) {
    for (const [k, a] of Object.entries(MEZO_TESTNET)) {
      if ((await p.getCode(a)) === "0x") throw new Error(`${k} not found at ${a} on this network`);
      out.contracts[k] = { address: a, external: true };
    }
    musd = MEZO_TESTNET.MUSD;
    mezo = MEZO_TESTNET.MEZO;
    pool = MEZO_TESTNET.StabilityPool;
    save();
  } else if (isLocal) {
    musd = await (await deploy("MUSD", "MockUSDT")).getAddress();
    mezo = await (await deploy("MEZO", "MockUSDT")).getAddress();
    pool = await (await deploy("StabilityPool", "MockStabilityPool", [musd])).getAddress();
  } else {
    musd = await (await deploy("MockUSDT", "MockUSDT")).getAddress();
    pool = ethers.ZeroAddress; // no Stability Pool: yield off
  }

  // 2. AjoChain.
  const badge = await deploy("AjoBadge", "AjoBadge", [me]);
  const manager = await deploy("AjoManager", "AjoManager", [
    await badge.getAddress(),
    pool === ethers.ZeroAddress ? ethers.ZeroAddress : musd,
    pool,
  ]);

  const managerAddr = await manager.getAddress();
  if ((await badge.minter()).toLowerCase() !== managerAddr.toLowerCase()) {
    const req = await badge.setMinter.populateTransaction(managerAddr);
    const tx = await badge.setMinter(managerAddr, await overridesFor(req, "setMinter"));
    await tx.wait();
    console.log(`setMinter        tx ${tx.hash}`);
    out.setMinterTx = tx.hash;
  } else {
    console.log("setMinter        already done, skipping");
  }
  save();
  console.log(`\nSaved to ${path.relative(process.cwd(), file)}`);

  // 3. Point the frontend at these contracts.
  const tokens = [];
  if (isMezo || isLocal) {
    tokens.push({ symbol: "MUSD", address: musd, yield: true, faucet: isLocal });
    tokens.push({ symbol: "MEZO", address: mezo, yield: false, faucet: isLocal });
  } else {
    tokens.push({ symbol: "aUSD", address: musd, yield: false, faucet: true });
  }
  const frontendConfig = {
    chainId: out.chainId,
    chainName: net.chainName,
    rpcUrl: net.rpcUrl || network.config.url,
    nativeSymbol: net.nativeSymbol,
    explorer: net.explorer || "",
    gasFaucet: net.gasFaucet || "",
    musdHelp: net.musdHelp || "",
    tokens,
    contracts: {
      AjoManager: managerAddr,
      AjoBadge: await badge.getAddress(),
      StabilityPool: pool,
    },
  };
  const cfgFile = path.join(__dirname, "..", "frontend", "config.js");
  fs.writeFileSync(
    cfgFile,
    `// Generated by scripts/deploy.js on ${new Date().toISOString()} (${network.name})\n` +
      `export const CONFIG = ${JSON.stringify(frontendConfig, null, 2)};\n`
  );
  console.log(`Updated ${path.relative(process.cwd(), cfgFile)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
