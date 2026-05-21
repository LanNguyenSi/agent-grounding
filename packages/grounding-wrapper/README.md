# grounding-wrapper

Orchestrates the full agent-grounding stack. Enforces the correct entry path before any debugging begins, even good agents lose focus when they have free tool access.

## What it does

Before any analysis, automatically:
1. **Resolves scope** via [domain-router](../domain-router)
2. **Reads primary docs** via [readme-first-resolver](../readme-first-resolver)
3. **Loads playbook** via [debug-playbook-engine](../debug-playbook-engine)
4. **Checks runtime** via [runtime-reality-checker](../runtime-reality-checker) *(for service/agent domains)*
5. **Tracks evidence** via [evidence-ledger](../evidence-ledger)
6. **Gates claims** via [claim-gate](../claim-gate)
7. **Manages hypotheses** via [hypothesis-tracker](../hypothesis-tracker)

## Usage

```bash
npm install
npm run build
npm link

# Start a grounding session
grounding-wrapper start -k clawd-monitor -p "agent not visible in monitor"

# Show all phases
grounding-wrapper show-phases -k clawd-monitor -p "agent not visible"

# Check if a guardrail is active
grounding-wrapper check-guardrail -k clawd-monitor -g no-root-cause-before-readme

# JSON output for scripting
grounding-wrapper start -k clawd-monitor -p "agent not visible" --json
```

## Example Output

```
🧭 Grounding Wrapper — Session Started

  ID:      gs-clawd-monitor-m8x2k4
  Scope:   clawd-monitor
  Problem: agent not visible in monitor

  Mandatory Sequence:
    1. domain-router
    2. readme-first-resolver
    3. debug-playbook-engine
    4. runtime-reality-checker
    5. evidence-ledger
    6. claim-gate
    7. hypothesis-tracker

  Active Guardrails:
    🔒 No root-cause claim before README is read
    🔒 No token/config claim before config source is verified
    🔒 No network claim before process state is verified
    🔒 No architecture claim before primary docs are read
    🔒 Mandatory steps cannot be skipped

  ▶ Start now with:
    → domain-router: Resolve scope: identify primary repos, components, priority files
```

## Guardrails

| ID | Rule |
|----|------|
| `no-root-cause-before-readme` | No root-cause claim before README is read |
| `no-token-claim-before-config-check` | No token/config claim before config source is verified |
| `no-architecture-claim-before-docs` | No architecture claim before primary docs are read |
| `no-network-claim-before-process-check` | No network claim before process state is verified |
| `no-step-skipping` | Mandatory steps cannot be skipped |

## API

```typescript
import { initSession, getCurrentTools, advancePhase, isGuardrailActive } from '@lannguyensi/grounding-wrapper';

const session = initSession({ keyword: 'clawd-monitor', problem: 'agent not visible' });

// What to invoke right now
const tools = getCurrentTools(session);

// Advance after completing current phase
advancePhase(session);

// Check guardrails before allowing actions
if (isGuardrailActive(session, 'no-root-cause-before-readme')) {
  // block the claim
}

// Handle scope change mid-session
import { handleScopeChange } from '@lannguyensi/grounding-wrapper';
const updated = handleScopeChange(session, 'new-keyword');
```

## The full grounding stack

| # | Tool | Role |
|---|------|------|
| 1 | [domain-router](../domain-router) | Scope resolution |
| 2 | [readme-first-resolver](../readme-first-resolver) | Doc reading |
| 3 | [debug-playbook-engine](../debug-playbook-engine) | Playbook sequencing |
| 4 | [evidence-ledger](../evidence-ledger) | Fact tracking |
| 5 | [claim-gate](../claim-gate) | Claim gating |
| 6 | [runtime-reality-checker](../runtime-reality-checker) | Runtime verification |
| 7 | [hypothesis-tracker](../hypothesis-tracker) | Hypothesis management |
| **→** | **grounding-wrapper** | **Orchestrates all of the above** |
