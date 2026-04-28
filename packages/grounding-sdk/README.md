# grounding-sdk

Ergonomic facade over the agent-grounding primitives. Three entry points —
`verify`, `track`, `validate` — wrap `claim-gate`, `hypothesis-tracker`,
and `evidence-ledger` so agent code does not have to learn the full
surface.

No new engine, no extra persistence. Each function routes to the same
library call the MCP server would make.

## Install

```bash
npm install grounding-sdk
```

## Quickstart

```typescript
import {
  createStore,
  track,
  verify,
  validate,
} from "grounding-sdk";
import { initSession, advancePhase } from "@lannguyensi/grounding-wrapper";
import { getDb, addEntry, getSummary } from "@lannguyensi/evidence-ledger";

// 1. Track a hypothesis. The store is in-memory; snapshot it yourself
//    via hypothesis-tracker's exportStore/importStore when you need
//    persistence across processes.
const store = createStore("debug-session-1");
const h = track(store, {
  text: "retry loop masks upstream 503",
  requiredChecks: ["grep access log", "inspect retry policy"],
});

// 2. Verify a claim against explicit evidence flags.
const vResult = verify(
  "the 503 is from upstream, not local",
  {
    readmeRead: true,
    processChecked: true,
    configChecked: true,
    healthChecked: true,
    hasEvidence: true,
    alternativesConsidered: true,
  },
  "root_cause",
);
// vResult.allowed === true, vResult.score 0–100

// 3. Validate against a grounding session + ledger summary. Analogous
//    to the MCP claim_evaluate_from_session tool.
let session = initSession({ keyword: "crash", problem: "500 on /health" });
session = advancePhase(session); // …walk phases as your agent does its work
const summary = getSummary(getDb(), "debug-session-1");
const result = validate({
  session,
  claim: "ship the fix — upstream confirmed",
  type: "root_cause",
  ledgerSummary: summary,
});
// result.derivedContext shows which prereqs were detected
```

## API

### `verify(claim, evidence?, type?): ClaimResult`

Evaluate a claim against explicit evidence flags. Maps the SDK's
camelCase `Evidence` shape to the underlying `claim-gate` `ClaimContext`
and calls `evaluateClaim`. Use when you already have the context in
hand and no session is involved.

`evidence` defaults to `{}` (no prereqs satisfied).

### `track(store, input): Hypothesis`

Register a hypothesis in the given `HypothesisStore`. `input` can be a
string (treated as `{ text }`) or a `TrackInput` with an optional
`requiredChecks: string[]`. Returns the created `Hypothesis` with
auto-generated id and timestamps. The store is the `hypothesis-tracker`
in-memory shape — bring your own persistence via that package's
`exportStore` / `importStore`.

### `validate({ session, claim, type?, ledgerSummary? }): ValidateResult`

Derive a `ClaimContext` from the session's phase progress plus (optional)
ledger summary, then evaluate the claim against it. Mirrors the MCP
`claim_evaluate_from_session` tool for in-process use. Returns the
standard `ClaimResult` plus a `derivedContext` field so callers can see
which prereqs the SDK detected.

When `ledgerSummary` is omitted, `has_evidence` and
`alternatives_considered` both default to `false` — the result is still
well-defined, just based on fewer inputs.

### Helpers

- `deriveContextFromSession(session, summary?): ClaimContext` — the
  mapping `validate` uses internally, exported for consumers that
  already have their own `evaluateClaim` flow.
- `createStore(session?): HypothesisStore` — re-exported from
  `hypothesis-tracker`, so consumers only import from one package.

## When to use what

| You have                                | Use        |
| --------------------------------------- | ---------- |
| Claim + hand-collected evidence flags   | `verify`   |
| A new hypothesis you want to remember   | `track`    |
| A grounding session and its ledger      | `validate` |

For the full MCP tool surface, use `grounding-mcp` directly. This SDK
is the in-process ergonomic alternative.
