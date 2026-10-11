# readme-first-resolver

Checks that an agent's primary documentation exists and has been read before analysis, and builds a system summary from it.

## Overview

Part of the agent-grounding stack. Agents often start with logs, processes, or guesses instead of the README, architecture docs, setup instructions, or `.env.example`. readme-first-resolver reads the primary documentation set for a repo and reports what was found, what is missing, and whether analysis is safe to start.

`ready_for_analysis` is true when `README.md` was found and read. It is a signal for the caller, for example a harness policy or claim-gate's `readme_read` flag; this package does not block anything itself. Treat `false` as a reason not to make a root-cause claim yet.

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

Without `-f`, the resolver reads README.md, AGENT_ENTRYPOINT.yaml and .env.example from the repo. AGENT_ENTRYPOINT.yaml is only checked for existence; its content is not used. The summary fields are heuristics extracted from the README and `.env` files in the list. Readiness requires the list to contain `README.md` exactly.

### Example output

Output of `readme-first resolve -p /projects/clawd-monitor -f README.md .env.example docs/architecture.md`:

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
