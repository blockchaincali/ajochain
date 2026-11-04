# AjoChain

Trustless rotating savings groups (ajo / esusu / ROSCA) on **Portaldot Network V3.0**.

Millions of people in Nigeria and across Africa save through ajo: a group pays a fixed amount every round and one member takes the whole pot, in turn, until everyone has been paid. It works, but it runs on trust, and when a collector or member disappears the money goes with them. AjoChain moves the pot into a smart contract that enforces the rules for everyone.

> Built for Portaldot Hacker House 2026 (Ecosystem DApps track). Work in progress.

## How it works

1. **Create** a group: name, token, contribution per round, number of members, round length.
2. **Join** by locking one contribution as collateral. The group starts when the last seat fills.
3. **Contribute** each round. When everyone has paid, the pot goes straight to that round's recipient (join order).
4. **Close a late round**: after the deadline anyone can close it. Missed payments are covered from the defaulter's collateral, so the recipient still gets the full pot.
5. **Complete**: after the final round, collateral is refunded and every member who never defaulted receives a soulbound **AjoBadge** NFT, a portable on-chain savings history that can grow into a credit signal.

## Contracts

| Contract | Standard | Purpose |
| --- | --- | --- |
| `AjoManager` | - | Groups, contributions, payouts, defaults |
| `AjoBadge` | ERC-721 (soulbound) | Completion badges / savings history |
| `MockUSDT` | ERC-20 | Test stablecoin with a public faucet |

## Run locally

```bash
npm install
npx hardhat test
```

## Deploy to Portaldot testnet

```bash
cp .env.example .env   # add a funded testnet private key
npm run deploy:portaldot
```

Addresses and transaction hashes are written to `deployments/portaldot.json`.

- EVM RPC: `https://test-evm-rpc-v3.portaldot.dev`
- Chain ID: `420420777`

## Testnet deployment

_TBD: contract addresses, tx hashes, explorer links._

## Credits

Built with Hardhat and OpenZeppelin Contracts (MIT). Developed with AI assistance (Claude).
