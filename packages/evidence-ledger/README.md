# evidence-ledger

Structured evidence tracking for agent debugging sessions.

## Overview

Stop mixing facts, guesses, and rejected ideas during debugging. Evidence Ledger forces you to be explicit about what you *know*, what you *suspect*, and what you have *ruled out*. Agents (and humans) frequently state a guess as fact ("the database is probably down", based on nothing); Evidence Ledger enforces a discipline instead:

- **Facts** require a source
- **Hypotheses** are tracked separately from facts
- **Rejected hypotheses stay visible**: so you don't re-investigate dead ends
- **Unknowns are acknowledged**: not quietly assumed away

## Key features

- Facts, hypotheses, rejections, and unknowns tracked as distinct entry types with sources and confidence
- Named sessions, so concurrent debugging tasks do not mix entries
- JSON export for handoff to another agent or human
- Age-based pruning with a dry-run mode, for long-running dogfood machines
- `policy_decision` entries for an orchestrator/gate audit trail, exempt from pruning by default

## Install

```bash
npm install -g @lannguyensi/evidence-ledger
```

Requires Node.js >= 20.

## Usage

```bash
# Track a confirmed fact (with source)
ledger fact "process is not running" --source "ps aux | grep clawd-monitor" --confidence high

# Add a hypothesis
ledger hypothesis "OOM killer terminated the process" --source "dmesg output" --confidence medium

# Record an unknown
ledger unknown "why the process restarted at 03:00"

# Reject a hypothesis by ID
ledger reject 2 --reason "memory usage was normal, checked /proc/meminfo"

# Show current session summary
ledger show

# Export as JSON (for handoff to another agent or human)
ledger export

# Work with named sessions
ledger fact "nginx config valid" --source "nginx -t" --session "nginx-debug-2026-04-02"
ledger show --session "nginx-debug-2026-04-02"

# List all sessions
ledger sessions

# Clear a session when done
ledger clear --session "nginx-debug-2026-04-02"
```

### Example output

```
📋 Evidence Ledger — session: default
   4 entries total

✓ FACTS (1)
  ✓ [#1] process is not running (ps aux) HIGH

? HYPOTHESES (1)
  ? [#3] OOM killer terminated the process (dmesg output) MED

~ UNKNOWNS (1)
  ~ [#4] why the process restarted at 03:00  LOW

✗ REJECTED (1)
  ✗ [#2] network configuration is root cause [rejected: nginx test passed] MED
```

### Programmatic API

```typescript
import { getDb, addEntry, rejectHypothesis, getSummary } from '@lannguyensi/evidence-ledger';

const db = getDb(); // persists to ~/.evidence-ledger/ledger.db
// Path resolution: the default is always ~/.evidence-ledger/ledger.db.
// The module reads NO environment variable (and never has) -- pass an
// explicit path to getDb(dbPath) instead. EVIDENCE_LEDGER_DB is honored
// one layer up by grounding-mcp and review-claim-gate, which forward it
// as an explicit dbPath.
//
// getDb caches one open handle per process. Calling it again with no
// argument, or with a path naming the same database (relative and
// absolute forms are equivalent; ':memory:' is compared literally),
// returns that handle. Calling it with a DIFFERENT explicit path while
// a handle is open throws ("ledger already open at X, requested Y —
// call resetDb() first to switch to a different path.") instead of
// silently returning the wrong database; call resetDb() to re-point.
// Identity is fixed at open time (a relative path is resolved against
// the cwd of the opening call) and compared textually after path
// resolution: symlinked spellings of the same file, or case variants on
// a case-insensitive filesystem, count as different paths and throw.

addEntry(db, { type: 'fact', content: 'port 3000 is closed', source: 'netstat', confidence: 'high' });
addEntry(db, { type: 'hypothesis', content: 'firewall blocking', session: 'debug-session' });

const summary = getSummary(db, 'debug-session');
console.log(summary.facts, summary.hypotheses);
```

## Retention

The ledger grows monotonically: `ledger fact` / `hypothesis` / `unknown` only ever append. Long-running dogfood machines will accumulate stale sessions that slow queries and dilute summaries. Use `prune` to bound the database by age. See [Retention and export reference](docs/retention-and-export.md) for the full `prune` flag reference, entry-type table, and JSON export shape.

## Rules (from the spec)

- Every strong claim needs at least one source
- Root causes only when: direct evidence exists AND counter-hypotheses have been checked
- Rejected hypotheses remain visible, never deleted

## Documentation

- [Retention and export reference](docs/retention-and-export.md): `prune` flags, cron usage, entry-type table, JSON export shape

## Development

```bash
npm install
npm run build    # TypeScript build
npm test         # Run tests (vitest)
npm run lint     # Type check
```

## License

MIT
