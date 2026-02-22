---
name: safe-agent-treasury
version: 0.1.0
description: Multi-sig treasury for autonomous AI agents. Deploy a Safe Smart Account on Base with AllowanceModule spending limits, multi-sig transaction proposals via Safe Transaction Service, and automatic hot wallet refill. On-chain enforcement — the blockchain is the guardrail, not software.
homepage: https://github.com/betterbrand/safe-agent-treasury
metadata:
  openclaw:
    requires:
      bins: ["node", "security"]
    tags: ["safe", "treasury", "multi-sig", "base", "spending-limits", "allowance", "defi", "wallet"]
---

# safe-agent-treasury

Multi-sig treasury management for autonomous AI agents using Safe Smart Account on Base.

## Why

An agent's hot wallet (EOA) is a single point of failure -- if the private key leaks, all funds are lost instantly. Safe Smart Account integration adds:

- **Multi-sig threshold** -- requires multiple signatures for high-value operations
- **Spending limits** -- AllowanceModule caps what the agent can pull per day
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
| Safe threshold (2-of-2) | On-chain (cannot be bypassed) | Admin operations |
| macOS Keychain | OS-level | Private key storage |

The agent's hot wallet is a *delegate* of the Safe, not the owner of the funds. It can pull MOR/ETH up to its daily allowance via the AllowanceModule -- no more. Admin-level operations (changing owners, modules, or moving large sums) require co-signing from your personal wallet via Safe Wallet app.

## Daily Operations

### Check Financial Status

Run the status dashboard before making financial decisions:

```bash
node scripts/agent-treasury-status.mjs
```

This shows: Safe overview (threshold, owners, module status), balances (Safe + hot wallet), daily allowance usage (spent vs remaining, next reset time), pending multi-sig transactions, and refill daemon health. No private key required -- fully read-only.

Use `--json` for machine-readable output.

### Spending Within Daily Limits

Your hot wallet has a daily allowance from the AllowanceModule:
- **MOR:** 50 MOR per 24 hours
- **ETH:** 0.05 ETH per 24 hours

The refill daemon (`agent-treasury-refill.mjs`) runs every 6 hours via launchd. When your hot wallet balance drops below threshold (20 MOR / 0.01 ETH), it automatically pulls funds from the Safe using `executeAllowanceTransfer`. No signatures needed -- the delegate calls the module directly.

For routine operations (MOR staking, gas fees), you spend from your hot wallet as normal. The refill daemon keeps it topped up within the daily cap.

### Spending Beyond Daily Limits

If you need to move more than the daily allowance, or perform an admin operation:

1. Propose the transaction:
   ```bash
   node scripts/agent-treasury-propose.mjs transfer --token MOR --to 0x... --amount 100
   ```
2. This submits to the Safe Transaction Service. The co-signer approves via Safe Wallet app.
3. Wait for co-signer approval before the transaction executes.

You cannot bypass this. The 2-of-2 threshold is enforced on-chain.

### Morning Financial Check

Good practice at the start of each session:

1. Run `node scripts/agent-treasury-status.mjs`
2. Verify refill daemon is healthy (loaded, recent log entry)
3. Check if any pending transactions need attention
4. Note daily allowance remaining before planning spending

## Deployment

### Step 1: Deploy the Safe

```bash
# Deploy a 1-of-2 Safe with your wallet and the agent hot wallet as owners
node scripts/agent-treasury-deploy.mjs --owner 0xYourPersonalWallet

# Dry run (no transaction, for testing)
node scripts/agent-treasury-deploy.mjs --owner 0xYourAddress --agent 0xAgentAddress --dry-run
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--owner` | (required) | Your personal wallet address (co-owner) |
| `--agent` | Keychain | Agent address (only for `--dry-run`) |
| `--threshold` | `1` | Initial signature threshold |
| `--dry-run` | `false` | Print initializer data without deploying |
| `--salt-nonce` | random | Deterministic deployment salt |

After deployment, add the Safe address to `~/morpheus/.env`:

```bash
SAFE_ADDRESS=0xYourNewSafeAddress
```

### Step 2: Configure AllowanceModule

```bash
node scripts/agent-treasury-configure.mjs
```

This script executes four Safe transactions:

1. `enableModule(AllowanceModule)` -- adds the module to the Safe
2. `addDelegate(agentHotWallet)` -- registers the agent as a spending delegate
3. `setAllowance(agent, MOR, 50, 1440, 0)` -- 50 MOR per 24h
4. `setAllowance(agent, ETH, 0.05, 1440, 0)` -- 0.05 ETH per 24h

Default allowance values (configurable via env vars):

| Token | Daily Allowance | Reset Interval |
|-------|----------------|----------------|
| MOR | 50 MOR | 1440 min (24h) |
| ETH | 0.05 ETH | 1440 min (24h) |

The script only works at threshold 1 (the initial setup threshold). It checks idempotently whether the module is already enabled.

### Step 3: Move Funds to Safe

Transfer MOR and ETH from the hot wallet to the Safe address. Keep a small operating float in the hot wallet:

- Keep ~20 MOR + 0.01 ETH in hot wallet
- Move remaining MOR + ETH to Safe

### Step 4: Raise Threshold to 2-of-2

```bash
node scripts/agent-treasury-propose.mjs threshold --value 2
```

After this, all admin operations require both your personal wallet and the agent wallet to co-sign via Safe Wallet app.

## agent-treasury-propose.mjs -- Multi-Sig Proposals

For operations that exceed the AllowanceModule limits or require owner-level permissions, use the proposal system:

