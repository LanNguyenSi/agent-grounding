---
type: invariant
title: Solution-acceptance verdict contract — why the marker lives outside the ledger
description: A "done" verdict is derived from a real preflight+OW run, HEAD-pinned, and written to an XDG state marker outside the agent-writable evidence-ledger because ledger rows are forgeable via ledger_add.
tags: [solution-acceptance, verdicts, anti-hacking, trust-boundary]
timestamp: 2026-08-19T09:24:20Z
sources:
  - packages/grounding-mcp/src/solution-verdict.ts
  - packages/grounding-mcp/src/verdict-signing.ts
  - packages/grounding-mcp/src/ow-run-completeness.ts
  - packages/grounding-mcp/src/session-store.ts
  - packages/grounding-mcp/src/server.ts
  - packages/grounding-mcp/tests/interop/harness-verifier.vendored.ts
  - packages/grounding-mcp/tests/interop/verdict-signing-interop.test.ts
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
2. **Producer != solver**: `evaluateSolution` (line 544) *runs* preflight; the check
   set is taken from the repo's committed `.preflight.json`, not from arguments, so an
   agent cannot weaken the gate at call time.
3. **HEAD-pinned** — a verdict counts only at the HEAD it was produced at; any rework
   shifts HEAD and invalidates a green verdict (`evaluateGate`, lines 225-232, compares
   `verdict.head !== currentHead`).
4. **No stale green** — a not-ready run overwrites a prior green marker (`writeVerdict`,
   line 159, unconditionally overwrites via `fs.writeFileSync`).

The reason the marker sits outside the ledger is stated exactly at lines 19-21:

> The verdict marker lives OUTSIDE the agent-writable evidence-ledger on purpose: a
> ledger row is forgeable via `ledger_add` (the lesson behind understanding-gate moving
> its signal to a marker file).

So the verdict is a signal the solving agent's normal write path does not produce. This
is a trust-boundary decision: anything the agent can write as part of its solution diff
(ledger rows, working-tree files) cannot be the source of truth for "done".

## Where it's enforced

### Marker location: `verdictDir()` (solution-verdict.ts:103-110)

Resolution order, exactly:

1. `process.env.SOLUTION_VERDICT_DIR` (explicit override, used by tests) — returned as-is
   when non-empty.
2. else `$XDG_STATE_HOME` when set/non-empty, else `path.join(os.homedir(), '.local', 'state')`.
3. that base is joined with the fixed suffix:

   ```js
   return path.join(base, 'agent-grounding', 'solution-verdicts');
   ```

`verdictPath(id)` (line 127) is `path.join(verdictDir(), \`${sanitizeVerdictId(id)}.json\`)`.
One JSON file per `id`, deliberately outside the repo and outside the ledger.

### Path-traversal guard: `sanitizeVerdictId` (solution-verdict.ts:118-125)

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

### The verdict shape (7 pinned keys + 2 additive signing fields)

`Verdict` (lines 53-79): the 7 pinned keys `{ id, head, ready, confidence, blockers,
timestamp, source }` (lines 53-67), plus, since 0.8.0, two additive OPTIONAL fields
`alg?` (line 76) and `signature?` (line 78). `head` is a 40-hex sha; `ready` is derived;
`source` is `'preflight'`. The 7-key shape is pinned by the harness consumer; see the
comment at lines 536-537 (and its echo at line 602). New arms (OW, below) fold into
`ready`/`blockers` only; they do NOT add fields. `alg`/`signature` are the one addition
to that pinning rule, and deliberately additive-only (see "Verdict marker signing"
below): they are optional on the TypeScript type only because a hand-constructed
`Verdict` inside `evaluateSolution` has not been signed yet at construction time;
every marker `writeVerdict` actually puts on disk carries both, unconditionally.

### Verdict marker signing (0.8.0): `verdict-signing.ts`

