# agent-grounding

**Verification and debugging framework for AI agents.**

## Overview

Stop agents from acting on stale assumptions, making unsupported claims, or silently switching hypotheses mid-investigation. A workspace of TypeScript packages that an agent harness wires into its session and tool-call lifecycle: a PreToolUse gate that blocks destructive commands until claims are grounded, plus MCP, SDK, and CLI surfaces over a shared evidence ledger.

> Most agent tooling helps a model *talk* about a problem. `agent-grounding` makes it *prove* what it has actually checked, what it has only assumed, and what it has ruled out, before the next destructive command runs.

`agent-grounding` is the **Validate** stage of the [Project OS](https://github.com/LanNguyenSi/project-pilot) Human-Agent Dev Lifecycle; see [docs/architecture.md](docs/architecture.md) for the full pipeline and the diagram of how the packages below connect.

## Packages

| Package | Purpose | Link |
|---------|---------|------|
| understanding-gate | Asks agents to produce an Understanding Report before acting; PreToolUse blocking of destructive tools until it is approved | [packages/understanding-gate](packages/understanding-gate) |
| runtime-reality-checker | Compares actual runtime state against documentation | [packages/runtime-reality-checker](packages/runtime-reality-checker) |
| claim-gate | Blocks strong claims without verified evidence | [packages/claim-gate](packages/claim-gate) |
| hypothesis-tracker | Tracks competing hypotheses, requires evidence to switch | [packages/hypothesis-tracker](packages/hypothesis-tracker) |
| debug-playbook-engine | Guides agents through domain-specific diagnostic sequences | [packages/debug-playbook-engine](packages/debug-playbook-engine) |
| evidence-ledger | Structured evidence tracking during debugging | [packages/evidence-ledger](packages/evidence-ledger) |
| grounding-wrapper | Plans grounding sessions (tool sequence, guardrails, phases); pure planner, enforcement is external | [packages/grounding-wrapper](packages/grounding-wrapper) |
| readme-first-resolver | Forces agents to read primary docs before any analysis | [packages/readme-first-resolver](packages/readme-first-resolver) |
| domain-router | Routes keywords to correct repos, components, and docs scope | [packages/domain-router](packages/domain-router) |
| grounding-sdk | `verify`/`track`/`validate`, ergonomic in-process facade over the stack | [packages/grounding-sdk](packages/grounding-sdk) |
| review-claim-gate | `merge_approval` gate for PR-review subagents, fails closed unless tests pass, the checklist is complete, and evidence-ledger has an entry | [packages/review-claim-gate](packages/review-claim-gate) |
| grounding-mcp | JSON-RPC MCP server exposing `ledger_add` / `ledger_summary` / `claim_evaluate_from_session` to any MCP-speaking client; also ships the restricted `grounding-assessment-mcp` producer (see [docs/architecture.md](docs/architecture.md)) | [packages/grounding-mcp](packages/grounding-mcp) |

## Quick start

```bash
git clone https://github.com/LanNguyenSi/agent-grounding && cd agent-grounding
npm install && npm run build
```

Every package is also published under the `@lannguyensi/` scope and installable directly from npm; see [docs/installation.md](docs/installation.md) for the full per-package list.

## Usage

```bash
LEDGER="node packages/evidence-ledger/dist/cli.js"

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

`evidence-ledger` is the headline package: every fact carries a source, every hypothesis lives separately from facts, rejected hypotheses stay visible, unknowns are acknowledged. The CLI is one of three surfaces; there's also a typed library API (`@lannguyensi/evidence-ledger`) and a JSON-RPC server (`grounding-mcp`) that any MCP client can call. Entries land in `~/.evidence-ledger/ledger.db`; see [docs/installation.md](docs/installation.md) for sample output.

## Documentation

- [docs/architecture.md](docs/architecture.md): the stack diagram, why the framework exists, where it fits in Project OS, and the restricted assessment producer.
- [docs/installation.md](docs/installation.md): the full per-package npm install list and sample CLI output.
- [docs/policy-runtime-reality.md](docs/policy-runtime-reality.md): the design for wiring `runtime-reality-checker` as a harness PreToolUse policy.
- [docs/design/](docs/design): design notes for specific subsystems (e.g. the `solution_evaluate` call lifecycle).
- [docs/testing/](docs/testing): rollout and dogfood notes for specific test suites.
- [docs/okf/](docs/okf): the curated knowledge bundle (cross-file semantics, invariants, runbooks); CI-gated, see `docs/okf/log.md` for its history.

## Development and contributing

```sh
npm install
npm run build
npm test -w packages/<name>
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full build topology, the single-package test/build commands, and the release-cut checklist.

## License

[MIT](./LICENSE). Experimental: functional tools with tests, APIs may evolve. Each package has its own README with install and usage; this top-level README is a routing index.
