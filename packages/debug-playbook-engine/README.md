# debug-playbook-engine

Guides agents through domain-specific, ordered diagnostic sequences. Prevents hypothesis-hopping. Part of the agent-grounding stack.

## Problem

Agents jump between hypotheses without systematic verification:
- Is the process running?
- Is configuration correct?
- Is the dependency reachable?
- Does the architecture assumption even hold?

## Install

```bash
npm install -g @lannguyensi/debug-playbook-engine
```

## Usage

```bash
# Start a diagnostic playbook
debug-playbook run -d clawd-monitor -p "agent not visible in monitor"

# Show next required step
debug-playbook next -d clawd-monitor -p "agent not visible"

# JSON output
debug-playbook run -d clawd-monitor -p "agent not visible" --json
```

## Example Output

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

  ▶ Start with: Verify architecture summary from README
```

## Built-in Playbooks

| Domain | Playbook |
|--------|----------|
| `clawd-monitor` | Basic connectivity: process → start mode → config → network |
| `github` | API connectivity: token → rate limit → repo access → permissions |
| `generic` | Read docs → check process → verify config → deps → logs |

## API

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

Caveat: `canMakeClaim`'s requirements for `root-cause` and
`architecture` mix step IDs from different built-in playbooks
(`check-repo-model` lives in `clawd-monitor` / `github`, while
`read-docs` and `check-process` live in `generic`), so no single
built-in playbook can satisfy either claim type on its own. To gate
those claims today, extend a domain playbook with the missing step
IDs, or compose facts from multiple playbook runs before the call.

## Part of the grounding stack

1. [domain-router](../domain-router)
2. [readme-first-resolver](../readme-first-resolver)
3. **debug-playbook-engine** ← you are here
4. [evidence-ledger](../evidence-ledger)
