---
type: invariant
title: Solution-acceptance verdict contract — why the marker lives outside the ledger
description: A "done" verdict is derived from a real preflight+OW run, HEAD-pinned, and written to an XDG state marker outside the agent-writable evidence-ledger because ledger rows are forgeable via ledger_add.
tags: [solution-acceptance, verdicts, anti-hacking, trust-boundary]
timestamp: 2026-07-10T01:40:00.436303Z
sources:
  - packages/grounding-mcp/src/solution-verdict.ts
  - packages/grounding-mcp/src/ow-run-completeness.ts
  - packages/grounding-mcp/src/session-store.ts
  - packages/grounding-mcp/src/server.ts
  - packages/grounding-mcp/README.md
---

# Solution-acceptance verdict contract

## The invariant

A solution-acceptance verdict is **derived, never claimed**, and it is recorded to a
marker file that lives **outside the repo working tree and outside the agent-writable
evidence-ledger**. The gate passes for an `id` only when a `ready` verdict exists that
was produced at *exactly the current git HEAD*.

Four properties hold, stated verbatim as the anti-hacking contract in the header of
`packages/grounding-mcp/src/solution-verdict.ts` (lines 9-24):

1. **Derived, not claimed** — `ready` comes from preflight's real run; the caller
   supplies no result.
2. **Producer != solver** — `evaluateSolution` (line 523) *runs* preflight; the check
   set is taken from the repo's committed `.preflight.json`, not from arguments, so an
   agent cannot weaken the gate at call time.
3. **HEAD-pinned** — a verdict counts only at the HEAD it was produced at; any rework
   shifts HEAD and invalidates a green verdict (`evaluateGate`, lines 204-211, compares
   `verdict.head !== currentHead`).
4. **No stale green** — a not-ready run overwrites a prior green marker (`writeVerdict`,
   line 135, unconditionally overwrites).

The reason the marker sits outside the ledger is stated exactly at lines 19-21:

> The verdict marker lives OUTSIDE the agent-writable evidence-ledger on purpose: a
> ledger row is forgeable via `ledger_add` (the lesson behind understanding-gate moving
> its signal to a marker file).

So the verdict is a signal the solving agent's normal write path does not produce. This
is a trust-boundary decision: anything the agent can write as part of its solution diff
(ledger rows, working-tree files) cannot be the source of truth for "done".

## Where it's enforced

### Marker location — `verdictDir()` (solution-verdict.ts:91-98)

Resolution order, exactly:

1. `process.env.SOLUTION_VERDICT_DIR` (explicit override, used by tests) — returned as-is
   when non-empty.
2. else `$XDG_STATE_HOME` when set/non-empty, else `path.join(os.homedir(), '.local', 'state')`.
3. that base is joined with the fixed suffix:

   ```js
   return path.join(base, 'agent-grounding', 'solution-verdicts');
   ```

`verdictPath(id)` (line 115) is `path.join(verdictDir(), \`${sanitizeVerdictId(id)}.json\`)`.
One JSON file per `id`, deliberately outside the repo and outside the ledger.

### Path-traversal guard — `sanitizeVerdictId` (solution-verdict.ts:106-113)

```js
const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
const base = path.basename(cleaned);
if (base === '' || base === '.' || base === '..') throw ...
return base;
```

Non-portable chars collapse to `_`, then `path.basename` strips any residual separator so
`id` can never escape `verdictDir()`. Empty / dot-only ids are rejected. Its sibling
`sanitizeSessionId` in `session-store.ts:33-40` is byte-identical in logic (same regex,
same `basename`, same reject set) and explicitly documents that it mirrors
`sanitizeVerdictId` because the read verbs accept a client-controlled `sessionId` that
must be sanitised before reaching the filesystem.

### The verdict shape (7 keys, pinned)

`Verdict` (lines 52-67): `{ id, head, ready, confidence, blockers, timestamp, source }`.
`head` is a 40-hex sha; `ready` is derived; `source` is `'preflight'`. The 7-key shape is
pinned by the harness consumer — see the comment at lines 516-518. New arms (below) fold
into `ready`/`blockers` only; they do NOT add fields.

### The two MCP tools (server.ts, `PACKAGE_VERSION = '0.6.0'` at line 49)

- **`solution_evaluate`** (registered line 303) — the producer. Runs preflight against
  the repo, records a HEAD-pinned verdict for `id`. Args: `id` (min 1), optional
  `repoPath` (defaults to cwd). Calls `evaluateSolution(id, repoPath ?? process.cwd())`.
- **`solution_gate`** (registered line 319) — read-only checker. Resolves current HEAD
  via `getHeadSha`, then `evaluateGate(id, head)`. Deny reasons are precise: no verdict /
  not ready + blockers / HEAD drift / unresolvable HEAD.

`evaluateSolution` fails **closed**: if the `preflight` binary is missing (ENOENT) or its
output is unparseable, it returns an `error` and writes NO marker (lines 552-577), so the
gate stays denied via "no verdict recorded". The binary is `SOLUTION_PREFLIGHT_BIN ??
'preflight'` (line 544); preflight exits non-zero when not-ready but still prints JSON, so
a non-zero exit with parseable stdout is a normal not-ready verdict, not a failure.

### The OW process-completeness arm (cross-repo coupling)

Beyond preflight's technical floor, `solution_evaluate` folds in **orchestrator-workflow
(OW) process-completeness** via `owBlockersFor` (line 282), whose blockers are folded into
`ready` and `blockers` only (lines 584-586): `ready = pf.ready && owBlockers.length === 0`.
Each OW blocker is prefixed `orchestrator-workflow: ` (line 296).

