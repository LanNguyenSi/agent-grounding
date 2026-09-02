# grounding-mcp

MCP server that exposes the [agent-grounding](../../) stack, `grounding-wrapper`, `evidence-ledger`, `claim-gate`, `runtime-reality-checker`, as tools a long-running Claude Code session can call directly. Sits between the agent and the framework so a debug task can be framed, tracked, and gated without subprocess plumbing.

## Why

The other packages in this repo are CLI-first. That works fine for scripted invocations but is awkward inside a live Claude Code session: each call is a fresh subprocess, sessions don't survive across turns, and there's no shared evidence ledger between phases. This server keeps a single ledger DB open and persists each grounding session to its own JSON file so the agent can resume across hours and process restarts.

## Tool catalog

| Tool | Wraps | What it does |
|---|---|---|
| `grounding_start` | `grounding-wrapper.initSession` | Open a new session for `(keyword, problem)`. Returns the session id, mandatory tool sequence, and active guardrails. |
| `grounding_advance` | `grounding-wrapper.advancePhase` | Mark current phase done, move to next. |
| `grounding_guardrail_check` | `grounding-wrapper.isGuardrailActive` | Is a specific guardrail active right now? |
| `ledger_add` | `evidence-ledger.addEntry` | Append a fact / hypothesis / rejected / unknown to the session's ledger namespace. |
| `ledger_summary` | `evidence-ledger.getSummary` | Return all entries for a session, grouped by type, with counts. |
| `ledger_status` | `ledger-bridge.ledgerStatus` | No-arg ledger reachability + stats probe (entry count, db path, last-write timestamp) for harness MCP health checks; no session required. |
| `claim_evaluate` | `claim-gate.evaluateClaim` | Run a claim through the gate with caller-supplied context. |
| `claim_evaluate_from_session` | claim-gate + grounding-wrapper + evidence-ledger | Same, but auto-derive the context from the session's phase status + ledger entries. The default path. |
| `solution_evaluate` | `solution-verdict` + `preflight` CLI | Run preflight against a repo and record a HEAD-pinned solution-acceptance verdict for an id, derived from preflight's real results. Earn "done" instead of claiming it. See below. |
| `solution_gate` | `solution-verdict.evaluateGate` | Allowed only if a ready verdict exists at the current git HEAD; else a precise deny reason (no verdict / not ready / HEAD drift). |
| `verify_memory_reference` | `runtime-reality-checker.verifyMemoryReference` | Check whether a memory-referenced path / symbol / flag still exists in the repo. Call before recommending anything from a memory that cites a concrete file, function, or flag. |
| `hypothesis_record` | `hypothesis-tracker.addHypothesis` | Add a competing hypothesis with required checks. Use when you can name more than one possible cause. |
| `hypothesis_list` | `hypothesis-tracker.getSummary` | List all hypotheses for a session plus summary counts. Use before claiming a root cause. |
| `hypothesis_evidence` | `hypothesis-tracker.addEvidence` | Attach evidence to a hypothesis (auto-promotes unverified to supported). |
| `hypothesis_check_done` | `hypothesis-tracker.completeCheck` | Mark a required check as done. |
| `hypothesis_reject` | `hypothesis-tracker.rejectHypothesis` | Reject a hypothesis with a reason, the rejection is appended as an audit entry rather than a silent delete. |
| `hypothesis_support` | `hypothesis-tracker.supportHypothesis` | Explicitly mark a hypothesis as supported. Usually `hypothesis_evidence` is enough. |
| `hypothesis_reset` | (store purge) | Purge all hypotheses for one session. Use before reusing a grounding sessionId for a new debug task so stale hypotheses do not leak in. |

## Storage

| What | Where | Override |
|---|---|---|
| Session JSON | `~/.grounding-mcp/sessions/<id>.json` | `GROUNDING_MCP_SESSIONS_DIR` |
| Evidence ledger | `~/.evidence-ledger/ledger.db` (owned by `evidence-ledger`) | `EVIDENCE_LEDGER_DB` |
| Solution verdicts | `~/.local/state/agent-grounding/solution-verdicts/<id>.json` (`$XDG_STATE_HOME` honored) | `SOLUTION_VERDICT_DIR` |
| Verdict signing key | `$SOLUTION_VERDICT_SIGNING_KEY` (absolute key-file path, projected by harness at apply time) when set; else `<harness-home>/harness.generated/.approval-signing.key` (`<harness-home>` resolves like the harness consumer: `~/.harness` if it exists, else `~/.claude` if it already carries harness state, else `~/.harness` created on first use) | `SOLUTION_VERDICT_SIGNING_KEY`, `HARNESS_HOME` |

