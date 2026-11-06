// Unblocks Mezo's Stability Pool by liquidating under-collateralized troves.
//
// Mezo's StabilityPool refuses withdrawals while any trove (loan) is below
// 110% collateral (MCR). On testnet such troves can sit unliquidated for a long
// time, which makes AjoChain's closeRound revert with StabilityPoolBusy.
// Liquidating is permissionless, and the liquidator receives Mezo's gas
// compensation (some MUSD + a slice of the BTC collateral).
//
// Usage:
//   npx hardhat run scripts/unblock-pool.js --network mezotestnet          # dry run: list troves
//   LIQUIDATE=1 npx hardhat run scripts/unblock-pool.js --network mezotestnet
const hre = require("hardhat");

// Mezo testnet addresses, from github.com/mezo-org/musd deployments/matsnet.
const TROVE_MANAGER = "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0";
const SORTED_TROVES = "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA";
const PRICE_FEED = "0x86bCF0841622a5dAC14A313a15f96A95421b9366";
const MCR = 11n * 10n ** 17n; // 110%
const MAX_SCAN = 50; // troves to inspect from the bottom of the list
const BATCH = 10; // troves per liquidation transaction

async function main() {
  const { ethers } = hre;
  const [me] = await ethers.getSigners();
  const tm = await ethers.getContractAt(
    [
      "function getCurrentICR(address,uint256) view returns (uint256)",
      "function batchLiquidateTroves(address[])",
    ],
    TROVE_MANAGER
  );
  const sorted = await ethers.getContractAt(
    [
      "function getLast() view returns (address)",
      "function getPrev(address) view returns (address)",
      "function getSize() view returns (uint256)",
    ],
    SORTED_TROVES
  );
  const feed = await ethers.getContractAt(["function fetchPrice() view returns (uint256)"], PRICE_FEED);

  const price = await feed.fetchPrice();
  console.log(`BTC price  $${Number(ethers.formatEther(price)).toLocaleString()}`);
  console.log(`Troves     ${await sorted.getSize()}`);

  // Troves are sorted by collateral ratio, lowest last. Walk up from the bottom.
  const bad = [];
  let cur = await sorted.getLast();
  for (let i = 0; i < MAX_SCAN && cur !== ethers.ZeroAddress; i++) {
    const icr = await tm.getCurrentICR(cur, price);
    if (icr >= MCR) break;
    bad.push(cur);
    console.log(`  ${cur}  ICR ${(Number(ethers.formatEther(icr)) * 100).toFixed(1)}%  < 110%`);
    cur = await sorted.getPrev(cur);
  }

  if (bad.length === 0) {
    console.log("\nNo troves below 110%. The Stability Pool should accept withdrawals now.");
    return;
  }
  console.log(`\n${bad.length} under-collateralized trove(s) are blocking Stability Pool withdrawals.`);
  if (!process.env.LIQUIDATE) {
    console.log("Dry run. Re-run with LIQUIDATE=1 to liquidate them (permissionless; you earn the gas compensation).");
    return;
  }

  for (let i = 0; i < bad.length; i += BATCH) {
    const batch = bad.slice(i, i + BATCH);
    try {
      await tm.batchLiquidateTroves.staticCall(batch);
    } catch (e) {
      console.log(`Batch ${i / BATCH + 1} would fail: ${e.reason || e.shortMessage || e.message}`);
      continue;
    }
    const tx = await tm.batchLiquidateTroves(batch);
    await tx.wait();
    console.log(`Liquidated ${batch.length} trove(s)  tx ${tx.hash}`);
  }
  console.log(`\nDone. Your balance: ${ethers.formatEther(await ethers.provider.getBalance(me.address))} BTC.`);
  console.log("Now run scripts/diagnose-mezo.js again, or press Close round in the app.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
