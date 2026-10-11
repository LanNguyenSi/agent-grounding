# agent-grounding

**Verification and debugging framework for AI agents.**

## Overview

Stop agents from acting on stale assumptions, making unsupported claims, or silently switching hypotheses mid-investigation. A workspace of TypeScript packages that an agent harness wires into its session and tool-call lifecycle: PreToolUse hooks that block destructive tools until an Understanding Report is approved (`understanding-gate`) or, when the host supplies a process probe, on critical runtime drift (`runtime-reality-checker`); and access surfaces (an MCP server, an in-process SDK, and CLIs) for evidence, claims and hypotheses. The evidence ledger is the store behind `grounding-mcp`, `review-claim-gate` and the `ledger` CLI.

> Most agent tooling helps a model *talk* about a problem. `agent-grounding` makes it *prove* what it has actually checked, what it has only assumed, and what it has ruled out, before the next destructive command runs.

`agent-grounding` is part of the agent runtime layer of the [Project OS toolchain](https://github.com/LanNguyenSi/project-pilot/blob/main/docs/ecosystem.md): it verifies agents at every lifecycle stage rather than at one. See [docs/architecture.md](docs/architecture.md) for how the packages below connect.

## Packages

| Package | Purpose | Link |
|---------|---------|------|
| understanding-gate | Asks agents to produce an Understanding Report before acting; PreToolUse blocking of destructive tools until it is approved | [packages/understanding-gate](packages/understanding-gate) |
| runtime-reality-checker | Compares actual runtime state against documentation | [packages/runtime-reality-checker](packages/runtime-reality-checker) |
| claim-gate | Blocks strong claims until the caller declares the required checks (docs read, process and config checked, evidence, alternatives); the inputs are self-reported | [packages/claim-gate](packages/claim-gate) |
| hypothesis-tracker | Tracks competing hypotheses with their required checks, evidence and status | [packages/hypothesis-tracker](packages/hypothesis-tracker) |
| debug-playbook-engine | Guides agents through domain-specific diagnostic sequences | [packages/debug-playbook-engine](packages/debug-playbook-engine) |
| evidence-ledger | Structured evidence tracking during debugging | [packages/evidence-ledger](packages/evidence-ledger) |
| grounding-wrapper | Plans grounding sessions (tool sequence, guardrails, phases); pure planner, enforcement is external | [packages/grounding-wrapper](packages/grounding-wrapper) |
| readme-first-resolver | Checks that primary docs exist and were read before analysis; reports readiness, enforces nothing itself | [packages/readme-first-resolver](packages/readme-first-resolver) |
| domain-router | Routes keywords to correct repos, components, and docs scope | [packages/domain-router](packages/domain-router) |
| grounding-sdk | `verify`/`track`/`validate`, ergonomic in-process facade over the stack | [packages/grounding-sdk](packages/grounding-sdk) |
| review-claim-gate | `merge_approval` gate for PR review: fails closed unless all five prerequisites hold (tests, checklist, comments resolved, scope, evidence logged via a committed evidence file or an evidence-ledger entry) | [packages/review-claim-gate](packages/review-claim-gate) |
| grounding-mcp | MCP server (stdio) for grounding sessions, the evidence ledger, claim evaluation, hypothesis tracking, solution-acceptance gating and memory-reference checks (tool table in its README); also ships the restricted `grounding-assessment-mcp` producer (see [docs/architecture.md](docs/architecture.md)) | [packages/grounding-mcp](packages/grounding-mcp) |

## Quick start

Requires Node.js 20 or later and npm.

```bash
git clone https://github.com/LanNguyenSi/agent-grounding && cd agent-grounding
npm install && npm run build
```

Every package is also published under the `@lannguyensi/` scope and installable directly from npm; see [docs/installation.md](docs/installation.md) for the full per-package list.

## Usage

```bash
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

The `readme-demo` session keeps demo entries out of your real sessions.

`evidence-ledger` is the headline package: every fact can carry its source, every hypothesis lives separately from facts, rejected hypotheses stay visible, unknowns are acknowledged. The CLI is one of three surfaces; there's also a typed library API (`@lannguyensi/evidence-ledger`) and a JSON-RPC server (`grounding-mcp`) that any MCP client can call. Entries land in `~/.evidence-ledger/ledger.db`; see [docs/installation.md](docs/installation.md) for sample output.

## Documentation

- [docs/architecture.md](docs/architecture.md): the stack diagram, why the framework exists, where it fits in Project OS, the trust model of each gate, and the restricted assessment producer.
- [docs/installation.md](docs/installation.md): the full per-package npm install list and sample CLI output.
- [docs/policy-runtime-reality.md](docs/policy-runtime-reality.md): the `runtime-reality-checker` PreToolUse policy (triggers, expectations, decisions) and the harness hook that supplies its probe.
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
