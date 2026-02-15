# Safe Smart Account Deployment Reference

Reference document for deploying and configuring a Safe smart account to secure an autonomous agent's on-chain operations. Consolidates research findings and implementation plan from Feb 13, 2026.

## Why Safe

An agent wallet currently operating as a raw EOA (externally owned account) is a single point of failure. If the private key is compromised, all funds are lost instantly. A Safe smart account adds:

- **Multi-sig threshold** -- requires multiple signatures for high-value operations
- **Spending limits** -- Allowance Module caps what the agent can pull per day
- **Key rotation** -- owners can be swapped without moving funds
- **Human override** -- you can always intervene via Safe Wallet app

The agent's hot wallet becomes a *delegate* of the Safe, not the owner. It can only operate within the constraints you configure on-chain.

## Architecture

```
  Personal Wallet (Owner 1)
  Agent Hot Wallet (Owner 2 + Delegate)
            |
            v
  Safe Smart Account (2-of-2 for admin, delegate for daily ops)
    - AllowanceModule: daily MOR/ETH transfer caps
    - Funds: MOR, ETH, USDC
            |
            v
  Base Mainnet (chain ID 8453)
```

### Security Layers

| Layer | Enforcement | Scope |
|-------|-------------|-------|
| OpenClaw tool policies | Software (can be bypassed) | Agent tool access |
| AllowanceModule | On-chain (cannot be bypassed) | Daily transfer caps |
| Safe threshold | On-chain (cannot be bypassed) | Admin operations |
| macOS Keychain | OS-level | Private key storage |

### Future: Yield Farming (Phase 2)

For DeFi operations beyond simple transfers, the AllowanceModule is insufficient -- it can only call `transfer()`. The correct tool is:

- **Zodiac Roles Modifier v2** -- on-chain permission scoping by contract address, function selector, and parameter values
- **DeFi Kit by karpatkey** -- pre-built, audited permission sets for ~17 protocols (Aave, Uniswap, Lido, CowSwap, etc.)
- **Precedent:** ENS DAO uses this stack to manage $50M+ endowment

This is a separate track to implement after the base Safe deployment is operational. See the deep research report at `deep-research/reports/2026-02-13-safe-agent-framework-sdk.pdf` for full details.

## Deployment Outcome (2026-02-15)

Safe deployed and fully configured on Base mainnet.

