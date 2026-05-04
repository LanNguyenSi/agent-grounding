# readme-first-resolver

Forces agents to read primary documentation before any analysis, and builds a system mental model from it. Part of the [lan-tools](https://github.com/LanNguyenSi/lava-ice-logs/tree/main/lan-tools) agent grounding stack.

## Problem

Agents often start with logs, processes, or guesses instead of:
- README
- Architecture docs
- Setup instructions
- `.env.example`

## Install

```bash
npm install -g @lannguyensi/readme-first-resolver
```

## Usage

```bash
# Resolve docs for a repo
readme-first resolve -p /projects/clawd-monitor

# Custom file list
readme-first resolve -p /projects/clawd-monitor -f README.md docs/architecture.md

# JSON output
readme-first resolve -p /projects/clawd-monitor --json
```

## Example Output

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

## API

```typescript
import { resolve } from '@lannguyensi/readme-first-resolver';

const result = resolve({
  repo_path: '/projects/clawd-monitor',
  must_read: ['README.md', '.env.example'],
});
// → { system_summary, unknowns, sources_read, sources_missing, ready_for_analysis }
```

## Rule

**No root-cause claim is allowed without `ready_for_analysis: true`.**

## Part of the grounding stack

1. [domain-router](https://github.com/LanNguyenSi/domain-router)
2. **readme-first-resolver** ← you are here
3. [debug-playbook-engine](https://github.com/LanNguyenSi/debug-playbook-engine)
4. [evidence-ledger](https://github.com/LanNguyenSi/evidence-ledger)
5. [agent-entrypoint](https://github.com/LanNguyenSi/agent-entrypoint)
