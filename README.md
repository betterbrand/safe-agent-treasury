# safe-treasury

Multi-sig treasury management for autonomous AI agents using [Safe Smart Account](https://safe.global) on Base.

Deploy a Safe with AllowanceModule spending limits, multi-sig transaction proposals, and automatic hot wallet refill. On-chain enforcement -- the blockchain is the guardrail, not software.

## Quick Start

```bash
npm install

# 1. Deploy Safe (1-of-2 with your wallet + agent hot wallet)
node scripts/safe-deploy.mjs --owner 0xYourWalletAddress

# 2. Configure AllowanceModule + spending limits
#    (set SAFE_ADDRESS in ~/morpheus/.env first)
node scripts/safe-configure.mjs

# 3. Move funds to Safe, then raise threshold
node scripts/safe-propose.mjs threshold --value 2

# 4. Install auto-refill daemon (every 6 hours)
bash scripts/install.sh
```

## What's Included

| Script | Purpose |
|--------|---------|
| `safe-deploy.mjs` | Deploy Safe v1.4.1 on Base with two owners |
| `safe-configure.mjs` | Enable AllowanceModule, set MOR/ETH daily limits |
| `safe-propose.mjs` | Multi-sig tx proposals via Safe Transaction Service |
| `safe-refill.mjs` | Auto-refill hot wallet from Safe (launchd daemon) |
| `install.sh` | Install launchd service for auto-refill |

## Configuration

Set in `~/morpheus/.env`:

```bash
SAFE_ADDRESS=0x...       # Required: Safe address on Base
SAFE_RPC=https://...     # Optional: Base RPC URL
```

See [SKILL.md](SKILL.md) for full configuration reference, deployment walkthrough, and architecture details.

## License

MIT