A phase that ends up with `'skipped'` status (because no steps mapped to it for the chosen keyword, e.g. a non-service domain skips runtime-inspection) counts as satisfied for `claim_evaluate_from_session`. Otherwise the gate would block forever on prerequisites the agent can't actually complete.

## Solution-acceptance gate

Verifier-gated "done": completion is **earned from a real preflight run, not claimed**. `solution_evaluate` runs `preflight run <repoPath> --json` (the agent-preflight check battery: lint / typecheck / test / audit / secret) and records a verdict marker for an id, pinned to the git HEAD it was produced at. `solution_gate` then allows only when a ready verdict exists at the *current* HEAD.

The verdict marker is the contract a consumer (e.g. harness, gating task-finishing tools) reads:

```json
{ "id": "task-42", "head": "<40-hex sha>", "ready": true, "confidence": 0.9, "blockers": [], "timestamp": "...", "source": "preflight", "alg": "hmac-sha256-v1", "signature": "<64-hex HMAC-SHA256>" }
```

`solution_evaluate`'s MCP response returns the verdict as it looked *before* signing (the 7-key shape above, minus `alg`/`signature`); the on-disk marker file additionally carries `alg` and `signature`, added by `writeVerdict` (see "Verdict marker signing" below) after the response value was already built.

Anti-hacking contract:

1. **Derived, not claimed**: `ready` comes from preflight's real run; the caller supplies no result.
2. **Producer != solver**: `solution_evaluate` runs preflight; the check set is the repo's committed `.preflight.json`, not call arguments, so an agent cannot weaken the gate at call time.
3. **HEAD-pinned**: a verdict counts only at the HEAD it was produced at; any rework shifts HEAD and invalidates a green verdict.
4. **No stale green**: a not-ready run overwrites a prior green marker.

The marker lives outside the agent-writable evidence-ledger on purpose (a ledger row is forgeable via `ledger_add`). Requirements / knobs: the `preflight` binary on `PATH` (override with `SOLUTION_PREFLIGHT_BIN`); fails closed (writes no verdict) when preflight is unavailable.

### Verdict marker signing (0.8.0)

Since 0.8.0, `writeVerdict` signs the marker unconditionally (HMAC-SHA256, no unsigned fallback) before writing it: `alg` is the versioned tag `hmac-sha256-v1`, and `signature` is computed over the marker's fields with the key at the path `SOLUTION_VERDICT_SIGNING_KEY` points to (projected by harness at apply time; primary since 0.8.0), else at `<harness-home>/harness.generated/.approval-signing.key` (see Storage above; the key is created on first use if absent, at whichever path is in effect). A signature-checking consumer (e.g. harness) rejects a naive hand-typed JSON file, one with no `alg`/`signature` at all or a wrong signature, as forged.

This closes casual/accidental forgery, and it closes silent tampering: mutating any signed field after signing (intentionally or by a bug) invalidates the signature and is rejected. It does **not** close a shell-capable, same-UID forger: the signing key is read (and, on a fresh machine, first created) under the SAME UID that runs `grounding-mcp` and the same UID a shell-capable agent runs under, so such an agent could still read that key and compute a valid signature itself, exactly the same same-UID threat model the harness consumer's own signing already documents. This is pragmatic defense-in-depth, not a new authorization boundary. Composing additional ground-truth (CI, review, unresolved hypotheses from the session) into the verdict is the next layer.

The verdict pins to the committed HEAD, so edits made after a green `solution_evaluate` do not shift HEAD: re-run it after any change. preflight's own clean-worktree check fails a dirty tree, so a fresh `solution_evaluate` on uncommitted work yields a not-ready verdict.

### Orchestrator-workflow (OW) process-completeness arm

Beyond preflight's technical checks, `solution_evaluate` also folds in **OW process-completeness**: it reads the repo's active OW run and requires the handoff to be accepted, the review to recommend accept, and no unresolved high/critical findings. This flows into the **same** verdict fields, `ready` and `blockers` (each OW blocker is prefixed `orchestrator-workflow: `), so the OW arm adds no verdict field of its own. `ready` is true only when **both** preflight is ready **and** there are no OW blockers.

