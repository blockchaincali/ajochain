// Explains why closeRound (or the Stability Pool) is failing on Mezo testnet.
// Usage:  GROUP=1 npx hardhat run scripts/diagnose-mezo.js --network mezotestnet
// Read-only: it only simulates calls, it never sends a transaction.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "mezotestnet.json"), "utf8"));
  const managerAddr = dep.contracts.AjoManager.address;
  const spAddr = dep.contracts.StabilityPool.address;
  const [me] = await ethers.getSigners();
  const p = ethers.provider;

  const manager = await ethers.getContractAt("AjoManager", managerAddr);
  const sp = await ethers.getContractAt(
    [
      "function withdrawFromSP(uint256)",
      "function getCompoundedMUSDDeposit(address) view returns (uint256)",
      "function getDepositorCollateralGain(address) view returns (uint256)",
    ],
    spAddr
  );

  const id = BigInt(process.env.GROUP || (await manager.groupCount()));
  const g = await manager.getGroup(id);
  const block = await p.getBlock("latest");
  const f = (v) => ethers.formatEther(v);

  console.log(`AjoManager     ${managerAddr}`);
  console.log(`Circle #${id}      "${g.name}"  status=${g.status}  round=${g.currentRound}  earnsYield=${g.earnsYield}`);
  console.log(`Deadline       ${g.roundDeadline}  chain time ${block.timestamp}  (${Number(block.timestamp) - Number(g.roundDeadline)}s past)`);
  console.log(`Pool deposit   ${f(await sp.getCompoundedMUSDDeposit(managerAddr))} MUSD, BTC gain ${f(await sp.getDepositorCollateralGain(managerAddr))}`);
  console.log(`Circle shares  ${f(await manager.groupShares(id))} of ${f(await manager.totalShares())}`);

  const show = (label, e) => {
    const name = e?.revert?.name || e?.errorName;
    const reason = e?.reason || e?.shortMessage || e?.message;
    console.log(`${label.padEnd(14)} FAILS: ${name ? name + " " : ""}${reason}`);
    if (e?.data) console.log(`${"".padEnd(14)} raw revert data: ${e.data}`);
  };

  // 1. The pool withdrawal on its own, as if AjoManager called it.
  try {
    await p.call({ to: spAddr, from: managerAddr, data: sp.interface.encodeFunctionData("withdrawFromSP", [g.contribution]) });
    console.log("Pool withdraw  OK (the Stability Pool would let AjoManager withdraw)");
  } catch (e) {
    show("Pool withdraw", e);
  }

  // 2. closeRound simulated with plenty of gas.
  try {
    await manager.closeRound.staticCall(id, { from: me.address, gasLimit: 5_000_000 });
    console.log("closeRound     OK with a 5,000,000 gas limit");
  } catch (e) {
    show("closeRound", e);
  }

  // 3. Gas estimate (what MetaMask does before showing the popup).
  try {
    const gas = await manager.closeRound.estimateGas(id);
    console.log(`Gas estimate   ${gas}`);
  } catch (e) {
    show("Gas estimate", e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
