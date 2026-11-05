// Finds out why Portaldot rejects a deploy, by trying progressively simpler transactions.
// Usage:  npx hardhat run scripts/diagnose.js --network portaldot
const hre = require("hardhat");
const { ethers } = hre;

async function attempt(label, fn) {
  try {
    const out = await fn();
    console.log(`OK    ${label}${out ? `: ${out}` : ""}`);
    return true;
  } catch (e) {
    const msg = e?.error?.message || e?.info?.error?.message || e?.shortMessage || e?.message || String(e);
    const data = e?.error?.data || e?.info?.error?.data || e?.data;
    console.log(`FAIL  ${label}: ${msg}${data ? `  data=${JSON.stringify(data)}` : ""}`);
    return false;
  }
}

async function main() {
  const [me] = await ethers.getSigners();
  const p = ethers.provider;
  const addr = await me.getAddress();

  await attempt("client version", () => p.send("web3_clientVersion", []));
  await attempt("chain id", async () => (await p.getNetwork()).chainId.toString());
  await attempt("balance", async () => ethers.formatEther(await p.getBalance(addr)));
  await attempt("nonce", async () => String(await p.getTransactionCount(addr)));
  await attempt("gas price", async () => (await p.send("eth_gasPrice", [])).toString());
  await attempt("latest block gas limit", async () => (await p.getBlock("latest")).gasLimit.toString());
  await attempt("fee data", async () => JSON.stringify(await p.getFeeData(), (k, v) => (typeof v === "bigint" ? v.toString() : v)));

  // 1. A plain transfer to yourself, legacy (type 0) transaction.
  await attempt("self-transfer, legacy tx", async () => {
    const gasPrice = await p.send("eth_gasPrice", []);
    const tx = await me.sendTransaction({ to: addr, value: 1n, type: 0, gasPrice });
    await tx.wait();
    return tx.hash;
  });

  // 2. Estimate gas for the smallest contract.
  const F = await ethers.getContractFactory("MockUSDT");
  const deployTx = await F.getDeployTransaction();
  console.log(`info  MockUSDT bytecode size: ${(deployTx.data.length - 2) / 2} bytes`);
  let est;
  await attempt("estimate gas for MockUSDT deploy", async () => {
    est = await p.estimateGas({ ...deployTx, from: addr });
    return est.toString();
  });

  // 3. Deploy MockUSDT as a legacy tx with explicit gas.
  await attempt("deploy MockUSDT, legacy tx, explicit gas", async () => {
    const gasPrice = await p.send("eth_gasPrice", []);
    const tx = await me.sendTransaction({ ...deployTx, type: 0, gasPrice, gasLimit: est ? (est * 12n) / 10n : 5_000_000n });
    const r = await tx.wait();
    return `${r.contractAddress} tx ${tx.hash}`;
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
