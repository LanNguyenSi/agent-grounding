# Agent Grounding

Verification framework for AI agents. Prevents agents from acting on stale assumptions, making unsupported claims, or silently switching hypotheses.

## Packages

| Package | Description |
|---------|-------------|
| [runtime-reality-checker](packages/runtime-reality-checker) | Compares actual runtime state against documentation. Surfaces drift between what's documented and what's running. |
| [claim-gate](packages/claim-gate) | Policy engine that blocks strong claims without verified evidence. Evaluates diagnostic claims against prerequisite checks. |
| [hypothesis-tracker](packages/hypothesis-tracker) | Tracks competing hypotheses during debugging. Requires explicit evidence before switching or discarding theories. |

## Why this exists

AI agents are good at generating plausible explanations. They're bad at verifying them. This framework enforces verification discipline:

- **Don't assume** — check runtime state before diagnosing
- **Don't claim** — gate strong assertions behind evidence
- **Don't forget** — track all hypotheses, don't silently drop them

## Setup

```bash
npm install
npm test --workspaces
```

## Structure

```
agent-grounding/
├── packages/
│   ├── runtime-reality-checker/   # Runtime state vs documentation
│   ├── claim-gate/                # Evidence-gated claims
│   └── hypothesis-tracker/        # Competing hypothesis management
└── package.json                   # Workspace root
```

## Status

Experimental — these tools are functional and tested but APIs may evolve.
