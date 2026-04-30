# agent-grounding

**Verification and debugging framework for AI agents.**

Stop agents from acting on stale assumptions, making unsupported claims, or silently switching hypotheses mid-investigation. A workspace of TypeScript packages (evidence ledger, claim gate, hypothesis tracker, runtime reality checker, debug playbook engine, domain router, MCP server) that an agent harness wires into its session and tool-call lifecycle.

> Most agent tooling helps a model *talk* about a problem. `agent-grounding` makes it *prove* what it has actually checked, what it has only assumed, and what it has ruled out, before the next destructive command runs.

## Try it in 60 seconds

```bash
git clone https://github.com/LanNguyenSi/agent-grounding && cd agent-grounding
npm install && npm run build

# Run the demo against a scratch session so it doesn't pollute the default ledger
LEDGER="node packages/evidence-ledger/dist/cli.js"
$LEDGER clear --session readme-demo  # no-op on first run

$LEDGER fact "process is not running" \
  --source "ps aux | grep clawd-monitor" \
  --confidence high \
  --session readme-demo

$LEDGER hypothesis "OOM killer terminated the process" \
  --source "dmesg output" \
  --confidence medium \
  --session readme-demo

$LEDGER show --session readme-demo
```

`evidence-ledger` is the headline package: every fact carries a source, every hypothesis lives separately from facts, rejected hypotheses stay visible, unknowns are acknowledged. The CLI is one of three surfaces; there's also a typed library API (`@lannguyensi/evidence-ledger`) and a JSON-RPC server (`grounding-mcp`) that any MCP client can call. Entries land in `~/.evidence-ledger/ledger.db`; per-session isolation keeps demo data out of your real debugging sessions.

## What a run looks like

```
✓ Fact recorded:

  ✓ [#26] process is not running (ps aux | grep clawd-monitor)  HIGH

? Hypothesis added:

  ? [#27] OOM killer terminated the process (dmesg output)  MED


📋 Evidence Ledger — session: readme-demo
   2 entries total

✓ FACTS (1)
  ✓ [#26] process is not running (ps aux | grep clawd-monitor)  HIGH

? HYPOTHESES (1)
  ? [#27] OOM killer terminated the process (dmesg output)  MED
```

(Entry IDs autoincrement globally across sessions, so your numbers will differ.)

Same data via `ledger export --session readme-demo` produces structured JSON for hand-off to another agent or a human. Same data via `grounding-mcp`'s `ledger_summary` verb is what `harness explain --trace` and `harness audit` consume to replay policy decisions; see [the harness integration](https://github.com/LanNguyenSi/harness) for the wiring.

## Next steps

| If you want to... | Read |
|------|------|
| Track facts / hypotheses / rejected ideas / unknowns during a debugging session | [`packages/evidence-ledger`](packages/evidence-ledger) |
| Block strong claims until evidence backs them | [`packages/claim-gate`](packages/claim-gate) |
| Manage competing hypotheses and require evidence to switch between them | [`packages/hypothesis-tracker`](packages/hypothesis-tracker) |
| Compare actual runtime state against documentation | [`packages/runtime-reality-checker`](packages/runtime-reality-checker) |
| Guide an agent through a domain-specific diagnostic sequence | [`packages/debug-playbook-engine`](packages/debug-playbook-engine) |
| Force an agent to read primary docs before any analysis | [`packages/readme-first-resolver`](packages/readme-first-resolver) |
| Route a keyword to the right repos / components / docs scope | [`packages/domain-router`](packages/domain-router) |
| Use a single ergonomic facade (`verify` / `track` / `validate`) over the stack | [`packages/grounding-sdk`](packages/grounding-sdk) |
| Gate `merge_approval` on tests + checklist + evidence-ledger entry | [`packages/review-claim-gate`](packages/review-claim-gate) |
| Ask agents to produce an Understanding Report before acting | [`packages/understanding-gate`](packages/understanding-gate) |
| Wire the stack into an MCP-speaking client (Claude Code, Codex, OpenCode) | [`packages/grounding-mcp`](packages/grounding-mcp) |
| Orchestrate the stack — enforce correct tool order | [`packages/grounding-wrapper`](packages/grounding-wrapper) |

## Packages

### Pre-execution
| Package | Description |
|---------|-------------|
| [understanding-gate](packages/understanding-gate) | Asks agents to produce an Understanding Report before acting (Phase -1 docs, Phase 0 in progress) |

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

### SDK
| Package | Description |
|---------|-------------|
| [grounding-sdk](packages/grounding-sdk) | `verify`/`track`/`validate` — ergonomic in-process facade over the stack |
| [review-claim-gate](packages/review-claim-gate) | `merge_approval` gate for PR-review subagents — fails closed unless tests pass, the checklist is complete, and ≥1 evidence-ledger entry exists |

### Integration
| Package | Description |
|---------|-------------|
| [grounding-mcp](packages/grounding-mcp) | JSON-RPC MCP server that exposes `ledger_add` / `ledger_summary` / `claim_evaluate_from_session` to any MCP-speaking client |

## Why this exists

AI agents are good at generating plausible explanations. They're bad at verifying them. This framework enforces discipline:

- **Don't assume** — check runtime state before diagnosing.
- **Don't claim** — gate strong assertions behind evidence.
- **Don't forget** — track all hypotheses, don't silently drop them.
- **Don't skip steps** — follow diagnostic playbooks in order.
- **Don't guess scope** — route to the correct domain first.

The motivating incident lives in an internal logbook: an agent investigated two `agent-grounding` tasks against a checkout that was 16 commits behind origin, declared both "stale" because the relevant directories didn't exist locally, and only caught the drift hours later when a third task forced a fresh `git pull`. Two corrections had to be walked back. The check that would have caught it (`git fetch && git status` before any structural claim) is exactly what `runtime-reality-checker` + `claim-gate` enforce — given a runtime that consults them.

## Status

Experimental — functional tools with tests, APIs may evolve. Each package has its own README with install + usage; this top-level README is a routing index.

## Where this fits

`agent-grounding` is the **Validate** stage of the [Project OS](https://github.com/LanNguyenSi/project-os) Human-Agent Dev Lifecycle:

- [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) plans
- [agent-tasks](https://github.com/LanNguyenSi/agent-tasks) coordinates
- **agent-grounding** verifies
- [agent-preflight](https://github.com/LanNguyenSi/agent-preflight) gates pushes
- [harness](https://github.com/LanNguyenSi/harness) declares + enforces the policy boundary that calls into all of the above
