# Retention and export reference

Moved out of the package README during the README restructure; the substance is unchanged.

## Export format

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

## Retention

The ledger grows monotonically, `ledger fact` / `hypothesis` / `unknown` only ever append. Long-running dogfood machines will accumulate stale sessions that slow queries and dilute summaries. Use `prune` to bound the database by age:

```bash
# Inspect what would go, don't touch the DB yet
ledger prune --older-than 30d --dry-run

# Actually delete entries whose created_at is older than 30 days
ledger prune --older-than 30d

# Machine-readable output for scheduled runs
ledger prune --older-than 30d --json
# -> {"deleted":42,"scanned":1337,"cutoff":"2026-03-24 09:07:00","dryRun":false}
```

Accepted units for `--older-than`: `s`, `m`, `h`, `d`. Deletion runs inside an `IMMEDIATE` transaction so concurrent readers never observe a partial sweep. An entry is eligible only once it is *strictly* older than the cutoff, an entry exactly `--older-than` old right now is kept, not deleted.

`policy_decision` rows (the orchestrator's audit trail of allow/deny/warn decisions, see [Entry Types](#entry-types)) are **exempt from pruning by default**, regardless of age, so an audit or incident review always has the full decision history. Pass `--include-policy-decisions` to prune them too:

```bash
ledger prune --older-than 30d --include-policy-decisions
```

Typical cron usage:

```cron
# Prune weekly, keep the last 30 days
0 3 * * 0  ledger prune --older-than 30d --json >> ~/.evidence-ledger/prune.log 2>&1
```

`prune` does not `VACUUM` automatically: `VACUUM` takes an exclusive lock on the database and would stall every other CLI invocation. After a large purge, reclaim disk manually:

```bash
sqlite3 ~/.evidence-ledger/ledger.db 'VACUUM;'
```

### Scope today

Only age-based pruning is implemented. Tag-based and task-id-based keep-lists (`--keep-tagged`, `--keep-task-id`) would require schema changes and are intentionally deferred until a concrete use case appears.

## Entry types

| Type | Icon | Description |
|------|------|-------------|
| `fact` | ✓ | Confirmed observation with a verifiable source |
| `hypothesis` | ? | Possible explanation, not yet confirmed or rejected |
| `rejected` | ✗ | Disproven hypothesis, kept visible to avoid re-investigation |
| `unknown` | ~ | Something that still needs clarification |
| `policy_decision` | ⚖ | Orchestrator/gate audit decision (allow/deny/warn); bucketed separately from the four evidence types, exempt from `prune` by default |
