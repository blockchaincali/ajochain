// Shows the gas balance of your EVM deployer on Portaldot, and the native (5…)
// addresses that may map to it, so you can move POT from your native wallet.
//
// Usage:  npx hardhat run scripts/evm-funding.js --network portaldot
const crypto = require("crypto");
const hre = require("hardhat");
let blake2b;
try { ({ blake2b } = require("@noble/hashes/blake2b")); } catch { ({ blake2b } = require("@noble/hashes/blake2.js")); }

const { ethers } = hre;

function ss58(pubkey, prefix = 42) {
  const body = Buffer.concat([Buffer.from([prefix]), Buffer.from(pubkey)]);
  const hash = crypto.createHash("blake2b512").update(Buffer.concat([Buffer.from("SS58PRE"), body])).digest();
  return ethers.encodeBase58(Buffer.concat([body, hash.subarray(0, 2)]));
}

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const h160 = Buffer.from(addr.slice(2), "hex");
  const bal = await ethers.provider.getBalance(addr);
  let client = "unknown";
  try { client = await ethers.provider.send("web3_clientVersion", []); } catch {}

  console.log(`RPC client:      ${client}`);
  console.log(`EVM deployer:    ${addr}`);
  console.log(`Gas balance:     ${ethers.formatEther(bal)} POT\n`);

  if (bal > 0n) {
    console.log("You have gas. Run: npm run deploy:portaldot");
    return;
  }

  // Two common ways Substrate chains map an EVM address to a native account.
  const revive = Buffer.concat([h160, Buffer.alloc(12, 0xee)]);              // pallet-revive (Polkadot Hub style)
  const frontier = blake2b(Buffer.concat([Buffer.from("evm:"), h160]), { dkLen: 32 }); // Frontier (hashed mapping)

  console.log("No gas yet. Your EVM account's native mirror is ONE of these:");
  console.log(`  A (revive mapping):   ${ss58(revive)}`);
  console.log(`  B (Frontier mapping): ${ss58(frontier)}`);
  console.log("\nSend a small test amount (e.g. 1 POT) from your 5… wallet to A, re-run this script,");
  console.log("and if the gas balance is still 0, send to B instead.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