Since 0.8.0, `writeVerdict` (solution-verdict.ts:155-161) no longer writes the 7 pinned
fields alone: it calls `signVerdict(resolveGeneratedDir(), verdict)` (line 157, from the
new `src/verdict-signing.ts`) BEFORE writing, and persists the signed copy. There is no
unsigned fallback: signing is unconditional (D-002, task 9b6c4beb / grounding-mcp
CHANGELOG 0.8.0): an unsigned-when-no-key escape hatch would reproduce exactly the
"producer doesn't sign" universal-deny failure mode this feature exists to close.

- **Same key file, same scheme, no package dependency (D-001).** `verdict-signing.ts`
  independently mirrors the harness CONSUMER's signing/verification implementation
  (`src/runtime/approval-signing.ts`, `src/policy-packs/builtin/solution-acceptance-runtime.ts`
  on harness branch `batch19/sign-verdict-marker`) field-for-field and byte-for-byte,
  the same independent-mirroring convention `verdictDir()`/`sanitizeVerdictId()` above
  already use, with no runtime dependency between the two repos' packages.
- **Key path**: `signingKeyPathFor(generatedDir)` (verdict-signing.ts:134-136) is
  `<generatedDir>/.approval-signing.key` (`SIGNING_KEY_BASENAME`, line 41), and
  `resolveGeneratedDir()` (line 129) is `<harness-home>/harness.generated`
  (`GENERATED_DIRNAME`, line 44), so the full path is
  `<harness-home>/harness.generated/.approval-signing.key`.
- **`<harness-home>` resolution**: `resolveHarnessHome()` (verdict-signing.ts:98-108),
  mirrors harness `resolveHomeDir`. Precedence, exactly:
  1. `$HARNESS_HOME` env var, if non-empty (also the test-isolation knob).
  2. `~/.harness/` if it already exists on disk (`existsDir`, lines 110-116).
  3. `~/.claude/` (legacy) if it carries harness state, either `harness.yaml` or a
     `harness.generated/` subdir (`legacyHasHarnessState`, lines 118-126).
  4. else `~/.harness/`, the create-on-first-use default (no `--home` CLI-flag tier
     here; grounding-mcp has no such flag to mirror).
- **`getOrCreateSigningKey(generatedDir)` (verdict-signing.ts:154-191).** Reads an
  existing key file when it is `>= 32` bytes; otherwise generates
  `crypto.randomBytes(32)` and writes it at mode `0600` with the exclusive `wx` flag
  (an `EEXIST` from a concurrent creator is read back rather than clobbered: race
  tolerant, "whoever runs first creates, both sides share the same file"). A key file
  shorter than 32 bytes is treated as corrupt and unconditionally regenerated
  (truncated-key repair).
- **Signed payload**: `canonicalPayload`/`signMarker`/`signVerdict` (verdict-signing.ts:
  206-213, 228-246, 282-299). `markerId = verdictMarkerId(verdict.id)` =
  `'solution-verdict-' + id` (`VERDICT_MARKER_ID_PREFIX`, line 64); the HMAC-SHA256 hex
  signature is computed over `JSON.stringify({ markerId, approvedAt, approvedBy,
  reportContentHash })` in that FIXED key order, with `approvedAt <- verdict.timestamp`,
  `approvedBy <- verdict.source`, and `reportContentHash` = a sha256 hex digest of
  `JSON.stringify({ head, ready, confidence, blockers })` (also fixed key order), so
  the signature transitively covers `head`/`ready`/`confidence`/`blockers` even though
  they have no dedicated slot in the payload tuple. `alg` is the versioned tag
  `'hmac-sha256-v1'` (`SIGNING_ALG`, line 38). Binding `markerId` (hence `verdict.id`)
  into the signed bytes is what makes a copy-and-relabel of a validly-signed marker
  onto a different id's lookup path fail signature verification.
- **On a harness-less machine, this creates `~/.harness/harness.generated/` and the key
  file as a side effect of the FIRST signed verdict** (D-002, documented, not a bug):
  the producer always signs, so `getOrCreateSigningKey` always runs, and its
  `fs.mkdirSync(generatedDir, { recursive: true })` creates the directory tree if
  nothing else on that machine already has.