| Property | Value |
|----------|-------|
| **Safe address** | [`0x740B13AdBC9eFD06AE283F59cE06915ff582B977`](https://basescan.org/address/0x740B13AdBC9eFD06AE283F59cE06915ff582B977) |
| **Chain** | Base (8453) |
| **Version** | Safe v1.4.1 (L2) |
| **Owners** | Agent (`0xb581bbfE41d5a5238A79C9DEA4195c4b6dEdbD57`) + Owner (`0xC3407F2CAC9371C3Ad49B6Ad8e284142e1EBDD24`) |
| **Threshold** | 2-of-2 |
| **AllowanceModule** | Enabled, agent as delegate |
| **MOR allowance** | 50 MOR/day (resets every 1440 min) |
| **ETH allowance** | 0.05 ETH/day (resets every 1440 min) |
| **Safe balance** | 1,920 MOR |
| **Hot wallet float** | ~20.49 MOR + 0.016 ETH |

### Transaction Log

| Step | Tx Hash | Status |
|------|---------|--------|
| Deploy Safe | `0x18bc15e7a7b364ffbf7848e705850206b2cd458edbb462ea06132e9f0d922393` | Success |
| Enable AllowanceModule | `0xea862ebc83ea64266d65602ec4cec152b1e4027e37fec461f454f0a8896a8918` | Success |
| Add delegate (agent) | `0x127e09817b5e35acb0fb1bebe6defa6470ec66eadd76017915682ffbaaae0cf9` | Success |
| Set MOR allowance | `0xb04900ee73888922802f2c4f0707a64cb6a79b95b128d4a8a820ef2279b5220d` | Success |
| Set ETH allowance | `0x55ba3fd00250609fa5a315eb47c3f586122b6bd31948700ef6a0ffe106b64e32` | Success |
| Transfer 1920 MOR to Safe | `0x7a53cf9d5d0ce3ccb25444678af693c3ec6bdf1c002598c62bd393f931d3b889` | Success |
| Raise threshold to 2-of-2 | Co-signed via Safe Wallet app (app.safe.global) | Success |

### Lessons Learned

1. **RPC settle delay required.** Public RPC endpoints (BlastAPI) serve stale nonce reads immediately after a transaction confirms. Sequential Safe transactions fail with `GS026` (invalid signature) or `GS013` because the tx hash is computed with a stale nonce. Fix: add 5-second delay between sequential transactions in `safe-configure.mjs`.

2. **Keychain password file is optional.** The `getPrivateKey()` function was refactored to make the password file optional. If missing, the scripts assume the keychain is already unlocked (e.g., via manual `security unlock-keychain`). This is the preferred approach when running interactively on the agent's Mac Mini.

3. **Keychain config.** The wallet key can be stored in the standard login keychain rather than a dedicated keychain. Set `SAFE_KEYCHAIN_ACCOUNT`, `SAFE_KEYCHAIN_SERVICE`, and `SAFE_KEYCHAIN_DB` in your `.env` to match your keychain setup.

4. **Post-deploy verification can fail.** The `safe-deploy.mjs` script's verification step (`VERSION()` call) can return empty data if the RPC hasn't indexed the new contract yet. The deployment itself succeeds -- the ProxyCreation event is the authoritative confirmation.

---

## Known Addresses

| Address | Chain | Purpose |
|---------|-------|---------|
| [`0x740B13AdBC9eFD06AE283F59cE06915ff582B977`](https://basescan.org/address/0x740B13AdBC9eFD06AE283F59cE06915ff582B977) | Base | Safe Smart Account |
| `0x7431aDa8a591C955a994a21710752EF9b882b8e3` | Base | MOR token contract |
| `0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134` | Base | AllowanceModule v1 |
| `0xC3407F2CAC9371C3Ad49B6Ad8e284142e1EBDD24` | Base | Owner signer address |
| `0xb581bbfE41d5a5238A79C9DEA4195c4b6dEdbD57` | Base | Agent hot wallet |

### Configuration

Located in `~/morpheus/.env`:

```bash
SAFE_ADDRESS=0x...            # Safe wallet address on Base (set after deployment)
ALLOWANCE_MODULE=0x...        # AllowanceModule address (default: 0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134)
MOR_LOW_THRESHOLD=20          # MOR balance that triggers refill
MOR_REFILL_AMOUNT=30          # MOR to pull per refill
ETH_LOW_THRESHOLD=0.01        # ETH balance that triggers refill
ETH_REFILL_AMOUNT=0.03        # ETH to pull per refill
SAFE_RPC=https://...          # Base RPC URL
```

## Implementation Plan

### Step 1: Install deps -- DONE

```bash
cd safe-treasury
npm install
```

### Step 2: Deploy Safe on Base -- DONE (2026-02-15)

```bash
node scripts/safe-deploy.mjs --owner 0xOwnerAddress
```

After deployment:
- Record Safe address
- Add `SAFE_ADDRESS=0x...` to `~/morpheus/.env`
- Verify on Basescan

### Step 3: Configure AllowanceModule -- DONE (2026-02-15)

```bash
node scripts/safe-configure.mjs
```

Executes four Safe transactions:
1. `enableModule(ALLOWANCE_MODULE)`
2. `addDelegate(agentHotWallet)`
3. `setAllowance(agentHotWallet, MOR_TOKEN, amount, resetTimeMin, 0)`
4. `setAllowance(agentHotWallet, address(0), amount, resetTimeMin, 0)`

### Step 4: Move funds to Safe -- DONE (2026-02-15, 1920 MOR transferred)

Transfer MOR and ETH from current hot wallet to the Safe address:
- Keep ~20 MOR + 0.01 ETH in hot wallet (operating float)
- Move remaining MOR + ETH to Safe
- Verify balances on Basescan

### Step 5: Raise threshold to 2-of-2 -- DONE (2026-02-15, co-signed via Safe Wallet app)

```bash
node scripts/safe-propose.mjs threshold --value 2
```

Co-sign via Safe Wallet app.

### Step 6: Test end-to-end -- PARTIAL (refill + pending tested, full e2e after funding)

1. Verify Safe is deployed and owns expected funds
2. Verify AllowanceModule is enabled on Safe
3. Verify agent is registered as delegate with correct allowances
4. Run safe-refill.mjs manually -- confirm it pulls MOR within allowance
5. Run safe-refill.mjs again -- confirm it respects reset interval
6. Attempt to exceed allowance -- confirm on-chain rejection
7. Submit a test proposal via safe-propose.mjs -- confirm it appears in Safe Wallet app
8. Approve the proposal from the owner's wallet -- confirm execution

## Contract ABIs Reference

### ERC-20 (balanceOf)
```solidity
function balanceOf(address account) external view returns (uint256)
```

### AllowanceModule
```solidity
// Execute a transfer within delegate allowance
function executeAllowanceTransfer(
    address safe,
    address token,
    address payable to,
    uint96 amount,
    address paymentToken,
    uint96 payment,
    address delegate,
    bytes signature
) external

// Read current allowance state
function getTokenAllowance(
    address safe,
    address delegate,
    address token
) external view returns (uint256[5])
// Returns: [amount, spent, resetTimeMin, lastReset, nonce]

// Admin functions (called via Safe owner tx)
function addDelegate(address delegate) external
function setAllowance(
    address delegate,
    address token,
    uint96 allowanceAmount,
    uint16 resetTimeMin,
    uint32 resetBaseMin
) external
```

### Safe Factory (for deployment)
```solidity
function createProxyWithNonce(
    address singleton,
    bytes initializer,
    uint256 saltNonce
) external returns (address proxy)
```

## File Inventory

| File | Status | Purpose |
|------|--------|---------|
| `scripts/safe-deploy.mjs` | Complete | Deploy Safe on Base |
| `scripts/safe-configure.mjs` | Complete | Enable AllowanceModule + set limits |
| `scripts/safe-refill.mjs` | Complete | Auto-refill hot wallet from Safe |
| `scripts/safe-propose.mjs` | Complete | Multi-sig transaction proposals |
| `scripts/install.sh` | Complete | Install launchd refill service |
| `references/safe-deployment.md` | This file | Implementation reference |
| `~/morpheus/.env` | To update | SAFE_ADDRESS after deployment |

## Research References

- [Safe Docs - AI Agents Overview](https://docs.safe.global/home/ai-overview)
- [Safe Docs - Agent with Spending Limit](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit)
- [Safe Docs - Multi-Agent Setup](https://docs.safe.global/home/ai-agent-quickstarts/multi-agent-setup)
- [Safe Docs - Smart Account Modules](https://docs.safe.global/advanced/smart-account-modules)
- [Zodiac Roles Modifier v2](https://docs.roles.gnosisguild.org/) (Phase 2 -- DeFi farming)
- [DeFi Kit by karpatkey](https://github.com/karpatkey/defi-kit) (Phase 2 -- DeFi farming)
- [AllowanceModule source](https://github.com/safe-global/safe-modules/blob/main/modules/allowances/contracts/AllowanceModule.sol)