**Active-run resolution is pointer-first.** The worktree root (found by walking up from the repo path for the nearest `.git` entry) may carry a `.ai/run` file — plain text, first non-empty line is the absolute path of the run directory OW is actively working. An optional second pointer line (for example `base=<sha>`) is ignored; the named run directory's own `00-goal.md`/`06-handoff.md`/`05-review-findings.md` files are the source of truth, never the pointer file itself. When present, that pointer **wins outright** over the newest-run scan of `<repoPath>/.ai/runs/`: a run is session-shaped (the worktree the agent is sitting in), while the newest-by-date scan is only a best-effort proxy, and the scan is consulted only when no `.ai/run` file exists at all. A pointer file that exists but does not resolve (unreadable, empty, a relative path, or a target that is missing / not a directory / not a dated run directory) is a **distinct fail-closed blocker** — it never silently falls back to the scan, since a broken pointer left behind is itself a signal something is wrong. A symlinked pointer target is resolved to its real directory before those checks run, and the worktree root itself is found by the presence of any `.git` entry, including a dangling symlink. `.ai/run` is written by the orchestrator-workflow kit at run creation, alongside `.ai/runs/`, and should be gitignored the same way.

The active run must also **claim the current change** (0.6.0): a run whose `00-goal.md` carries a `<!-- solution-acceptance: run-base = <sha> -->` marker (the repo HEAD at run creation) binds precisely — the recorded base must resolve, be an ancestor of the current HEAD, and not lie behind the fork point of the current change (merge-base with the remote default branch). The marker may also be **keyed per repo**, `<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->`, since a monorepo/fleet run can bind more than one repo. Keyed markers follow a **grammar**, not a single regex: a well-formed keyed marker must be a WHOLE LINE (leading/trailing whitespace only) matching that exact HTML-comment shape. The strict shape is exact — lowercase `solution-acceptance:` and `run-base`, no whitespace before the colon, exactly two dashes in the comment opener — the same exactness the legacy unkeyed matcher already demands. The separate loose net that decides whether a line was an *attempt* at a keyed marker is deliberately more tolerant: case-insensitive (`RUN-BASE[`), whitespace allowed around the colon (`solution-acceptance : run-base[`) and before the bracket (`run-base [alpha]`), one or more dashes in the comment opener (`<!--- `). A line the loose net catches but the strict shape rejects is **malformed** and is collected as its own explicit blocker instead of silently degrading to the legacy date heuristic. A strict match whose key is itself a placeholder (`<repo-basename>`-style, angle brackets around the whole key) is a documentation example, not a marker, and is ignored entirely — not counted as present, not malformed; an example that itself deviates from the strict shape (case, colon spacing, comment opener) is an attempt like any other and blocks as malformed. Both nets stay anchored at the LINE START and require the literal tokens `solution-acceptance`, a colon and `run-base[`; that anchoring and exactness widen the strict shape's own tokens (case, spacing, dash count), not the line position. A THIRD, position-independent check closes the line-position residual: **any line anywhere in the file** (a list bullet (`- <!-- ... -->`), a marker embedded in prose, a bare `run-base[alpha] = <sha>` with no comment wrapper, an attempt preceded by leading text, or a whole-line comment deviating in those tokens, the colon omitted) that names BOTH exact, case-sensitive tokens `solution-acceptance` and `run-base` is also collected as **malformed**, unless it is already accepted as a well-formed keyed or unkeyed marker; this applies inside a fenced code block too. The rationale: an attempted-but-unreadable marker is worse than no marker at all, so it must block rather than fall through silently. A well-formed legacy unkeyed marker line is explicitly exempt from this check, so an ordinary unkeyed marker, which itself names both tokens, is never misread as an attempted-but-broken keyed one. A well-formed marker (keyed or unkeyed) that still carries the `TODO` placeholder stays fail-open, per the orchestrator-workflow kit's own documented contract. With NO line anywhere naming both marker tokens, the run stays truly **markerless** and falls through to the legacy date heuristic below (fail-open by design, the kit's documented markerless path). Resolution of well-formed keyed markers tries the worktree's own basename first, then — for a linked git worktree — the main repository's basename (resolved via the worktree's `.git` `gitdir:` file), matching each candidate key against the recorded keys case-insensitively, and the first key whose well-formed keyed marker is present decides, without falling through to a later key or to the legacy unkeyed marker. A keyed marker that IS selected but still carries the `TODO` placeholder resolves to absent (the legacy heuristic path below) exactly like an unkeyed `TODO` marker — it does not fall through to a later key or to the unkeyed marker either. Only when no well-formed keyed marker matches any candidate key does the unkeyed marker apply; when keyed markers exist but none matches any candidate key and no unkeyed marker exists either, the reader itself blocks with an explicit reason naming the keys found and the keys tried (each bounded — keys truncated to 64 chars / 10 shown, malformed lines truncated to 80 chars / 5 shown — so a goal file with many or very long keys cannot blow up the message), and the binding check below skips its date heuristic for that case — one blocker, never two, and never a silent fall-through to the date heuristic. The same skip applies when malformed marker lines were found and nothing else resolved a value (`malformed` takes priority over the unmatched-keyed case); when a malformed line coexists with a value that WAS selected, that value is still used, but the malformed blocker is reported alongside it, so the run is still incomplete. Documented asymmetry: the legacy unkeyed `run-base` marker is matched as a substring anywhere in the file (not line-anchored) and resolves values exactly as before; only the keyed grammar itself was hardened; a well-formed unkeyed marker line is exempt from the phrase check above. A legacy run without any applicable marker (or with one still carrying `TODO`) is downgraded tolerantly to a day-granular date check: it blocks only when the run dir's date prefix is older than the author date of the first commit of the current change. Either way a stale accepted run can no longer keep the gate green for later, unrelated work; the fail directions and residuals (same-day staleness for legacy runs, no fork-point check without a remote, deliberate false-block when evaluating at an already-pushed default-branch tip — the gate is pre-merge by design) are documented on `owBindingBlockers` in `src/solution-verdict.ts`. The `run-base` marker (keyed and unkeyed) is written by the orchestrator-workflow kit; markerless runs stay on the heuristic path.

