# Agent Grounding

Verification and debugging framework for AI agents. Prevents agents from acting on stale assumptions, making unsupported claims, or silently switching hypotheses.

## Packages

### Verification
| Package | Description |
|---------|-------------|
| [runtime-reality-checker](packages/runtime-reality-checker) | Compares actual runtime state against documentation |
| [claim-gate](packages/claim-gate) | Blocks strong claims without verified evidence |
| [hypothesis-tracker](packages/hypothesis-tracker) | Tracks competing hypotheses, requires evidence to switch |

### Debugging
| Package | Description |
|---------|-------------|
| [debug-playbook-engine](packages/debug-playbook-engine) | Guides agents through domain-specific diagnostic sequences |
| [evidence-ledger](packages/evidence-ledger) | Structured evidence tracking during debugging |
| [grounding-wrapper](packages/grounding-wrapper) | Orchestrates the grounding stack — enforces correct tool order |
| [readme-first-resolver](packages/readme-first-resolver) | Forces agents to read primary docs before any analysis |
| [domain-router](packages/domain-router) | Routes keywords to correct repos, components and docs scope |

## Why this exists

AI agents are good at generating plausible explanations. They're bad at verifying them. This framework enforces discipline:

- **Don't assume** — check runtime state before diagnosing
- **Don't claim** — gate strong assertions behind evidence
- **Don't forget** — track all hypotheses, don't silently drop them
- **Don't skip steps** — follow diagnostic playbooks in order
- **Don't guess scope** — route to correct domain first

## Status

Experimental — functional tools with tests, APIs may evolve.

## Where this fits

`agent-grounding` is the **Validate** stage of the [Project OS](https://github.com/LanNguyenSi/project-os) Human-Agent Dev Lifecycle:

- [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) plans
- [agent-tasks](https://github.com/LanNguyenSi/agent-tasks) coordinates
- **agent-grounding** verifies
- [agent-preflight](https://github.com/LanNguyenSi/agent-preflight) gates pushes