`ow-run-completeness.ts` is a **pure, side-effect-free reader** (no subprocess, no
mutation — comment lines 7-9). Given a `repoPath`, it reads a *third* repo's OW run files
under `<repoPath>/.ai/runs/`:

- **Active run selection** (`findActiveRun`, lines 190-208): newest dated dir, only dirs
  matching `/^\d{4}-\d{2}-\d{2}-/` are eligible; name-descending sort, mtime tiebreak.
- **`06-handoff.md`** → `final-status` marker (`resolveAcceptanceValue`, line 108); must
  be in `{accepted, accepted_with_notes}` (line 74).
- **`05-review-findings.md`** → `acceptance-recommendation` marker (line 125); must be in
  `{accept, accept_with_notes}` (line 75). Plus the **findings table**: rows are located
  by anchoring on a header row whose cells include both `Severity` and `Decision`
  (`parseFindingsHeaderRow`, line 377), not by the `## Findings` heading text. A concrete
  `high`/`critical` severity row ARMS the gate UNLESS its Decision is explicitly in
  `{accepted, defer}` (`RESOLVED_DECISIONS`, line 80) — fix, reject, blank, `open`,
  `TODO`, unknown all block (fail-closed). All tables are parsed (appended second-round
  tables count); a findings section with content but no table yields an explicit format
  blocker (`findingsFormatBlocker`, line 400).
- **`00-goal.md`** → the `run-base` marker (`resolveRunBase`, line 170), raw `\S+`
  capture, `TODO` → absent. This module only *extracts* it; git verification happens in
  the verdict layer.

**Marker-first, prose fallback** throughout (`resolveAcceptanceValue`, lines 230-249): the
machine-readable `<!-- solution-acceptance: <field> = <value> -->` marker wins; only when
the field is entirely absent does it fall back to the `## <heading>` prose value. A `TODO`
or malformed marker surfaces its own blocker and never silently falls back (fail-closed).

**Change binding** (`owBindingBlockers`, solution-verdict.ts:340-389): completeness alone
would let one old accepted run keep the gate green for every later change, so the active
run must also *claim the current change*. New-kit runs carry a `run-base` sha in
`00-goal.md`; it must (1) resolve to a commit here, (2) be an ancestor of HEAD, and (3)
not lie strictly behind the fork point (merge-base of HEAD with the remote default branch).
`RUN_BASE_SHA = /^[0-9a-f]{7,40}$/i` (line 303) validates the agent-writable value BEFORE
any git call (argv-injection guard). Legacy markerless runs downgrade to a day-granular
date heuristic (lines 380-388). The knob `<repoPath>/.ai/solution-acceptance.json`
`{ "orchestratorWorkflow": "auto"|"on"|"off" }` resolves **fail-SAFE** to `auto` on any
missing/unparseable/invalid config (`resolveOwKnob`, lines 250-260) — a malformed file can
never silently disable the gate.

## What breaks it

- **Hand-writing the marker.** A shell-capable agent could still write the JSON directly
  to `verdictDir()`. This is a *documented residual* (lines 21-24): closing it needs
  signing or a harness-owned dir checked by a PreToolUse hook — harness wiring, not this
  module's job. The ledger-forge hole is closed; the shell-forge hole is knowingly open.
- **Self-serving the OW knob.** The knob is read from the agent-writable working tree, so
  an agent can write `{"orchestratorWorkflow":"off"}` to disable the OW *process* arm.
  Bounded and NOT closed (lines 26-32): it disables only the process arm; the preflight
  technical floor (lint/typecheck/test/audit/secrets) still gates regardless.
- **Committing after a green evaluate, then not re-running.** HEAD moves; `evaluateGate`
  returns `stale verdict ... (re-run solution_evaluate)`. Re-running is required after any
  change. preflight's own clean-worktree check also fails a dirty tree, so a fresh
  evaluate on uncommitted work is not-ready.
- **Evaluating at an already-pushed default-branch tip.** Pre-merge by design: the binding
  arm false-blocks (fork == HEAD), which is deliberate and pinned by a test (lines 332-338).
  The remedy in the blocker text — start a new run — matches the ship-flow, which evaluates
  before pushing.
- **Marker-shadowing in run files.** First marker match wins; a quoted mention of marker
  syntax earlier in a run file can shadow the real marker — a known non-goal, run files are
  agent-authored honor-system (ow-run-completeness.ts:22-24).

## Out-of-repo boundary note (harness consumer)

A consumer (the harness ship-flow) reads the marker to gate an action such as `pr_merge`.
This doc does not assert harness internals; the contract this repo guarantees is only the
marker's location (`verdictDir()`), its pinned 7-key shape, and the `solution_gate`
allow/deny semantics. How the harness wires those into a gate lives out of this repo.

---

## DISCREPANCIES (lead corrected against source)

- **The task lead said "grounding-mcp/README.md ~line 67 claims [the run-base marker is]
  not [emitted yet]." The README does NOT say that.** README line 67 states the opposite
  polarity: *"The `run-base` marker is written by the orchestrator-workflow kit starting
  with agent-dx task `ow-review-2026-07-01/run-binding-kit`; markerless runs stay on the
  heuristic path."* So the README asserts the marker *is* emitted, by an **external
  (agent-dx) kit task**, and treats markerless runs as the legacy/heuristic path — it does
  not claim non-emission. The accurate statement of the coupling: emission of `run-base`
  is entirely cross-repo. `agent-grounding` only *reads and verifies* it; it ships **no**
  `00-goal.md` template that emits the marker (confirmed: no `00-goal.md` template exists
  anywhere in this repo, and the only `run-base = <sha>` mentions are in README.md and
  CHANGELOG.md prose, not a template). CHANGELOG.md line 8 hedges with "`00-goal.md` *may*
  carry" the marker, consistent with emission being an external, opt-in kit behavior.