Knob, `<repoPath>/.ai/solution-acceptance.json`:

```json
{ "orchestratorWorkflow": "auto" }
```

| Value | Behavior |
| --- | --- |
| `auto` (default) | Gate on OW completeness only when an active run is found (via the pointer or the scan); a repo with no run is unaffected. |
| `on` | As `auto`, and additionally block when no active run is found at all — no `.ai/run` pointer and no `.ai/runs/` run directory. |
| `off` | Never gate on OW; preflight alone decides. |

Fail-SAFE: a missing, unreadable, unparseable, or invalid config resolves to `auto` (never silently `off`), so a malformed file cannot disable the gate. A repo with no active run under the default `auto` knob produces a verdict byte-identical to the pre-OW output.

## Install + register

```bash
npm install -g @lannguyensi/grounding-mcp
```

Then add to your Claude Code `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "grounding": {
      "command": "grounding-mcp"
    }
  }
}
```

You can also invoke it without a global install via `npx`:

```json
{
  "mcpServers": {
    "grounding": {
      "command": "npx",
      "args": ["-y", "@lannguyensi/grounding-mcp"]
    }
  }
}
```

After restart, the tools appear as `mcp__grounding__grounding_start`, etc.

## Round-trip example

```jsonc
// 1. Start a session — pick a keyword that matches your domain
mcp__grounding__grounding_start({
  keyword: "deploy-panel",
  problem: "frontend went 502 after the last release"
})
// → { sessionId: "gs-deploy-panel-l7k...", currentPhase: "scope-resolution", ... }

// 2. As you investigate, log evidence
mcp__grounding__ledger_add({
  sessionId: "gs-deploy-panel-l7k...",
  type: "fact",
  content: "nginx error log shows upstream timeout from backend container",
  source: "/var/log/nginx/error.log",
  confidence: "high"
})

// 3. Reject the alternatives you ruled out
mcp__grounding__ledger_add({
  sessionId: "gs-deploy-panel-l7k...",
  type: "rejected",
  content: "DNS misconfiguration [rejected: dig resolves correctly from host]"
})

// 4. Advance through phases as you complete them
mcp__grounding__grounding_advance({ sessionId: "..." })

// 5. Before stating a root cause, gate the claim
mcp__grounding__claim_evaluate_from_session({
  sessionId: "gs-deploy-panel-l7k...",
  claim: "the root cause is the backend container's missing OPENAI_API_KEY env var"
})
// → { allowed: true, score: 100, ... } — safe to surface
//   or { allowed: false, next_steps: [...] } — go finish the listed checks first
```

