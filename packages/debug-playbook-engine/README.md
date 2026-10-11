# debug-playbook-engine

Guides agents through domain-specific, ordered diagnostic sequences.

## Overview

Part of the agent-grounding stack. Agents jump between hypotheses without systematic verification: is the process running, is configuration correct, is the dependency reachable, does the architecture assumption even hold. debug-playbook-engine prevents hypothesis-hopping by walking a domain playbook's mandatory steps in order and gating claims behind the steps they require.

## Install

```bash
npm install -g @lannguyensi/debug-playbook-engine
```

Requires Node.js >= 20.

## Usage

```bash
# Print the playbook for a domain
debug-playbook run -d clawd-monitor -p "agent not visible in monitor"

# Print the first step and the number of mandatory steps (the CLI keeps no state between calls)
debug-playbook next -d clawd-monitor -p "agent not visible"

# JSON output
debug-playbook run -d clawd-monitor -p "agent not visible" --json
```

Recording step results and gating claims is library-only; see [API](#api).

### Example output

```
🔍 Debug Playbook: clawd-monitor.basic-connectivity

  Problem: agent not visible in monitor

  Steps:
    1. check-repo-model [mandatory]
       → Verify architecture summary from README
    2. check-agent-process [mandatory]
       → Verify clawd-monitor-agent is running
    3. check-start-mode [mandatory]
       → Determine whether agent is manual, docker, or systemd started
    4. check-config [mandatory]
       → Verify authoritative env/token source
    5. check-network [optional]
       → Verify target URL reachability (only after process/config confirmed)
    6. verify-fix [mandatory]
       → Verify the original problem is no longer reproducible

  ▶ Start with: Verify architecture summary from README
```

### Built-in playbooks

| Domain | Playbook |
|--------|----------|
| `clawd-monitor` | Basic connectivity: repo model → process → start mode → config → network (optional) → verify-fix |
| `github` | API connectivity: token → rate limit → repo access → permissions (optional) → verify-fix |
| `generic` | Read docs → check process → verify config → deps (optional) → logs (optional) → verify-fix |

The `-d` value is lowercased and runs of `-`, `_` and whitespace become `-`. An exact name wins; otherwise the first built-in name that contains the value, or is contained in it, is used (so `-d git` resolves to `github` and `-d monitor` to `clawd-monitor`); anything else falls back to `generic`.

### API

```typescript
import { getPlaybook, initRun, recordStep, canMakeClaim } from '@lannguyensi/debug-playbook-engine';

const playbook = getPlaybook('clawd-monitor', 'agent not visible');
const state = initRun(playbook);

// Record step results as you work through them. `recordStep` enforces
// the playbook's mandatory order, so you cannot jump past pending
// mandatory steps.
recordStep(state, 'check-repo-model', 'done', 'README confirms Docker deployment');
recordStep(state, 'check-agent-process', 'done', 'process not running');

// `canMakeClaim` gates a claim behind the steps it requires.
// A `config` claim needs the `check-config` step, which we have not run
// yet, so the gate correctly blocks here.
const blocked = canMakeClaim(state, 'config');
// blocked.allowed === false
// blocked.reason === ['Required step not completed: check-config']

// Walk the mandatory order to reach `check-config`, then the gate opens.
recordStep(state, 'check-start-mode', 'done', 'manual: clawd run');
recordStep(state, 'check-config', 'done', 'CLAWD_TOKEN sourced from .env');
const allowed = canMakeClaim(state, 'config');
// allowed.allowed === true
```

`canMakeClaim` checks step IDs, and the built-in playbooks cover them unevenly:

| Claim type | Required step IDs | Built-in playbooks that can satisfy it |
|------------|-------------------|----------------------------------------|
| `root-cause` | check-repo-model, read-docs, check-process | none |
| `architecture` | check-repo-model, read-docs | none |
| `config` | check-config | clawd-monitor, generic |
| `network` | check-process, check-config | generic |

The github playbook satisfies no claim type, and clawd-monitor's check-network step does not count toward a network claim. To gate the other claims, extend a domain playbook with the missing step IDs.

## Part of the grounding stack

1. [domain-router](../domain-router)
2. [readme-first-resolver](../readme-first-resolver)
3. **debug-playbook-engine** (you are here)
4. [evidence-ledger](../evidence-ledger)

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