- **Threat model, unchanged from harness' own posture:** this is pragmatic
  defense-in-depth, not a new authorization boundary: the key is read under the SAME
  UID `grounding-mcp` and a shell-capable forger both run under, so signing does not
  stop a shell-capable agent from reading (or first-creating) the key and computing a
  valid signature itself. What it closes is casual/accidental forgery: a marker cannot
  be hand-typed by a tool unaware of the key file, and any content mutation after
  signing (intentional or a bug) invalidates the signature and is rejected as forged.
  See "What breaks it" below.
- **The "genuinely unsigned, not forged" carve-out is narrower than it may sound (T-002
  finding, corrected from an earlier plan paraphrase).** The harness consumer's
  `evaluateGate` classifies a marker `forged: false` ("treating as unsigned, not
  forged") ONLY when a required signed field reads blank (`verdict.timestamp` or
  `verdict.source` mapping to an empty `approvedAt`/`approvedBy`) AND `alg` and
  `signature` are BOTH absent from the marker. A realistic legacy marker, one written
  by a pre-0.8.0 grounding-mcp, with a perfectly valid `timestamp`/`source` and simply
  no `alg`/`signature` fields at all, does NOT hit that narrow reason; it hits the
  generic "missing signature (legacy pre-signing marker, or forged file)" branch
  instead and is classified `forged: true`. Proven by
  `packages/grounding-mcp/tests/interop/verdict-signing-interop.test.ts`, describe
  block "signature AND alg both removed, timestamp/source still valid => STILL
  forged:true, not the carve-out", which matches harness' own golden-fixture assertion
  for its pre-`c7c3f606` 0.3.2/0.5.0 markers. This is the exact mechanism behind the
  CHANGELOG 0.8.0 release-sequencing warning: releasing the harness consumer before
  every producer is on 0.8.0 denies the completion gate universally, not selectively.
- **Drift guard: the interop suite (`packages/grounding-mcp/tests/interop/`).**
  `harness-verifier.vendored.ts` is a TEST-ONLY, source-stamped (branch + file + line
  citations in its header) transcription of the harness consumer's verification logic,
  deliberately NOT derived from this package's own producer mirror (copying the
  producer to test itself would not catch a drift between the two independently
  mirrored implementations; that drift is exactly the risk D-003 names).
  `verdict-signing-interop.test.ts` (14 tests) runs the REAL `writeVerdict` against a
  tempdir `HARNESS_HOME`, reads the marker back off disk, and feeds it to the vendored
  verifier: a positive round-trip, tamper negatives (`ready`/`head`/`confidence`/
  `blockers`/one signature byte each independently flipped), cross-id replay at both
  the signature-binding layer and the belt-and-braces `verdict.id !== id` layer, `alg`
  negatives, and the carve-out-vs-generic-forged distinction above. Any drift between
  this producer and the harness consumer that would silently break verification is
  meant to surface here first.

### The two MCP tools (server.ts, `PACKAGE_VERSION = '0.8.0'` at line 49)

- **`solution_evaluate`** (registered line 316) — the producer. Runs preflight against
  the repo, records a HEAD-pinned verdict for `id`. Args: `id` (min 1), optional
  `repoPath` (defaults to cwd). Calls `evaluateSolution(id, repoPath ?? process.cwd())`.
- **`solution_gate`** (registered line 332) — read-only checker. Resolves current HEAD
  via `getHeadSha`, then `evaluateGate(id, head)`. Deny reasons are precise: no verdict /
  not ready + blockers / HEAD drift / unresolvable HEAD.

`evaluateSolution` fails **closed**: an invalid `id`, an unresolvable git HEAD, a missing
`preflight` binary (ENOENT), or unparseable preflight output all return an `error` and
write NO marker (lines 549-599), so the gate stays denied via "no verdict recorded". The
binary is `SOLUTION_PREFLIGHT_BIN ?? 'preflight'` (line 565); preflight exits non-zero
when not-ready but still prints JSON, so a non-zero exit with parseable stdout is a normal
not-ready verdict, not a failure. `writeVerdict`, and therefore signing, is only ever
reached (line 618) on a successfully parsed, non-error result.