## Hypothesis tracking

The `hypothesis_*` verbs wrap `hypothesis-tracker` so you can keep competing causes alive during a debug session and force explicit rejection instead of silent substitution. State is cached in-memory per server process (sessionId-namespaced) and persisted to disk under `~/.grounding-mcp/hypotheses/<sessionId>.json` (override with `GROUNDING_MCP_HYPOTHESES_DIR`), at parity with the grounding session and the evidence ledger, so it survives a grounding-mcp restart.

**Hypothesis lifetime:** a session's hypotheses live until `hypothesis_reset` purges them (in-memory and on disk) for that sessionId, or until LRU eviction when more than `GROUNDING_HYPOTHESIS_MAX_SESSIONS` (default 200) distinct sessions have been active in the same process — eviction only drops the in-process cache entry, the on-disk file is re-hydrated on the next access. Use `hypothesis_reset` at the start of a new debug task that reuses an existing sessionId to avoid leaking stale hypotheses into the fresh investigation.

```jsonc
// 1. Record both possible causes early
mcp__grounding__hypothesis_record({
  sessionId: "gs-deploy-panel-l7k...",
  text: "DNS resolution is failing",
  requiredChecks: ["Run dig from container", "Check /etc/resolv.conf"]
})
// → { hypothesis: { id: "abc123", status: "unverified", ... } }

mcp__grounding__hypothesis_record({
  sessionId: "gs-deploy-panel-l7k...",
  text: "Firewall blocks port 443"
})

// 2. Attach what you actually observed
mcp__grounding__hypothesis_evidence({
  sessionId: "gs-deploy-panel-l7k...",
  hypothesisId: "abc123",
  evidence: "dig example.com inside container returns NXDOMAIN",
  source: "docker exec api dig example.com"
})
// → hypothesis flips unverified → supported

// 3. Reject the one that didn't survive contact with evidence
mcp__grounding__hypothesis_reject({
  sessionId: "gs-deploy-panel-l7k...",
  hypothesisId: "def456",
  reason: "iptables -L shows ACCEPT on 443 from container subnet"
})

// 4. Take stock before claiming
mcp__grounding__hypothesis_list({ sessionId: "gs-deploy-panel-l7k..." })
// → { summary: { total: 2, supported: 1, rejected: 1, ... }, hypotheses: [...] }
```

The store has no automatic claim-gate hook, the workflow is "use this before reaching for `claim_evaluate_from_session`", not "this gates the gate". If the value of an automatic hook becomes apparent through use, that's a follow-up.

## Trust model

This server is meant to run on the agent's local machine via stdio. There's no auth, no rate limiting, no input sanitization beyond what zod's schema validation gives. The evidence-ledger is shared with any other tool that opens `~/.evidence-ledger/ledger.db`, be aware that other CLIs (`ledger`, etc.) can read and write the same data.

## Development

```bash
# Build
npm run build --workspace @lannguyensi/grounding-mcp

# Run tests (uses temp ledger.db + temp sessions dir, never touches real ones)
npm test --workspace @lannguyensi/grounding-mcp

# Run the server in dev mode
npm run dev --workspace @lannguyensi/grounding-mcp
```

When changing tool descriptions, restart Claude Code, MCP tool catalogs are cached at session start.

### Adding a new verb? Mirror the test pattern.

Two test files cover the verb surface and they catch different bugs, so a new verb usually needs an entry in both:

- `tests/hypothesis.test.ts` (or sibling `*.test.ts`) drives the library + in-process store directly. Fast, covers happy paths and library invariants.
- `tests/hypothesis-mcp-roundtrip.test.ts` drives the same verbs through a real `Client` + `InMemoryTransport` pair against `createServer()`. It is the only place that exercises representative wrapper-only error branches (`no_store_for_session`, `hypothesis_not_found`, `check_index_out_of_range`, `hypothesis_not_found_or_rejected`) and the zod schema bounds (`.min(1)`, `.max(4096)`) end-to-end. Wrapper branches that exist only in `server.ts` are invisible to a library-level test. Sibling permutations of the same error code across other verbs are intentionally not duplicated, the goal is one assertion per distinct branch, not full matrix coverage.

If a new verb introduces a structured error payload that does not exist in the underlying library (most verbs that have one do), add a roundtrip case that asserts the exact `{ error: '<code>', ... }` shape, not just `isError`.
