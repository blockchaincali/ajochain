// Deploys MockUSDT, AjoBadge and AjoManager, wires the badge minter, and
// saves addresses + transaction hashes to deployments/<network>.json
// (you need these for the DoraHacks submission).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name} (chainId ${network.config.chainId ?? "local"})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(bal)}`);
  if (bal === 0n) throw new Error("Deployer has no gas tokens. Fund it first.");

  const out = { network: network.name, chainId: network.config.chainId, deployer: deployer.address, contracts: {} };

  async function deploy(name, args = []) {
    const c = await ethers.deployContract(name, args);
    const tx = c.deploymentTransaction();
    await c.waitForDeployment();
    const address = await c.getAddress();
    console.log(`${name.padEnd(11)} ${address}  tx ${tx.hash}`);
    out.contracts[name] = { address, txHash: tx.hash };
    return c;
  }

  await deploy("MockUSDT");
  const badge = await deploy("AjoBadge", [deployer.address]);
  const manager = await deploy("AjoManager", [await badge.getAddress()]);

  const tx = await badge.setMinter(await manager.getAddress());
  await tx.wait();
  console.log(`setMinter   tx ${tx.hash}`);
  out.setMinterTx = tx.hash;

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved to ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
