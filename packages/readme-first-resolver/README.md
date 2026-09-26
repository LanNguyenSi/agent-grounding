# readme-first-resolver

Forces agents to read primary documentation before any analysis, and builds a system mental model from it.

## Overview

Part of the agent-grounding stack. Agents often start with logs, processes, or guesses instead of the README, architecture docs, setup instructions, or `.env.example`. readme-first-resolver reads the primary documentation set for a repo and reports what was found, what is missing, and whether analysis is safe to start.

**No root-cause claim is allowed without `ready_for_analysis: true`.**

## Install

```bash
npm install -g @lannguyensi/readme-first-resolver
```

Requires Node.js >= 20.

## Usage

```bash
# Resolve docs for a repo
readme-first resolve -p /projects/clawd-monitor

# Custom file list
readme-first resolve -p /projects/clawd-monitor -f README.md docs/architecture.md

# JSON output
readme-first resolve -p /projects/clawd-monitor --json
```

### Example output

```
📖 README First Resolver

  Status: ✅ Ready

  System Summary:
    Purpose: Monitors OpenClaw agents in real-time
    Components: Frontend, Backend, Agent process
    Runtime: Docker container deployment, systemd service
    Config: GATEWAY_URL, TOKEN, PORT

  Sources read: README.md, .env.example
  Missing: docs/architecture.md

  ⚠ Unknowns:
    - No architecture docs found
```

### API

```typescript
import { resolve } from '@lannguyensi/readme-first-resolver';

const result = resolve({
  repo_path: '/projects/clawd-monitor',
  must_read: ['README.md', '.env.example'],
});
// -> { system_summary, unknowns, sources_read, sources_missing, ready_for_analysis }
```

## Part of the grounding stack

1. [domain-router](../domain-router)
2. **readme-first-resolver** (you are here)
3. [debug-playbook-engine](../debug-playbook-engine)
4. [evidence-ledger](../evidence-ledger)

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
