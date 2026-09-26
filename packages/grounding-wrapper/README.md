# grounding-wrapper

Plans grounding sessions for agents.

## Overview

Given a `{keyword, problem}` input, grounding-wrapper computes a recommended **ordered sequence** of tools the agent should invoke, a set of **active guardrails** (rules the agent must not violate), and a **phase machine** the agent can advance through as it works. It is the planning surface for the agent-grounding stack, not the enforcement surface.

### What it does NOT do

This package is intentionally a **pure planner**. It does **not**:

- invoke `domain-router`, `readme-first-resolver`, `debug-playbook-engine`, `evidence-ledger`, `claim-gate`, `runtime-reality-checker`, or `hypothesis-tracker`
- block tool calls that violate the recommended sequence
- persist sessions to disk
- guarantee that the agent follows the plan

**Enforcement is a separate concern.** A downstream Policy (typically wired via [harness](https://github.com/LanNguyenSi/harness)) is what blocks an agent's tool call when the sequence is violated or a guardrail is breached. The wrapper recommends; harness enforces. See [Public API for enforcement](docs/enforcement-contract.md) for the consumption contract.

## Install

```bash
npm install -g @lannguyensi/grounding-wrapper
```

Requires Node.js >= 20.

## Usage

```bash
# Start a grounding session
grounding-wrapper start -k clawd-monitor -p "agent not visible in monitor"

# Show all phases
grounding-wrapper show-phases -k clawd-monitor -p "agent not visible"

# Check if a guardrail is active
grounding-wrapper check-guardrail -k clawd-monitor -g no-root-cause-before-readme

# JSON output for scripting
grounding-wrapper start -k clawd-monitor -p "agent not visible" --json
```

### Example output

```
🧭 Grounding Wrapper: Session Started

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

The output is advisory. Whether the agent actually invokes `domain-router` next is up to the agent (or a Policy that enforces it).

### Guardrails

| ID | Rule |
|----|------|
| `no-root-cause-before-readme` | No root-cause claim before README is read |
| `no-token-claim-before-config-check` | No token/config claim before config source is verified |
| `no-architecture-claim-before-docs` | No architecture claim before primary docs are read |
| `no-network-claim-before-process-check` | No network claim before process state is verified |
| `no-step-skipping` | Mandatory steps cannot be skipped |

### Library API

```typescript
import { initSession, getCurrentTools, advancePhase, isGuardrailActive } from '@lannguyensi/grounding-wrapper';

const session = initSession({ keyword: 'clawd-monitor', problem: 'agent not visible' });

// What the agent should invoke right now (advisory)
const tools = getCurrentTools(session);

// Advance after the agent completes the current phase
advancePhase(session);

// Inspect whether a guardrail applies (advisory; enforcement is external)
if (isGuardrailActive(session, 'no-root-cause-before-readme')) {
  // a Policy can use this signal to block a tool call
}

// Handle scope change mid-session
import { handleScopeChange } from '@lannguyensi/grounding-wrapper';
const updated = handleScopeChange(session, 'new-keyword');
```

Exported types: `GroundingInput`, `GroundingSession`, `GroundingStep`, `GroundingPhase`, `GuardrailId`. All types and functions are in `src/lib.ts`.

## The full grounding stack

| # | Tool | Role |
|---|------|------|
| 1 | [domain-router](../domain-router) | Scope resolution |
| 2 | [readme-first-resolver](../readme-first-resolver) | Doc reading |
| 3 | [debug-playbook-engine](../debug-playbook-engine) | Playbook sequencing |
| 4 | [runtime-reality-checker](../runtime-reality-checker) | Runtime verification |
| 5 | [evidence-ledger](../evidence-ledger) | Fact tracking |
| 6 | [claim-gate](../claim-gate) | Claim gating |
| 7 | [hypothesis-tracker](../hypothesis-tracker) | Hypothesis management |
| -> | **grounding-wrapper** | **Plans / recommends the entry path; enforcement is external** |

`runtime-reality-checker` is inserted at position 4 only for process/service-type keywords (those containing `monitor`, `agent`, `service`, `server`, or `gateway`); for other keywords `buildMandatorySequence` omits it and `evidence-ledger`/`claim-gate` shift up. The order above matches the example output for a service keyword.

## Documentation

- [Public API for enforcement](docs/enforcement-contract.md): the consumption contract a harness Policy author relies on

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