```bash
# Propose a token transfer
node scripts/agent-treasury-propose.mjs transfer --token MOR --to 0xRecipient --amount 100
node scripts/agent-treasury-propose.mjs transfer --token ETH --to 0xRecipient --amount 0.5

# Propose a threshold change
node scripts/agent-treasury-propose.mjs threshold --value 2

# List pending transactions
node scripts/agent-treasury-propose.mjs pending

# Add the agent's signature to a pending transaction
node scripts/agent-treasury-propose.mjs confirm --hash 0xSafeTxHash

# Propose a raw transaction (advanced)
node scripts/agent-treasury-propose.mjs propose --to 0xTarget --data 0xCalldata --value 0
```

Proposals are submitted to the Safe Transaction Service (`safe-transaction-base.safe.global`). Co-sign via the [Safe Wallet app](https://app.safe.global).

## agent-treasury-refill.mjs -- Auto-Refill Hot Wallet

Runs as a launchd periodic job (every 6 hours) to keep the hot wallet funded:

1. Checks hot wallet MOR and ETH balances on Base
2. If below threshold, calls `AllowanceModule.executeAllowanceTransfer()`
3. The delegate (hot wallet) calls the module directly -- no signature required
4. Logs results with timestamps

```bash
# Manual run
node scripts/agent-treasury-refill.mjs

# Install as launchd service (auto-runs every 6 hours)
bash scripts/install.sh
```

Refill thresholds (configured in `~/morpheus/.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `MOR_LOW_THRESHOLD` | `20` | MOR balance that triggers refill |
| `MOR_REFILL_AMOUNT` | `30` | MOR to pull per refill |
| `ETH_LOW_THRESHOLD` | `0.01` | ETH balance that triggers refill |
| `ETH_REFILL_AMOUNT` | `0.03` | ETH to pull per refill |

## Configuration

All config lives in `~/morpheus/.env` (or the directory specified by `SAFE_DIR`):

```bash
# Required
SAFE_ADDRESS=0x...            # Safe wallet address on Base (set after deployment)

# Required -- RPC (no public fallback; see security note below)
SAFE_RPC=https://...          # Base RPC URL (Alchemy, Infura, or QuickNode recommended)

# Optional -- Keychain (defaults match existing everclaw setup)
SAFE_KEYCHAIN_ACCOUNT=...    # Keychain account name
SAFE_KEYCHAIN_SERVICE=...    # Keychain service name
SAFE_KEYCHAIN_DB=...         # Keychain database path
SAFE_KEYCHAIN_PASS_FILE=...  # Keychain password file path

# Optional -- AllowanceModule
ALLOWANCE_MODULE=0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134  # AllowanceModule v1

# Optional -- Refill thresholds
MOR_LOW_THRESHOLD=20          # MOR balance that triggers refill
MOR_REFILL_AMOUNT=30          # MOR to pull per refill
ETH_LOW_THRESHOLD=0.01        # ETH balance that triggers refill
ETH_REFILL_AMOUNT=0.03        # ETH to pull per refill
```

### Env Var Compatibility

All `SAFE_*` env vars fall back to their `EVERCLAW_*` equivalents for backward compatibility:

| Primary | Fallback | Default |
|---------|----------|---------|
| `SAFE_RPC` | `EVERCLAW_RPC` | *(required — no default)* |
| `SAFE_KEYCHAIN_ACCOUNT` | `EVERCLAW_KEYCHAIN_ACCOUNT` | `everclaw-agent` |
| `SAFE_KEYCHAIN_SERVICE` | `EVERCLAW_KEYCHAIN_SERVICE` | `everclaw-wallet-key` |
| `SAFE_KEYCHAIN_DB` | `EVERCLAW_KEYCHAIN_DB` | `~/Library/Keychains/everclaw.keychain-db` |
| `SAFE_KEYCHAIN_PASS_FILE` | `EVERCLAW_KEYCHAIN_PASS_FILE` | `~/.everclaw-keychain-pass` |
| `SAFE_DIR` | `MORPHEUS_DIR` | `~/morpheus` |

## Future: DeFi Yield Farming (Phase 2)

For DeFi operations beyond simple transfers, the AllowanceModule is insufficient -- it can only call `transfer()`. The correct tool is:

- **Zodiac Roles Modifier v2** -- on-chain permission scoping by contract address, function selector, and parameter values
- **DeFi Kit by karpatkey** -- pre-built, audited permission sets for ~17 protocols (Aave, Uniswap, Lido, CowSwap, etc.)

This is a separate track to implement after the base Safe deployment is operational.

## Quick Reference

| Command | Description |
|---------|-------------|
| `node scripts/agent-treasury-status.mjs` | Dashboard: balances, allowances, pending txs |
| `node scripts/agent-treasury-status.mjs --json` | Machine-readable status output |
| `node scripts/agent-treasury-deploy.mjs --owner 0x...` | Deploy Safe on Base |
| `node scripts/agent-treasury-configure.mjs` | Enable AllowanceModule + set limits |
| `node scripts/agent-treasury-configure.mjs --dry-run` | Preview configuration changes |
| `node scripts/agent-treasury-refill.mjs` | Check + refill hot wallet |
| `node scripts/agent-treasury-propose.mjs pending` | List pending multi-sig txs |
| `node scripts/agent-treasury-propose.mjs transfer --token MOR --to 0x... --amount N` | Propose transfer |
| `node scripts/agent-treasury-propose.mjs threshold --value 2` | Propose threshold change |
| `node scripts/agent-treasury-propose.mjs confirm --hash 0x...` | Co-sign pending tx |
| `bash scripts/install.sh` | Install launchd refill service |
