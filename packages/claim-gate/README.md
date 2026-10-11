# claim-gate

Policy engine that blocks strong agent claims until the prerequisite checks they require are reported as done.

## Overview

claim-gate evaluates diagnostic claims against prerequisite checks and blocks premature conclusions. When an agent wants to claim "the root cause is X", claim-gate checks whether the caller reports having completed the required steps (read docs, checked processes, gathered evidence, considered alternatives). If prerequisites are missing, the claim is blocked with specific next steps.

## Trust model

claim-gate trusts its caller. Every context flag, including `--evidence` / `has_evidence`, is asserted by the caller and is not checked against any store. Use it as a self-discipline aid, not as a merge or approval authority. To derive `has_evidence` and `alternatives_considered` from recorded evidence-ledger entries, call it through grounding-mcp (`claim_evaluate_from_session`) or grounding-sdk. See [claim-gate vs review-claim-gate](../../docs/okf/claim-gate-vs-review-claim-gate.md).

## Claim types

| Type | Required Prerequisites |
|------|----------------------|
| `root_cause` | readme, process, config, evidence, alternatives |
| `architecture` | readme, process, config, alternatives |
| `security` | readme, config, evidence |
| `network` | health, process |
| `configuration` | readme, config |
| `process` | process |
| `availability` | health, process |
| `token` | config, evidence |
| `generic` | evidence |

Without `--type`, the claim text is matched against keyword patterns in this order: architecture, root_cause, security, network, configuration, process, availability, token. The first match wins and anything else is generic. Matching is by substring, so a claim mentioning "auth" is classified as security even if it is about a token.

## Install

```bash
npm install -g @lannguyensi/claim-gate
```

Requires Node.js >= 20.

## Usage

```bash
# Check if a claim is allowed
claim-gate check "The root cause is a missing env variable" \
  --readme --config --evidence

# With JSON output
claim-gate check "Network is unreachable" --health --process --json

# List all policies
claim-gate policies
```

In text mode, `check` exits 1 when the claim is blocked and 0 when it is allowed. With `--json` it always exits 0; read the `allowed` field. JSON shape: `{ claim, type, allowed, reasons, next_steps, score }`.

### Flags

| Flag | Meaning |
|------|---------|
| `--readme` | Primary documentation has been read |
| `--process` | Process state has been verified |
| `--config` | Configuration source has been checked |
| `--health` | Health/port/status check performed |
| `--evidence` | At least one supporting evidence exists |
| `--alternatives` | Alternative hypotheses considered |
| `--type <type>` | Use this claim type instead of detecting it from the claim text (one of the nine types above; an unknown value uses the generic policy) |
| `--json` | Print the result as JSON |

### Library usage

```typescript
import { evaluateClaim, isAllowed } from "@lannguyensi/claim-gate";

const result = evaluateClaim("The root cause is a DNS issue", {
  readme_read: true,
  process_checked: true,
  config_checked: true,
  has_evidence: false,
  alternatives_considered: false,
});

console.log(result.allowed);    // false - missing evidence + alternatives
console.log(result.score);      // 60 (3/5 prerequisites met)
console.log(result.next_steps); // ["Collect at least one supporting evidence entry", "Document and reject at least one alternative hypothesis"]
```

## Development

```bash
npm install
npm run build    # TypeScript build
npm test         # Run tests (vitest)
npm run lint     # Type check
```

## License

MIT
