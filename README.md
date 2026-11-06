# AjoChain

**Save in a circle. The contract holds the pot.**

AjoChain runs rotating savings circles (ajo, esusu, adashe) as smart contracts on **Portaldot Network V3**. Nobody holds the pot, missed payments are covered by collateral, and every clean cycle mints a soulbound savings badge.

- **Live dApp:** https://ajochain-five.vercel.app
- **Demo video:** https://youtu.be/m2BIaAypfYw
- **Pitch deck:** https://github.com/blockchaincali/ajochain/blob/main/docs/AjoChain-pitch-deck.pdf
- **Track:** Portaldot Hacker House 2026, Ecosystem DApps

## The problem

Informal savings circles are mainstream in Nigeria, but they run on trust:

- **The collector disappears.** One person holds everyone's money between rounds.
- **Early receivers stop paying.** A member who already took the pot has little reason to keep paying.
- **Good savers leave no trace.** Years of on-time payments never become a record anyone can check.

## How AjoChain works

1. **Create** a circle: contribution per round, number of members (2–20), round length.
2. **Join** by locking one contribution as collateral. The circle starts when the last seat fills. Payout order is join order.
3. **Pay** each round. When the last member pays, the full pot goes straight to that round's recipient.
4. **Close late rounds.** After the deadline anyone can close the round; a late member's collateral covers their payment, so the recipient still gets a full pot, and the late member is marked as having missed a round.
5. **Earn a badge.** After the final round, collateral is refunded and every member who never missed a round receives a soulbound **AjoBadge** (ERC-721) recording the cycle.

```
            ┌──────────────────────────┐
            │  AjoChain web app        │  frontend/ (static, ethers.js + MetaMask)
            └────────────┬─────────────┘
                         │ JSON-RPC (EVM)
   ┌─────────────────────┼──────────────────────┐
   ▼                     ▼                      ▼
┌──────────┐      ┌──────────────┐       ┌──────────────┐
│ MockUSDT │◄─────│  AjoManager  │──────►│   AjoBadge   │
│  ERC-20  │ pull │ circles,     │ mint  │ ERC-721,     │
│  (aUSD)  │ /pay │ payouts,     │       │ soulbound    │
└──────────┘      │ defaults     │       └──────────────┘
                  └──────────────┘
          Portaldot Network V3, EVM layer (chain ID 420420777)
```

## Contracts

| Contract | Standard | Purpose |
| --- | --- | --- |
| `AjoManager` | – | Circles, contributions, payouts, collateral and defaults |
| `AjoBadge` | ERC-721 (soulbound) | Completion badges: an on-chain savings record |
| `MockUSDT` (aUSD) | ERC-20 | Test stablecoin with a public faucet (1,000 aUSD per claim) |

## Portaldot testnet deployment

| Contract | Address | Deploy tx |
| --- | --- | --- |
| MockUSDT (aUSD) | `0x3Ce64f4776E26c4A930d1fdfCeD1acfBec5cC551` | `0x96eb3ed2cea77fa6fb81b625f43ce03f55e8306945bad597b0a51ab8363ce2c7` |
| AjoBadge | `0x9a4720B2B3D607EE9c382Ec1369cb748236E535c` | `0x4ebde3382bd324c90a5b0596477832c2151c20903e4e72d2d48d8ca99327887f` |
| AjoManager | `0xD9f1Fb1D6f634696763A345890F32C50603B653A` | `0xccf1708166ead6367367492c6979f62ac4ed82f65bde711bf9c0b3ad0cdcce27` |

AjoManager is authorised as the badge minter (setMinter tx `0x636f3b5a800a5889ba28dc68978a9026c0d4acb0ebe267bea40e5835517b9827`). The live dApp at https://ajochain-five.vercel.app points at these contracts. The full record is in [`deployments/portaldot.json`](deployments/portaldot.json).

- EVM RPC: `https://test-evm-rpc-v3.portaldot.dev`
- Chain ID: `420420777`
- Node console: https://node-console.portaldot.dev

## Run it locally

```bash
npm install
npx hardhat test            # 8 tests: full cycle, payout timing, defaults, access control
npm run node                # terminal 1: local chain
npm run deploy:localhost    # terminal 2: deploy + write frontend/config.js
npm run frontend            # open http://localhost:5173
```

Import a private key printed by `npm run node` into MetaMask to get local gas.

## Deploy to Portaldot

```bash
cp .env.example .env        # PRIVATE_KEY of a testnet-only MetaMask account
npx hardhat run scripts/evm-funding.js --network portaldot   # gas balance + native mirror address
npm run deploy:portaldot
```

Notes from deploying on V3:

- V3 serves the EVM through `eth-rpc` (pallet-revive). An EVM account `0x…` is funded by sending native POT to its mirror account (the 20-byte address followed by 12 `0xEE` bytes, SS58-encoded); `scripts/evm-funding.js` prints it.
- Deploy gas includes the on-chain storage deposit, so contract deploys cost well over 100 POT each. The node rejects any transaction whose `gasLimit × gasPrice` exceeds the balance (`Invalid Transaction`). `scripts/deploy.js` sends legacy transactions at the node's gas price, checks the cost before each step, and resumes where it stopped.

## Tests

`test/AjoManager.test.js` covers: circle start on the last join, rejected joins, a full cycle (everyone paid once, collateral refunded, badges minted), instant payout on the last payment, collateral covering a missed round (and no badge for the defaulter), double payments and non-members, soulbound transfers and minter access, and parameter validation.

## Roadmap

- **Next:** audit and Portaldot mainnet, real stablecoin savings, random or bid-based payout order, pilot circles with Lagos traders.
- **Later:** naira on- and off-ramp, an ink! (WASM) reputation registry readable by EVM apps, cross-chain savings, lender integrations.

## Team

Chisom Caleb Ogueji, Lagos. Technical Lead and Developer at ShopSwift Technologies; technical writer on blockchain since 2021.

## Credits

Built with Hardhat and OpenZeppelin Contracts (MIT). Developed with AI assistance (Claude).
