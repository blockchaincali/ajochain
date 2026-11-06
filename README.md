# AjoChain on Mezo

**Save in a circle, in a Bitcoin-backed dollar. Your collateral earns BTC while you wait.**

AjoChain runs rotating savings circles (ajo, esusu, adashe) as smart contracts on **Mezo**, saved in **MUSD**, Mezo's stablecoin backed by Bitcoin. Nobody holds the pot, missed payments are covered by collateral, and every clean cycle mints a soulbound savings badge. The new part for Mezo is **Earn while you save**: the collateral each member locks for the whole cycle goes into Mezo's **MUSD Stability Pool**, where it earns BTC from liquidations instead of sitting idle.

- **Track:** Mezo Buildathon 2026, Track 1 (DeFi: yield) with Track 2 reach (savings for people who already use ajo)
- **Chain:** Mezo testnet (chain ID 31611)
- **Origin:** AjoChain started at Portaldot Hacker House 2026 (frozen on branch [`portaldot-final`](../../tree/portaldot-final)). Everything above "Original AjoChain" is new for the Mezo Buildathon.

## Why MUSD

In Nigeria, ajo is how millions of traders and workers save, but the naira loses value between payouts. Saving in MUSD keeps a pot's dollar value from the day you pay in to the day you collect, and it's backed by Bitcoin rather than a bank. Members who hold BTC can borrow MUSD against it on Mezo to join a circle without selling.

## Mezo integration

| What | How |
| --- | --- |
| **MUSD circles** | Contributions, pots and collateral are MUSD (`0x1189…C503` on testnet). MEZO circles (`0x7b7c…0001`) are supported too, without yield. |
| **Collateral earns in the Stability Pool** | When a circle with *Earn while you save* fills, `AjoManager` deposits all members' collateral with `StabilityPool.provideToSP`. The pool absorbs liquidated MUSD debt and pays depositors the BTC behind it. |
| **Shared deposit, fair split** | All circles share one Stability Pool position. A share system (like a vault) tracks each circle's slice of the MUSD deposit, and a per-share BTC accumulator tracks the BTC each circle earned. A circle that joins later doesn't share in earlier liquidations. |
| **Defaults paid from the pool** | If a member misses a round, `closeRound` withdraws their collateral from the pool with `withdrawFromSP`, so the recipient still gets the full pot. |
| **End of cycle** | Members get their MUSD collateral back, pro rata to what they still have locked, and their share of the circle's BTC, which they withdraw with `claimBTC()`. |
| **Pool safety** | Mezo blocks pool withdrawals while a loan is under-collateralized. `closeRound` reverts with `StabilityPoolBusy` and can be retried. The **final payout is never blocked**: refunds are marked pending and anyone can call `finalizeRefunds()` later. If a deposit fails, the circle still starts with idle collateral. |
| **One-click pool unblock** | When Mezo pauses the pool because a loan fell below 110% collateral, the app shows why and offers **Unblock pool**: it finds those troves (`SortedTroves`, `TroveManager.getCurrentICR`, `PriceFeed`) and liquidates them with `TroveManager.batchLiquidateTroves`. The user earns Mezo's liquidation reward, the pool reopens, and the circle's deposit earns the liquidated BTC. `scripts/unblock-pool.js` does the same from the command line. |

```
             ┌─────────────────────────────┐
             │ AjoChain web app (frontend) │  ethers.js + MetaMask, Mezo testnet
             └──────────────┬──────────────┘
                            │
                     ┌──────▼──────┐  mint   ┌──────────┐
   MUSD / MEZO ─────►│ AjoManager  │────────►│ AjoBadge │ soulbound ERC-721
   (join, pay)       │ circles,    │         └──────────┘
                     │ payouts,    │ provideToSP / withdrawFromSP
                     │ share vault │◄───────────────────────────► Mezo MUSD StabilityPool
                     └─────────────┘   BTC gains (native)              (0x1CCA…680e)
```

### Mezo testnet addresses used

| Contract | Address | Source |
| --- | --- | --- |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | mezo.org/docs, mezo-org/musd `deployments/matsnet` |
| StabilityPool | `0x1CCA7E410eE41739792eA0A24e00349Dd247680e` | mezo-org/musd `deployments/matsnet` |
| MEZO | `0x7b7c000000000000000000000000000000000001` | mezod MEZO token precompile |
| AjoManager | *(filled in by `npm run deploy:mezo`)* | |
| AjoBadge | *(filled in by `npm run deploy:mezo`)* | |

## Deploy to Mezo testnet

```bash
npm install
cp .env.example .env               # PRIVATE_KEY of a testnet-only wallet
# 1. Get test BTC for gas: https://faucet.test.mezo.org
# 2. Get MUSD: borrow against test BTC at https://testnet.mezo.org
npm run deploy:mezo                # deploys AjoBadge + AjoManager, writes frontend/config.js
npm run frontend                   # http://localhost:5173
```

## Tests

```bash
npx hardhat test     # original circle logic (no yield)
forge test           # Mezo Stability Pool integration, 11 tests (needs Foundry)
```

`test/forge/AjoManagerMezo.t.sol` runs against `MockStabilityPool`, which mirrors the real pool's behaviour (pulls MUSD with `transferFrom`, pays BTC gains natively, shrinks deposits on liquidation, blocks withdrawals while troves are under-collateralized). It covers: collateral moving into the pool on start, a full cycle with a liquidation (MUSD back + BTC credited + claim), two circles sharing the pool fairly across liquidations, defaults paid out of the pool, `StabilityPoolBusy` retry, final payout while the pool is locked plus `finalizeRefunds`, fallback to idle collateral if the pool refuses a deposit, a total wipe-out of the deposit (circle still completes, BTC paid), MUSD-only yield, and rejecting stray BTC.

---

## Original AjoChain (Portaldot Hacker House)


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

## Roadmap (Mezo)

- **Next (Wave 2 → Dec 2026):** pilot MUSD circles with Lagos market traders; one-click "borrow MUSD against BTC and join" flow using `BorrowerOperations.openTrove`; Telegram reminders before round deadlines.
- **Q1 2027:** Mezo mainnet launch after review; savings badges as a credit signal for Mezo borrowing.
- **Q2 2027:** naira on- and off-ramp to MUSD through ShopSwift's payment rails; bid-based payout order.

## Roadmap (original, Portaldot)

- **Next:** audit and Portaldot mainnet, real stablecoin savings, random or bid-based payout order, pilot circles with Lagos traders.
- **Later:** naira on- and off-ramp, an ink! (WASM) reputation registry readable by EVM apps, cross-chain savings, lender integrations.

## Team

Chisom Caleb Ogueji, Lagos. Technical Lead and Developer at ShopSwift Technologies; technical writer on blockchain since 2021.

## Credits

Built with Hardhat and OpenZeppelin Contracts (MIT). Developed with AI assistance (Claude).