### The OW process-completeness arm (cross-repo coupling)

Beyond preflight's technical floor, `solution_evaluate` folds in **orchestrator-workflow
(OW) process-completeness** via `owBlockersFor` (line 303), whose blockers are folded into
`ready` and `blockers` only (lines 601-607): `ready = pf.ready && owBlockers.length === 0`
(line 606). Each OW blocker is prefixed `orchestrator-workflow: ` (line 317).

`ow-run-completeness.ts` is a **pure, side-effect-free reader** (no subprocess, no
mutation — comment line 3, spelled out again at lines 9-11: "This module only READS...
nothing here writes, spawns, or mutates"). Given a `repoPath`, it reads a *third* repo's
OW run files under `<repoPath>/.ai/runs/`:

- **Active run selection** (`findActiveRun`, lines 250-268): newest dated dir, only dirs
  matching `/^\d{4}-\d{2}-\d{2}-/` are eligible; name-descending sort, mtime tiebreak.
- **`06-handoff.md`** → `final-status` marker (`resolveAcceptanceValue`, line 155); must
  be in `{accepted, accepted_with_notes}` (line 101).
- **`05-review-findings.md`** → `acceptance-recommendation` marker (line 172); must be in
  `{accept, accept_with_notes}` (line 102). Plus the **findings table**: rows are located
  by anchoring on a header row whose cells include both `Severity` and `Decision`
  (`parseFindingsHeaderRow`, line 476), not by the `## Findings` heading text. A concrete
  `high`/`critical` severity row ARMS the gate UNLESS its Decision is explicitly in
  `{accepted, defer}` (`RESOLVED_DECISIONS`, line 107) — fix, reject, blank, `open`,
  `TODO`, unknown all block (fail-closed). All tables are parsed (appended second-round
  tables count); a findings section with content but no table yields an explicit format
  blocker (`findingsFormatBlocker`, line 499).
- **Mixed-state bypass guard** (task `8f173547`): completeness above is not enough —
  an operator could flip the acceptance markers to an accepted value without ever
  transferring the reviewer's findings into the table. `scanFindings` (lines 397-455)
  additionally tracks whether the shipped review template's placeholder/legend row
  survived untouched (`placeholderRowSeen`, matched byte-exactly cell-by-cell by
  `isPlaceholderRow`, lines 462-467, against `OW_FINDINGS_PLACEHOLDER_ROW`, lines
  121-122) and whether any row anywhere carries a real concrete severity
  (`concreteRowSeen`). When the placeholder row survived AND no concrete row was ever
  seen, `readOwRunCompleteness` blocks with `complete: false` (lines 198-208), naming
  both escape hatches: transfer the reviewer's findings into the table, or delete the
  placeholder row for a genuine zero-findings review. A header row with no data rows at
  all (the placeholder already deleted) still reads `complete: true`, and a concrete
  finding row sitting next to a left-behind placeholder row is unaffected.
- **`00-goal.md`** → the `run-base` marker (`resolveRunBase`, line 230), raw `\S+`
  capture, `TODO` → absent. This module only *extracts* it; git verification happens in
  the verdict layer.

**Marker-first, prose fallback** throughout (`resolveAcceptanceValue`, lines 290-309): the
machine-readable `<!-- solution-acceptance: <field> = <value> -->` marker wins; only when
the field is entirely absent does it fall back to the `## <heading>` prose value. A `TODO`
or malformed marker surfaces its own blocker and never silently falls back (fail-closed).

**Change binding** (`owBindingBlockers`, solution-verdict.ts:361-410): completeness alone
would let one old accepted run keep the gate green for every later change, so the active
run must also *claim the current change*. New-kit runs carry a `run-base` sha in
`00-goal.md`; it must (1) resolve to a commit here, (2) be an ancestor of HEAD, and (3)
not lie strictly behind the fork point (merge-base of HEAD with the remote default branch).
`RUN_BASE_SHA = /^[0-9a-f]{7,40}$/i` (line 324) validates the agent-writable value BEFORE
any git call (argv-injection guard). Legacy markerless runs downgrade to a day-granular
date heuristic (lines 401-409). The knob `<repoPath>/.ai/solution-acceptance.json`
`{ "orchestratorWorkflow": "auto"|"on"|"off" }` resolves **fail-SAFE** to `auto` on any
missing/unparseable/invalid config (`resolveOwKnob`, lines 271-281); a malformed file can
never silently disable the gate.

## What breaks it

- **Hand-writing the marker, still not a closed hole under shared UID.** As of 0.8.0
  every marker is signed (see "Verdict marker signing" above), so a naive hand-typed
  JSON file (no `alg`/`signature`, or a wrong signature) is rejected by the harness
  consumer as forged. But this is explicitly pragmatic defense-in-depth, not a new
  authorization boundary: a shell-capable agent runs under the SAME UID that reads and
  first-creates `<harness-home>/harness.generated/.approval-signing.key`, so it could
  read that key and compute a valid signature too, same as the harness consumer's own
  documented threat model. The residual comment at solution-verdict.ts:19-24 (unchanged
  since before 0.8.0) still names "signing... is the harness wiring follow-up" as the
  next step for this specific residual; that step is what this task's producer-side
  half delivers, paired with the harness CONSUMER wiring (task `c7c3f606`, merge-held
  pending the release sequencing in the grounding-mcp 0.8.0 CHANGELOG entry). The
  ledger-forge hole was closed earlier (marker moved outside the ledger); the
  shell-forge hole is now *harder* (a forger needs the shared key, not just a text
  editor), but still open under a same-UID threat model, by design.
- **Self-serving the OW knob.** The knob is read from the agent-writable working tree, so
  an agent can write `{"orchestratorWorkflow":"off"}` to disable the OW *process* arm.
  Bounded and NOT closed (lines 26-32): it disables only the process arm; the preflight
  technical floor (lint/typecheck/test/audit/secrets) still gates regardless.
- **Committing after a green evaluate, then not re-running.** HEAD moves; `evaluateGate`
  returns `stale verdict ... (re-run solution_evaluate)`. Re-running is required after any
  change. preflight's own clean-worktree check also fails a dirty tree, so a fresh
  evaluate on uncommitted work is not-ready.
- **Evaluating at an already-pushed default-branch tip.** Pre-merge by design: the binding
  arm false-blocks (fork == HEAD), which is deliberate and pinned by a test (lines 353-360).
  The remedy in the blocker text — start a new run — matches the ship-flow, which evaluates
  before pushing.
- **Marker-shadowing in run files.** First marker match wins; a quoted mention of marker
  syntax earlier in a run file can shadow the real marker — a known non-goal, run files are
  agent-authored honor-system (ow-run-completeness.ts:24-26).

## Out-of-repo boundary note (harness consumer)

A consumer (the harness ship-flow) reads the marker to gate an action such as `pr_merge`.
This doc does not assert harness internals; the contract this repo guarantees is only the
marker's location (`verdictDir()`), its pinned 7-key shape plus (since 0.8.0) the two
additive signing fields `alg`/`signature` and the exact HMAC scheme + key-file contract
those are computed against ("Verdict marker signing" above), and the `solution_gate`
allow/deny semantics. How the harness wires those into a gate, including its
`forged`-classification carve-out logic, lives out of this repo; this doc's account of
that carve-out is a read of the harness source at a stamped commit (see the interop
suite's vendored-verifier header), measured via the interop suite, not assumed.

## Where the `run-base` marker comes from

The `run-base` marker this module verifies is **not emitted by this repo**. It is
written into `00-goal.md` by the orchestrator-workflow kit (agent-dx); this repo
ships no `00-goal.md` template and only *reads and verifies* the marker
(`grounding-mcp/README.md`). Runs that predate the kit change carry no marker and
fall back to the day-granular date heuristic. Treat marker emission as a
cross-repo contract owned by agent-dx, and the verification semantics above as
owned here.
