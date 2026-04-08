# Evidence Ledger

> Structured evidence tracking for agent debugging sessions.

Stop mixing facts, guesses, and rejected ideas during debugging. The Evidence Ledger forces you to be explicit about what you *know*, what you *suspect*, and what you've *ruled out*.

## Why

Agents (and humans) frequently make the same mistake during debugging:

> "The database is probably down" (stated as fact, based on nothing)

Evidence Ledger enforces a discipline:
- **Facts** require a source
- **Hypotheses** are tracked separately from facts
- **Rejected hypotheses stay visible** — so you don't re-investigate dead ends
- **Unknowns are acknowledged** — not quietly assumed away

Based on [lan-tools/04-evidence-ledger.md](https://github.com/LanNguyenSi/lava-ice-logs/tree/master/lan-tools).

## Install

```bash
npm install -g evidence-ledger
```

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

## Example Output

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

## Export Format

```json
{
  "session": "default",
  "exportedAt": "2026-04-02T20:45:00.000Z",
  "facts": [
    { "content": "process is not running", "source": "ps aux", "confidence": "high" }
  ],
  "hypotheses": [...],
  "rejected_hypotheses": [...],
  "unknowns": [...]
}
```

## Programmatic API

```typescript
import { getDb, addEntry, rejectHypothesis, getSummary } from 'evidence-ledger';

const db = getDb(); // persists to ~/.evidence-ledger/ledger.db

addEntry(db, { type: 'fact', content: 'port 3000 is closed', source: 'netstat', confidence: 'high' });
addEntry(db, { type: 'hypothesis', content: 'firewall blocking', session: 'debug-session' });

const summary = getSummary(db, 'debug-session');
console.log(summary.facts, summary.hypotheses);
```

## Entry Types

| Type | Icon | Description |
|------|------|-------------|
| `fact` | ✓ | Confirmed observation with a verifiable source |
| `hypothesis` | ? | Possible explanation — not yet confirmed or rejected |
| `rejected` | ✗ | Disproven hypothesis — kept visible to avoid re-investigation |
| `unknown` | ~ | Something that still needs clarification |

## Rules (from the spec)

- Every strong claim needs at least one source
- Root causes only when: direct evidence exists AND counter-hypotheses have been checked
- Rejected hypotheses remain visible — never deleted

## Tests

```bash
npm test
# 23 tests passing
```

## License

MIT
