# AGENTS.md — Cofhe Vault Protocol

## Project Overview

A privacy-preserving yield aggregator protocol inspired by [Octant](https://docs.v2.octant.build/docs/developers/introduction/core-concepts), built on **Fhenix (FHE)**. Users deposit ERC-20 tokens into vaults that allocate capital across yield strategies (e.g., Aave V3). Strategy weights are **encrypted** via FHE, and yield is routed to recipients via fixed or voting-based allocation mechanisms.

## Architecture

```
VaultFactory
  ├── PrivateComposableVault (ERC-4626) — user deposits/withdraws, holds strategies
  ├── EncryptedStrategyRegistry — encrypted weights, active flags, debt per strategy
  ├── PrivateRebalancer — encrypted drift thresholds, automated rebalancing
  ├── YieldRouter — routes yield (donation shares) to allocation recipients
  ├── SelectiveDisclosureModule — time-bound auditor access + decryption
  └── AllocationMechanism (Fixed or Voting) — determines yield distribution
        └── VaultRegistry — tracks all deployed vaults
```

### Core Contracts

| Contract | Purpose |
|---|---|
| `PrivateComposableVault` | ERC-4626 vault with encrypted creator fee, strategy management, profit/loss handling via donation shares |
| `EncryptedStrategyRegistry` | Stores strategies with encrypted weights (`euint16`), encrypted active flags (`ebool`), encrypted debt (`euint128`) |
| `PrivateRebalancer` | Per-vault config with encrypted drift threshold and min time between rebalances; keeper triggers rebalance |
| `YieldRouter` | Mints donation shares to yield router on profit; distributes shares across recipients by allocation weights |
| `SelectiveDisclosureModule` | Grants time-bound auditor access to encrypted data; decryption request/publish/retrieve flow |
| `VaultFactory` | Single-call deployment of all vault components |
| `VaultRegistry` | Registry of all vaults with metadata |
| `AllocationMechanismFactory` | Deploys Fixed or Voting allocation mechanisms |
| `FixedAllocationMechanism` | Static recipient addresses + weights |
| `VotingAllocationMechanism` | Quadratic voting (sqrt balance) with epochs |
| `BaseStrategy` | Abstract strategy with deploy/free/harvest lifecycle |
| `AaveV3YDSStrategy` | Aave V3 yield donation — earns interest, reports to vault |
| `AaveV3YSSStrategy` | Aave V3 yield skimming — holds aTokens, skims excess to vault |
| `MorphoStrategy` | Morpho vault optimizer — deposits/withdraws via Morpho ERC-4626 vault |

### Key Design Patterns

- **FHE encrypted state**: Strategy weights, active flags, debt, drift thresholds, vault creator fee — all encrypted
- **ERC-4626 vault**: Standardized deposit/withdraw with `totalPrincipal` tracking
- **Donation shares**: Profit mints shares to yield router; loss burns donation shares first (cushion), remaining loss reduces PPS
- **Two allocation modes**: Fixed (static weights) and Voting (quadratic voting with epochs)
- **Selective disclosure**: Vault owner grants time-bound auditor access to encrypted strategy data

## Tech Stack

- **Solidity** ^0.8.25 (compiled with 0.8.26, EVM: Cancun)
- **FHE**: @fhenixprotocol/cofhe-contracts (encrypted types: `euint16`, `euint32`, `euint128`, `ebool`)
- **Framework**: Hardhat 2.22+
- **Testing**: Hardhat + Chai + Cofhe mocks
- **Token Standard**: ERC-4626 (vault shares)
- **Dependencies**: OpenZeppelin Contracts v5, OpenZeppelin Upgradeable v5

## Commands

```bash
npm run compile          # Compile contracts
npm test                 # Run tests on Hardhat network
npm run localcofhe:start # Start local Fhenix node
npm run localcofhe:deploy # Deploy to local Fhenix
npm run localcofhe:test  # Run tests on local Fhenix
npm run clean            # Clean artifacts
```

## Test Status

- **95 unit tests passing** + **9 fork tests passing** across all modules
- Counter (9), EncryptedStrategyRegistry (8), FixedAllocationMechanism (5), MorphoStrategy (11), PrivateComposableVault (21), PrivateRebalancer (12), SelectiveDisclosureModule (7), VaultFactory Integration (7), YieldRouter (4), MockStrategy tests included in vault tests
- Fork tests (Ethereum mainnet): AaveV3YDSStrategy supply/withdraw/harvest/emergency lifecycle verified against real Aave V3 Pool
- Strategy composability tested: add/remove lifecycle, swap-and-pop ordering, re-add after removal
- 2-step rebalance flow tested: triggerRebalance (FHE.select gating) + executeRebalance (window enforcement)
- Access control tests for rebalancer threshold updates

## Resolved Issues

1. ~~VaultFactory → Vault initialize mismatch~~ — **FIXED**: Removed `msg.sender == owner` check from `initialize()`. The factory is the trusted deployer; the "already initialized" guard prevents re-initialization.
2. ~~`PrivateRebalancer.updateDriftThreshold` / `updateMinTime` no access control~~ — **FIXED**: Added `onlyVaultOwner` modifier that verifies caller is the vault's owner via `staticcall`. Added `owner` field and `transferOwnership()`.
3. ~~FHE `triggerRebalance` cosmetic gating~~ — **FIXED**: Split into `triggerRebalance()` (computes FHE.select, stores gated amounts, sets 5-min window) and `executeRebalance()` (keeper executes within window, clears pending entries).
4. ~~`_handleLoss` division by zero risk~~ — **FIXED**: Added `supply == 0` and `assets == 0` guards at the top of `_handleLoss()`.
5. ~~VaultFactory contract size~~ — **MITIGATED**: Reduced from 32KB to 25.9KB by removing per-vault rebalancer deployment (back to shared rebalancer passed via constructor). Still exceeds 24.5KB limit; needs CREATE2 deployer or proxy pattern for mainnet.
6. ~~Strategies not composable (append-only)~~ — **FIXED**: Added `removeStrategy` (swap-and-pop O(1), clears registry index for re-addability), `withdrawAllFromStrategy`, `isStrategy`, `getStrategies`. Registry `removeStrategy` callable by owner or vault.
7. ~~No Morpho strategy~~ — **FIXED**: Created `MorphoStrategy` extending `BaseStrategy` with MockMorphoVault for testing (11 tests passing).
8. ~~No Base Sepolia deployment script~~ — **FIXED**: Created `deploy-full-system` Hardhat task with network addresses for base-sepolia and arb-sepolia.
9. ~~No fork tests for real protocol integration~~ — **FIXED**: Created `test/fork/AaveStrategy.fork.test.ts` — 9 tests passing against real Aave V3 Pool on Ethereum mainnet fork. Verified supply, withdraw, harvest, yield accrual (~2.7k USDC over 30 days on 1M), emergency withdraw, and access control.

## Remaining Issues

1. **VaultFactory contract size** (25,930 bytes): Exceeds EIP-170 limit. Won't deploy on mainnet without a CREATE2 deployer, proxy, or splitting the factory into a deployment script.
2. **`VaultRegistry.getVaultMetadata`**: Uses low-level `staticcall` and returns 0 on failure — no error propagation.
3. **`executeRebalance` trust model**: The keeper provides plaintext amounts; the FHE-gated encrypted amounts are cleared without verification. On mainnet with real FHE, the vault should verify amounts against the encrypted pending values via decryption.

## Frontend Readiness Checklist

### ABI / Interface Stability
- [x] All core contracts compile and interfaces are stable
- [ ] Encrypted input format (`InEuint16`, `InEuint32`) documented for frontend integration
- [x] Event signatures finalized for indexing

### Deployment
- [ ] **VaultFactory size issue resolved** (25.9KB — needs CREATE2/proxy for mainnet)
- [x] **VaultFactory → Vault initialize mismatch fixed**
- [x] Testnet deployment scripts ready (`deploy-full-system` task)
- [ ] Factory address / registry address documented
- [ ] Shared rebalancer deployed and configured

### Frontend Integration
- [ ] Cofhe SDK encryption client setup for frontend (encrypt weights, fees, thresholds)
- [ ] FHE decryption flow for vault owner (read encrypted fees)
- [ ] Auditor decryption flow via SelectiveDisclosureModule
- [ ] Voting UI flow (vote, finalize epoch, claim shares)
- [ ] Deposit/withdraw flow with ERC-4626 standard
- [ ] Strategy management UI (add, report, rebalance)
- [ ] Yield claiming UI per epoch
- [ ] 2-step rebalance UI (trigger with FHE → execute within 5-min window)

### Security
- [x] Access control on `PrivateRebalancer.update*` functions (onlyVaultOwner)
- [x] Reentrancy review (vault uses `nonReentrant` on deposit/withdraw)
- [x] Edge case: zero-supply vault loss handling (guarded)
- [ ] FHE handle lifecycle review (allowThis, allow, allowSender)
- [ ] External call safety in `VaultRegistry.getVaultMetadata`
- [ ] `executeRebalance` amount verification against FHE-gated values

## Testnet Addresses

### Base Sepolia (chainId: 84532)

| Contract | Address |
|---|---|
| RPC | `https://sepolia.base.org` |
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Aave V3 PoolAddressesProvider | `0xe20fCBdBffc4Dd138cE8b2E6fBb6F87a2db6cFb9` |
| Aave V3 Pool | `0x1401bf602d95a0d52978961644b7bdd117cf6df6` |

### Arbitrum Sepolia (chainId: 421614)

| Contract | Address |
|---|---|
| RPC | `https://sepolia-rollup.arbitrum.io/rpc` |
| WETH | `0xA71A9B444a33fB581e8eCE61C5231A8E336D35b7` |
| USDC | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| Aave V3 PoolAddressesProvider | `0x6C793c628Fe2b480c5e6FB7957dDa4b9291F9c9b` |
| Aave V3 Pool | `0x14496b405d62c24f91f04cda1c69dc526d56fde5` |

### Ethereum Sepolia (chainId: 11155111)

| Contract | Address |
|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3B3AF64bdAF62C37EEFFCb` |

## Supported Strategy Protocols

| Protocol | Chains | Type | Typical APY (USDC) | Notes |
|---|---|---|---|---|
| Aave V3 | Base, Arbitrum | Money market | 3–6% | Most battle-tested, safest |
| Morpho | Base, Arbitrum | Curated lending vaults (ERC-4626) | 4–8% | Best yield/safety balance |
| Compound | Base | Lending market | 4–7% | Simplest integration |
| Yearn | Base, Arbitrum | Yield aggregator | 4–9% | Auto-compounding, strategy rotation |
| Pendle | Arbitrum, Base | Fixed yield / yield trading | 8–15%+ | Higher yield, more complexity |
| Fluid | Arbitrum | Lending + liquidity layer | 5–8% | Middle ground Aave/Morpho |

### Strategy Integration Pattern

All strategies extend `BaseStrategy` and implement:
- `_deployFunds(uint256 amount)` — deposit assets into yield protocol
- `_freeFunds(uint256 amount)` — withdraw assets back to vault
- `_harvestAndReport() → uint256` — claim rewards + report total assets
- `_totalAssets() → uint256` — view current strategy value
- `emergencyWithdrawAll()` — drain all assets to vault (emergency admin only)

For ERC-4626 vault protocols (Morpho, Yearn): use `vault.deposit(amount, receiver)` / `vault.redeem(shares, receiver, owner)`.
For money markets (Aave, Compound): use `pool.supply(asset, amount, onBehalfOf, referralCode)` / `pool.withdraw(asset, amount, to)`.
