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
| `claim_evaluate` | `claim-gate.evaluateClaim` | Run a claim through the gate with caller-supplied context. |
| `claim_evaluate_from_session` | claim-gate + grounding-wrapper + evidence-ledger | Same, but auto-derive the context from the session's phase status + ledger entries. The default path. |
| `verify_memory_reference` | `runtime-reality-checker.verifyMemoryReference` | Check whether a memory-referenced path / symbol / flag still exists in the repo. Call before recommending anything from a memory that cites a concrete file, function, or flag. |
| `hypothesis_record` | `hypothesis-tracker.addHypothesis` | Add a competing hypothesis with required checks. Use when you can name more than one possible cause. |
| `hypothesis_list` | `hypothesis-tracker.getSummary` | List all hypotheses for a session plus summary counts. Use before claiming a root cause. |
| `hypothesis_evidence` | `hypothesis-tracker.addEvidence` | Attach evidence to a hypothesis (auto-promotes unverified to supported). |
| `hypothesis_check_done` | `hypothesis-tracker.completeCheck` | Mark a required check as done. |
| `hypothesis_reject` | `hypothesis-tracker.rejectHypothesis` | Reject a hypothesis with a reason — the rejection is appended as an audit entry, never a silent delete. |
| `hypothesis_support` | `hypothesis-tracker.supportHypothesis` | Explicitly mark a hypothesis as supported. Usually `hypothesis_evidence` is enough. |

## Storage

| What | Where | Override |
|---|---|---|
| Session JSON | `~/.grounding-mcp/sessions/<id>.json` | `GROUNDING_MCP_SESSIONS_DIR` |
| Evidence ledger | `~/.evidence-ledger/ledger.db` (owned by `evidence-ledger`) | `EVIDENCE_LEDGER_DB` |

A phase that ends up with `'skipped'` status (because no steps mapped to it for the chosen keyword, e.g. a non-service domain skips runtime-inspection) counts as satisfied for `claim_evaluate_from_session`. Otherwise the gate would block forever on prerequisites the agent can't actually complete.

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

The `hypothesis_*` verbs wrap `hypothesis-tracker` so you can keep competing causes alive during a debug session and force explicit rejection instead of silent substitution. State is in-memory per server process (sessionId-namespaced); persistence is intentionally out of scope, the ledger is the durable record.

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
