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
| `ledger_add` | `evidence-ledger.addEntry` | Append a fact / hypothesis / rejected / unknown to the session's ledger namespace. Only a `ledger_summary` call using this exact sessionId string sees it back (case-sensitive, no normalization); a concurrent or pipelined `ledger_add`/`ledger_summary`/`claim_evaluate_from_session`/`ledger_status` set is ordered by arrival at the transport (not by request id value or invocation order), so a summary that arrives after an add for the same sessionId sees it. The server keeps an arrival stamp for at most 1024 ledger requests in flight at once; past that, the oldest loses its stamp and runs after the other requests of its batch, with a line on stderr. `hypothesis_*` tools are a separate store and are not ordered this way (tracked as a follow-up). |
| `ledger_summary` | `evidence-ledger.getSummary` | Return all entries for a session, grouped by type, with counts. A zero count is not necessarily an error: causes include (not an exhaustive list) no entries yet, a sessionId that does not exactly match what `ledger_add` used, or a `contentPrefix` filter that excludes every matching row. `sinceIso` must be an ISO-8601 date (`"2026-05-01"`) or a datetime with a `T`/`t`/space separator, optional seconds and fraction digits, and an explicit `Z`/`z` or numeric offset (`"2026-05-01T08:00:00Z"`, `"2026-05-01T10:00:00+02:00"`, `"2026-05-01 08:00:00.123Z"`); rejected with a validation error naming the field, not silently treated as "matches nothing": an empty string, a relative shorthand (`"1h"`, `"24h"`, `"yesterday"`), an epoch number, `Date.toString()` output, or an out-of-range calendar value would make SQLite's `datetime()` return `NULL` and silently exclude every row, and a local datetime without a zone parses without error but would silently shift the filter window by the caller's wall-clock offset. Every accepted datetime is normalized to a UTC instant before the query, so any explicit offset (including one wider than SQLite's own `datetime()` can represent) filters correctly. Ordered by arrival at the transport, see `ledger_add`. |
| `ledger_status` | `ledger-bridge.ledgerStatus` | No-arg ledger reachability + stats probe (entry count, db path, last-write timestamp) for harness MCP health checks; no session required. Its entry count is ordered by arrival at the transport, see `ledger_add`. |
| `claim_evaluate` | `claim-gate.evaluateClaim` | Run a claim through the gate with caller-supplied context. |
| `claim_evaluate_from_session` | claim-gate + grounding-wrapper + evidence-ledger | Same, but auto-derive the context from the session's phase status + ledger entries. The default path. Its ledger read is ordered by arrival at the transport, see `ledger_add`. |
| `solution_evaluate` | `solution-verdict` + `solution-attempt-log` + `preflight` CLI | Run preflight against a repo and record a HEAD-pinned solution-acceptance verdict for an id, derived from preflight's real results. Earn "done" instead of claiming it. Sends `notifications/progress` pings while it runs, if the request carries a progressToken. Waits up to an internal bound and then hands back `{status:"running", attemptId, pollAfterMs}` instead of blocking further. See below. |
| `solution_gate` | `solution-verdict.evaluateGate` | Allowed only if a ready verdict exists at the current git HEAD; else a precise deny reason (no verdict / not ready / HEAD drift). |
| `solution_evaluate_status` | `solution-attempt-log` | Read-only status of a `solution_evaluate` attempt for an id: `running`, `completed`, `failed`, `unknown`, `expired`, or `running-unconfirmed`. Never starts preflight, never blocks. Omit `attemptId` to ask about the latest attempt for that id. |
| `solution_evaluate_result` | `solution-attempt-log` | Read-only outcome of an attempt once it is terminal, `{status:"running"}` while it is not. The process that ran the attempt answers with the full `solution_evaluate` payload, until its own in-memory record of that attempt ages out (the same retention window as the on-disk log); once pruned, even the owning process answers with the reduced, persisted payload, same as any other process. Not gate authority: `solution_gate` still reads only the signed marker. |
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
| Attempt log | `<verdict dir>/<id>.attempts.jsonl`, one append-only JSONL file per sanitized id, mode `0600` | `SOLUTION_VERDICT_DIR` |
| Attempt lock anchor | `<verdict dir>/<id>.attempt-lock`, mode `0600`; the lock itself is the `<id>.attempt-lock.lock` directory `proper-lockfile` manages beside it | `SOLUTION_VERDICT_DIR` |
| Verdict signing key | `$SOLUTION_VERDICT_SIGNING_KEY` (absolute key-file path, projected by harness at apply time) when set; else `<harness-home>/harness.generated/.approval-signing.key` (`<harness-home>` resolves like the harness consumer: `~/.harness` if it exists, else `~/.claude` if it already carries harness state, else `~/.harness` created on first use) | `SOLUTION_VERDICT_SIGNING_KEY`, `HARNESS_HOME` |

A phase that ends up with `'skipped'` status (because no steps mapped to it for the chosen keyword, e.g. a non-service domain skips runtime-inspection) counts as satisfied for `claim_evaluate_from_session`. Otherwise the gate would block forever on prerequisites the agent can't actually complete.

## Solution-acceptance gate

Verifier-gated "done": completion is earned from a real preflight run, not claimed. `solution_evaluate` runs preflight against a repo and records a HEAD-pinned, signed verdict marker for an id; `solution_gate` allows only when a ready verdict exists at the current HEAD. See [Solution-acceptance gate reference](docs/solution-acceptance-gate.md) for the full anti-hacking contract, verdict marker signing, progress notifications, attempt lifecycle, and the orchestrator-workflow process-completeness arm.

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

## Grounding receipt codec

The package also contains an unregistered `grounding-receipt/v1` library primitive and a versioned conformance corpus for a strict, Ed25519-signed documentary assessment (always `agent_asserted` provenance), plus a separate, restricted `grounding-assessment-mcp` binary that serves it. See [Grounding receipt codec reference](docs/grounding-receipt-codec.md) for the wire format, the authoritative assessment store's session/dossier/claim contract, and the restricted assessment MCP's tool surface.

## Documentation

- [Solution-acceptance gate reference](docs/solution-acceptance-gate.md): verdict marker signing, progress notifications, attempt lifecycle, orchestrator-workflow process-completeness arm
- [Grounding receipt codec reference](docs/grounding-receipt-codec.md): wire format, authoritative assessment store, restricted assessment MCP

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

## License

MIT
