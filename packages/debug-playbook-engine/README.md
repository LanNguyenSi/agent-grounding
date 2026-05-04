# debug-playbook-engine

Guides agents through domain-specific, ordered diagnostic sequences. Prevents hypothesis-hopping. Part of the [lan-tools](https://github.com/LanNguyenSi/lava-ice-logs/tree/main/lan-tools) agent grounding stack.

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

// Record step results as you work through them
recordStep(state, 'check-repo-model', 'done', 'README confirms Docker deployment');
recordStep(state, 'check-agent-process', 'done', 'process not running');

// Gate claims behind completed steps
const { allowed, reason } = canMakeClaim(state, 'root-cause');
```

## Part of the grounding stack

1. [domain-router](https://github.com/LanNguyenSi/domain-router)
2. [readme-first-resolver](https://github.com/LanNguyenSi/readme-first-resolver)
3. **debug-playbook-engine** ← you are here
4. [evidence-ledger](https://github.com/LanNguyenSi/evidence-ledger)
5. [agent-entrypoint](https://github.com/LanNguyenSi/agent-entrypoint)
