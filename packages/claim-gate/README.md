# claim-gate

Policy engine that prevents AI agents from making strong claims without verified evidence. Evaluates diagnostic claims against prerequisite checks and blocks premature conclusions.

## How It Works

When an agent wants to claim "the root cause is X", claim-gate checks whether the agent has completed the required steps first (read docs, checked processes, gathered evidence, considered alternatives). If prerequisites are missing, the claim is blocked with specific next steps.

## Claim Types

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

## CLI Usage

```bash
# Check if a claim is allowed
claim-gate check "The root cause is a missing env variable" \
  --readme --config --evidence

# With JSON output
claim-gate check "Network is unreachable" --health --process --json

# List all policies
claim-gate policies
```

### Context Flags

| Flag | Meaning |
|------|---------|
| `--readme` | Primary documentation has been read |
| `--process` | Process state has been verified |
| `--config` | Configuration source has been checked |
| `--health` | Health/port/status check performed |
| `--evidence` | At least one supporting evidence exists |
| `--alternatives` | Alternative hypotheses considered |

## Library Usage

```typescript
import { evaluateClaim, isAllowed } from "@lannguyensi/claim-gate";

const result = evaluateClaim("The root cause is a DNS issue", {
  readme_read: true,
  process_checked: true,
  config_checked: true,
  has_evidence: false,
  alternatives_considered: false,
});

console.log(result.allowed);    // false — missing evidence + alternatives
console.log(result.score);      // 60 (3/5 prerequisites met)
console.log(result.next_steps); // ["Collect evidence", "Consider alternatives"]
```

## Development

```bash
npm install
npm run build    # TypeScript build
npm test         # Run tests (vitest)
npm run lint     # Type check
```
