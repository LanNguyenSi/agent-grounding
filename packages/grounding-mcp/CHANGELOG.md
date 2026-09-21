# Changelog

## [Unreleased]

### Added

- `readOwRunCompleteness()` now parses the review-method axis the
  orchestrator-workflow kit added in 0.32.0
  (`<!-- review-method[<round>] = normal|rigorous|adversarial -->`, one
  marker per reviewer round above the Findings table) and fails
  completeness, with a named reason, when a round's recorded
  `method_applied` is weaker than its declared `review_method`, or is
  missing entirely. The kit template has no dedicated marker yet for the
  reviewer's own returned `method_applied` (transferred into free prose by
  hand today), so this reader defines the counterpart grammar it requires:
  `<!-- method-applied[<round>] = normal|rigorous|adversarial -->`, using
  the same round key. `normal < rigorous < adversarial`; an equal or
  stronger recorded method passes. A review file carrying no well-formed
  `review-method[...]` marker at all is unaffected (backward compatible).
  Parsing is occurrence-scoped rather than whole-line-scoped, unlike the
  `run-base` keyed grammar: real review files pack several rounds' markers
  onto one line, and a whole-line requirement would misclassify that as
  malformed. A near-miss occurrence (wrong wrapper case/spacing, or a
  value that is not exactly one of the three words, including the
  template's own pipe-joined legend value used with a real round key) is
  reported as its own malformed-marker blocker rather than silently
  ignored, and a key that is itself the template's own `<round>`
  placeholder is skipped as a documentation example, mirroring the
  existing `run-base` marker's own placeholder-key and malformed-line
  treatment. See README.md's "Review-method axis" section.

  Corpus measurement (round 1's anchor, made concrete in round 2, corrected
  and completed in round 3, review finding F3): 7 real
  `05-review-findings.md` files authored under kit 0.32.0 carry a
  `review-method[...]` or `method-applied[...]` occurrence, all under this
  workspace's `.ai/runs/` run directories (not this package's own):
  `2026-09-12-quickwins-batch48` (27 occurrences on 11 lines),
  `2026-09-13-open-pool-batch50` (5 on 5), `2026-09-11-memory-sync-wipe`
  (5 on 5), `2026-09-12-agent-dx-external-prs` (8 rounds across 3 PRs,
  all 8 packed onto 1 line), `2026-09-11-sync-peer-file-conflict` (3 on 3,
  omitted from round 2's citation), `2026-09-11-review-method-axis` (2 on 2,
  likewise omitted from round 2's citation), and
  `2026-09-13-quickwins-batch51` (14 on 14 as of round 4; also 14
  `method-applied[...]` occurrences on 14 lines, the only file with any).
  Totals across all 7: 64 `review-method[...]` occurrences on 41 lines; the
  6 files excluding `batch51` carry 50 on 27; 14 `method-applied[...]`
  occurrences on 14 lines exist anywhere in the corpus, all in `batch51`.
  `batch51`'s own `05-review-findings.md` is the run this very fix ships in
  and its round count keeps growing while the run is open, so its figures
  above are a measurement taken at the time of writing, not a fixed corpus
  fact (round 2 cited it at 5 rounds / 5 occurrences of each marker; by
  round 3 it had grown to 10 of each; by round 4, 14 of each). Round 1's
  mandatory-marker design (above) therefore
  failed every one of the other 6 files outright (27/5/5/8/3/2 rounds
  respectively reported as missing `method_applied`, one reason per
  round), and would also fail a run authored exactly from the shipped
  template, which carries no `method-applied[...]` marker at all: only
  its own prose `Method: <value> (...)` line. Round 2 (review finding F1)
  fixes this:

  - `method-applied[<round>]` stays the explicit, preferred record, but the
    template's own `Method: <value> (...)` line immediately following a
    `review-method[<round>]` declaration is now ALSO accepted as a
    fallback record when it names one of the three values (the template's
    unfilled `normal | rigorous | adversarial` legend is recognized and
    skipped as a placeholder, not misread as the value `normal`); a
    `Method:` line naming none of the three is its own malformed-record
    blocker, and a round where the marker and the prose line disagree is
    its own named conflict (neither silently wins). Cross-repo obligation,
    unchanged: the shipped
    `packages/orchestrator-workflow/assets/templates/05-review-findings.md`
    should still add the `method-applied[<round>]` marker line; until then,
    a run with a FILLED `Method:` line passes via this fallback, and a run
    recording neither channel needs one line added to migrate.
  - Quoted occurrences (a marker inside a fenced code block or inline code
    span, e.g. quoted in prose or inside a findings-table cell) no longer
    register as live declarations (review finding F2): every net in
    `collectRoundMarkers` now runs against the same quoting-stripped text
    `run-base` already uses for its own phrase check
    (`stripQuotedMarkdownText`, generalized from the run-base-only
    `stripQuotedRunBaseText`), a deliberate asymmetry from `run-base`,
    which is quoting-aware only on its phrase net; see README.md.
  - Duplicate markers for one round now agree or block: identical
    duplicates are tolerated (first occurrence wins, as before), but
    disagreeing duplicates are a named conflict rather than a silent
    first-wins pick (review finding F3).
  - A wrapper-less marker line (`review-method[R1] = adversarial` or
    `method-applied[R1] = normal` with no HTML comment at all) is no
    longer invisible: it is now caught by a wrapper-less net mirroring the
    `run-base` phrase net's own fail-closed discipline (review finding
    F4).
  - Per-round reasons are now bounded (`joinBounded`, review finding F5):
    the "absent" and "weaker" cases each collapse into one reason per
    category naming the affected rounds, instead of one reason per round
    (batch48 alone produced 27 separate reasons under round 1's design).
    Replaying the round-2 built reader against the corpus files above with
    this fix: batch48 collapsed from 27 per-round reasons to 1 bounded
    reason still naming 24 rounds (the other 3, `T-011-R1`/`R2`/`R3`,
    resolved via the new prose fallback at the time, since the file's own
    summary `Method:` line happens to immediately follow that round's
    packed marker line); open-pool-batch50 and memory-sync-wipe each
    collapsed from 5 reasons to 1 naming all 5 (no `Method:` line follows
    any of their markers, so none resolve); agent-dx-external-prs
    collapsed from 8 reasons to 1 naming all 8 (its only `Method:` line is
    the unfilled legend, correctly still not accepted); the `batch51` run
    stayed fully clean (its rounds already carry matching explicit
    `method-applied[...]` markers). The remaining unresolved rounds were a
    genuine authoring gap (no per-round `Method:` line to read), not a
    reader defect. Round 3 (below) revisits the `T-011` resolution: it was
    an artifact of reading one packed line's `Method:` summary as if it
    confirmed each of the three rounds packed onto it, not a genuine
    per-round confirmation.
  - Malformed-marker excerpts now carry their 1-based line number (review
    finding F6, mirroring `run-base`'s own `line N: ` prefix), and the
    round-key placeholder check reuses the existing `PLACEHOLDER_KEY`
    regex instead of a duplicate `ROUND_PLACEHOLDER_KEY`.
  - An orphan `method-applied[<round>]` marker with no matching declared
    `review-method[<round>]` is documented as silently ignored (there is
    nothing to check it against); a round whose declared and recorded keys
    merely differ in spelling (e.g. `review-method[T-003 R1]` vs
    `method-applied[R1]`) now names the mismatched keys actually present in
    the file in its "no matching record" reason, the same way `run-base`'s
    own key-mismatch reason does.

  Round 3 (review findings F1-F4) closes two fail-open gaps the corpus
  recount above surfaced, corrects the corpus citation itself, and adds
  targeted fixtures:

  - **F1 (correctness):** `resolveProseMethodLine` previously accepted the
    FIRST token after `Method:` as the record whenever it happened to name
    one of the three words, with no check on what followed. A real corpus
    line reads `Method: rigorous for every round except T-007 R1 and
    T-010 R1 (adversarial); \`method_applied\` matched the briefing in all
    32 returns.` (`quickwins-batch48`, the line immediately following its
    packed `T-011-R1`/`R2`/`R3` declarations): the first token, `rigorous`,
    is not a record of the round it follows, it is the first word of a
    qualifying sentence about OTHER rounds. The trailing text after the
    token must now be empty, end-of-sentence punctuation only, or start
    with `(` (the template's own filled shape,
    `Method: adversarial (briefing and return match).`); anything else is
    a malformed record, not a silently-accepted first word.
  - **F2 (correctness):** the prose fallback was associated with the
    occurrence's physical LINE, so a line packing several rounds'
    declarations together (the real authoring convention; see
    `collectRoundMarkers`'s own docstring) let one following `Method:`
    line clear every round packed onto it. `quickwins-batch48`'s
    `T-011-R1`/`R2`/`R3` share exactly this shape. The fallback now applies
    only when the declaration's own line carries exactly one well-formed
    `review-method[...]` occurrence; a packed line falls through to the
    existing "no matching record" (absent) reason for every round on it,
    the same outcome as if no `Method:` line followed at all.
  - **F3 (docs):** the round-2 corpus citation named only 5 of the 7 real
    `05-review-findings.md` files that actually carry a marker, omitting
    `sync-peer-file-conflict` and `review-method-axis`; the corrected
    7-file citation is folded into the corpus-measurement paragraph above,
    `collectRoundMarkers`'s own docstring, and README.md's corpus pointer,
    all three now citing the same figures. Re-measured by grepping every
    `05-review-findings.md` under this workspace's `.ai/runs/` for
    `review-method[` and `method-applied[` occurrence and line counts (see
    the task's implementation report for the exact command); per-file
    breakdown is in the corpus-measurement paragraph above. Replaying the
    round-3 built reader against scratch copies of all 7 files (isolating
    only the review-method-axis reasons from each file's full reason list):
    `quickwins-batch48` moves from 1 bounded reason naming 24 rounds absent
    to 1 bounded reason naming all 27 (the `T-011` trio no longer clears
    via the packed line's `Method:` summary, see F2); `open-pool-batch50`
    (5 absent), `memory-sync-wipe` (5 absent),
    `agent-dx-external-prs` (8 absent), `sync-peer-file-conflict`
    (3 absent), `review-method-axis` (2 absent), and `quickwins-batch51`
    (0 reasons, fully clean via its explicit `method-applied[...]`
    markers) are unchanged by F1/F2, since none of their declaration lines
    are immediately followed by a `Method:` line at all.
  - **F4 (tests, docs):** added a CRLF fixture covering the method axis
    (a `review-method[...]` marker plus its `Method:` prose fallback under
    `\r\n` line endings) and a fixture pinning that a malformed, wrapper-less
    `method-applied[...]` mention with NO `review-method[...]` marker
    anywhere in the file still blocks (the malformed-marker nets run
    unconditionally, before the "no declaration at all" backward-compatible
    early return). README.md's backward-compatibility sentence is
    corrected to say so explicitly: a file is unaffected only when it has
    no well-formed marker AND no marker-shaped mention of either field.
  - Two residuals documented rather than fixed (README.md): a fenced code
    block sitting between a `review-method[<round>]` declaration and its
    `Method:` line is blanked by the quoting strip and skipped over rather
    than treated as intervening content; and only `05-review-findings.md`
    is read at all, so a `method-applied[<round>]` recorded in
    `03-decisions.md` or `04-implementation-summary.md` instead is
    invisible to this check.

  Round 4 (accept-with-notes lows from round 3's review) closes two more
  fail-open shapes each of round 3's own fixes introduced, and cleans up
  three docs residuals:

  - **F1 correction (correctness):** round 3's `PROSE_METHOD_TRAILING`
    (`/^(?:[.!?]*|\(.*)$/`) accepted anything after an opening `(`
    verbatim, so a value followed by a parenthetical that never closes
    (`Method: adversarial (`) or one with text appended after it DOES
    close (`Method: adversarial (x) but actually normal`) both wrongly
    resolved. The trailing grammar now requires a BALANCED parenthetical
    aside followed only by end-of-sentence punctuation
    (`/^(?:[.!?]*|\([^)]*\)[.!?]*)$/`); both shapes above are malformed
    records now, and the template's own filled shape (`Method: adversarial
    (briefing and return match).`) still resolves.
  - **F2 correction (correctness):** round 3's single-occurrence-line gate
    counted raw well-formed occurrences per line, so an AGREEING same-round
    duplicate declared twice on one shared line (tolerated per review
    finding F3) was wrongly treated as if two different rounds shared the
    line, and fell through to absent. The gate now counts DISTINCT
    lowercased rounds per line instead: a repeated agreeing declaration of
    one round no longer spoils its own single-occurrence gate, while two
    genuinely distinct rounds packed on one line still fall through to
    absent as before.
  - (docs) README's fallback-value-token sentence still said the token
    reads "up to the first whitespace or `(`"; corrected to include the
    end-of-sentence punctuation the code has always also stopped at
    (`.`, `!`, `?`).
  - (docs) the corpus-measurement paragraph's
    `2026-09-12-agent-dx-external-prs` qualifier, "8 on 1 line, all four
    packed together", wrongly implied 4 rounds; the line actually packs 8
    rounds across 3 PRs (`PR-245` x1, `PR-247` x3, `PR-248` x4) onto 1
    line, corrected accordingly. `quickwins-batch51`'s own moving figure
    is re-measured at 14 `review-method[...]`/`method-applied[...]`
    occurrences on 14 lines each as of this round (was 10/10 at round 3);
    the corpus totals above are updated to match (64 on 41), still with
    the same "measured at time of writing, not fixed" hedge since the run
    stays open.
  - (maintainability) the shipped template's placeholder `review-method`
    marker literal was pinned only inline in one test fixture, with no
    reciprocal-lockstep comment naming its agent-dx counterpart the way
    `OW_FINDINGS_PLACEHOLDER_ROW` is. It is now also exported as
    `OW_REVIEW_METHOD_PLACEHOLDER_MARKER`, carrying the same
    reciprocal-lockstep comment (agent-dx's
    `packages/orchestrator-workflow/test/template-markers.test.ts`), and
    the fixture uses the constant instead of a bare string literal.

- CI now packs this package (`npm pack`) together with its version-locked
  `@lannguyensi/*` sibling dependencies (a breadth-first walk seeded with
  this package, also scanning each discovered sibling's own exact-pinned
  `@lannguyensi/*` `dependencies`/`optionalDependencies` -- not a
  hardcoded list or a single hop), installs every tarball together with
  `--omit=dev` into one scratch consumer directory outside the repo tree,
  and asserts `grounding-mcp --version` there equals the grounding-mcp
  TARBALL's own `package.json` version -- repeating, on every PR, the
  "works from the published tarball" verification that used to be
  manual-only for the runtime `package.json` version read below
  (`scripts/check-grounding-mcp-pack.js`, `.github/workflows/ci.yml`, task
  d341afd5; see `docs/okf/log.md` for the round that added sibling
  co-packing after a lockstep release PR reproduced a registry ETARGET
  without it, and the round that extended the derivation to a recursive
  walk).

- Authoritative assessment store (`grounding-assessment-store.ts`) with its
  frozen static policy module (`grounding-assessment-policy.ts`): a separate
  producer evaluator whose sessions are bound to a validated challenge. It is
  a library wired by the restricted `grounding-assessment-mcp` entrypoint
  (next entry); it does not discover keys, import legacy sessions, or read
  the solver's default ledger or session home.

- `grounding-assessment-mcp`, a dedicated seven-tool stdio producer entrypoint
  for that assessment store, with strict caller schemas, exact receipt
  byte transport, and restart-safe retries. It requires an explicit trusted issuer
  configuration and exposes no legacy execution, path, or solution tools.

- Pure `grounding-receipt/v1` codec and Ed25519 verification primitive with a
  frozen `debug-evidence-assessment/v1` policy snapshot and versioned golden
  conformance corpus. The module is not registered as an MCP tool and makes no
  issuer, session, or task authorization decision.

### Changed

- `readPackageVersion()` now writes one `process.stderr` line naming the
  package and the failure (read error, parse error, or a missing, empty,
  or non-string `version` field) before returning the unchanged
  `'0.0.0'` fallback, instead of swallowing the failure silently; it also
  now takes an injectable `packageJsonUrl`/`read` pair so the failure
  path is unit-testable. The diagnostic write itself is wrapped in its
  own try/catch, so a throwing `process.stderr.write` (closed or bad fd)
  is swallowed and `readPackageVersion()` still returns `'0.0.0'` instead
  of throwing at module load; that never-throws guarantee also covers
  formatting the failure reason itself (a throwing `Error#message` getter
  or a throwing `String(err)` on a non-Error value), and the reason is
  collapsed to a single line before being written (task f31ad37f).

- `server.ts` no longer hardcodes a `PACKAGE_VERSION` literal; the version
  served by the MCP `name+version` handshake and the `--version` CLI
  short-circuit is now read from the package's own `package.json` at
  runtime, so a release bump touches no source file and the release PR
  qualifies for the `merge-approval` label-free path (task ed06b4c8).

- `MAX_LOOKUP_ID_LENGTH` renamed to `MAX_ID_FILENAME_LENGTH` (same value, same
  enforcement points on all three `solution_evaluate*` tools); affects only
  deep importers of `dist/solution-attempt-log.js` that referenced the old
  export name directly.
- `sanitizeVerdictId`'s rejection is now the exported `InvalidVerdictIdError`
  sentinel (`solution-verdict.ts`), scoped to that sanitizer alone;
  `SolutionAttemptRegistry.lookup`'s catch classification matches
  `instanceof InvalidVerdictIdError` instead of the rejection message string.

## 0.11.0, 2026-09-06

### Added

- Attempt lifecycle for `solution_evaluate`, plus two new read-only tools,
  `solution_evaluate_status` and `solution_evaluate_result`. `solution_evaluate`
  now waits only up to an internal bound (45s by default, configurable via
  `createServer({ attemptWaitBoundMs })`) and then returns
  `{status:"running", attemptId, id, pollAfterMs}` instead of blocking further;
  the `preflight` process keeps running to completion in the background and the
  two lookups resolve it afterwards, by `attemptId` or, with `attemptId`
  omitted, as the latest attempt for that id. A run that finishes inside the
  bound returns exactly the previous payload plus `status` and `attemptId`. Why
  45s and not a derived number: the governing deadline is the calling client's
  own per-call wall-clock limit, which this server cannot know, so the bound is
  a configurable value that keeps a deliberate margin under the MCP SDK's 60s
  default request timeout without assuming that default governs every client.
- Per-sanitized-id append-only attempt log
  (`<verdict dir>/<id>.attempts.jsonl`, mode `0600`): four record kinds
  (`start`, `terminal`, `reconciled-unknown`, `tombstone`), one `O_APPEND`
  write per record capped at 2 KiB of UTF-8 with the persisted error string
  truncated first and marked, and a reader that skips an unparseable line
  instead of aborting or rewriting the file. Terminal attempts are compacted
  into a tombstone carrying their own outcome class after a retention window
  (24h by default, always at least 100x the advertised `pollAfterMs` so a
  caller polling at the advertised cadence cannot have its target pruned
  between two polls): a pruned terminal attempt reads `expired`, a pruned
  `unknown` attempt keeps reading `unknown`.
- Cross-process mutual exclusion for one id, delegated to `proper-lockfile`
  (new runtime dependency; the same library the harness already wraps) against
  a per-id anchor file `<verdict dir>/<id>.attempt-lock` (mode `0600`), with
  `retries: 0` on every acquisition, `stale: 30000`, `realpath: false`, and an
  `onCompromised` callback. Acquired means this process runs the attempt;
  `ELOCKED` means a holder is alive, so the caller joins it by `attemptId` and
  never spawns a second `preflight` process. `forceNewAttempt: true` is refused
  while an attempt is live. A holder whose lock is reported compromised writes
  NO marker for its attempt, records a `terminal` record with `outcomeClass:
  "compromised"`, returns an explicit error, and never deletes a lock.
  Staleness, reclamation and compromise detection belong to the library; this
  package implements none of them. The invariant is scoped to one host and to
  holders whose heartbeat keeps their lock fresh, and it buys avoided waste
  plus one in-flight handle to join, never gate safety: `solution_gate` already
  fails closed on every outcome a duplicate run can produce.
- `reconcileOrphanedAttempts()` runs once at process startup, before the
  transport connects: for every log row still reading `running` under a lock the
  pass itself can acquire, it appends one `reconciled-unknown` record inside
  that acquisition. An id whose acquisition returns `ELOCKED` is skipped, since
  that is the liveness check. The identical check also runs on the read path, so
  a holder that died after the last startup is not reported `running` until the
  next restart. Liveness is the lock and only the lock; no code path probes a
  PID.
- All three tools, `solution_evaluate` included, bound `id` at 200 characters
  (`MAX_LOOKUP_ID_LENGTH`, derived from what an id has to fit into: every id
  becomes a file name inside the verdict dir, and the longest one this package
  derives, the compaction temp file, runs about 48 characters past the id).
  The bound is enforced twice: as `.max(MAX_LOOKUP_ID_LENGTH)` on every tool's
  `id` schema, and again at `SolutionAttemptRegistry.evaluate()`'s own entry
  point, so a library caller that bypasses the MCP schema still gets the
  ordinary `{status:"failed", error}` payload before any filesystem call. An
  id that passes the bound but is still unusable (`..`, `.`) is answered on
  the two lookups with `{status:"unknown", id, error}` rather than an MCP
  error envelope, the same posture `solution_evaluate` already had for the
  same id.
- The owning process's in-memory record of an attempt ages out on the same
  retention window as the on-disk log (`pruneOwned`, triggered at the tail of
  every uncompromised acquisition, and again whenever a
  lookup finds and reconciles a `running` row for any id): once pruned, even
  the process that originally ran the attempt answers `solution_evaluate_result`
  with the reduced, persisted payload, same as any other process. The sweep is
  process-wide, not scoped to one id, so it can prune one id's owned record as
  a side effect of this process touching a different id.

- `solution_evaluate` sends standard MCP `notifications/progress` pings while its
  single preflight invocation (in-band with the request: awaited, not
  backgrounded) is running, mirroring agent-preflight's
  own `withProgressPings` convention: only when the request carries a
  `progressToken` (no token means no timer at all, not just no notification), a
  monotonically increasing tick count every ~10s (configurable for tests via
  `createServer({ progressIntervalMs })`), meaning "still running", never a
  fabricated percentage. The ping timer is always cleared on completion (success,
  a returned error, or a thrown exception) and also as soon as the SDK's own
  cancellation signal fires for the request; a notification send failure is
  swallowed and does not change the evaluation's outcome. No schema, gate, signing,
  or preflight-invocation-count change: still exactly one preflight process per
  evaluation. See README's "Progress notifications while `solution_evaluate` runs"
  for what this does and does not fix (a client still needs
  `resetTimeoutOnProgress` or a raised timeout for the pings to help, and a hard
  total deadline, a dropped connection, or a client that ignores progress
  altogether are all unresolved by this alone).
- `solution_evaluate` now returns advisory preflight diagnostics for its single
  evaluation process. The compact verdict and its marker projection remain unchanged;
  diagnostics preserve the parsed payload and report availability, execution outcome,
  shape completeness, and issues without becoming signed or gate authority.

### Changed

- `evaluateSolution` accepts an optional `preWriteGuard` callback, read
  immediately before the marker write and never after it. Its only caller is the
  attempt lifecycle's compromised-holder path; absent a guard the behavior is
  unchanged, which is the case for every existing caller. `Verdict`,
  `writeVerdict`'s signed shape, `verdictPath`, `evaluateGate` and
  `solution_gate` are untouched.

- `solution_evaluate` accepts a preflight verdict only for exit `0` plus
  `ready:true`, or exit `1` plus `ready:false`, with no signal or invocation
  error. It validates the independent verdict core (`ready`, finite bounded
  `confidence`, string-array `blockers`, and no blockers when ready) before
  producing a marker. Diagnostics remain advisory and preserve additive fields.
  Every valid-id re-evaluation invalidates an earlier same-id marker before an
  error return or marker write, including signing/write failures. If deletion
  itself fails, the error states that the old marker may remain; the guarantee
  is sequential for writable marker storage and does not cover concurrent
  writers or id collisions.

## 0.10.0, 2026-09-04

### Added

- **`run-base` marker: fail closed on an unreadable attempted marker, not just
  an unmatched or near-miss one** (task 6da2c230). `readOwRunCompleteness`
  (`src/ow-run-completeness.ts`) previously fell through to the legacy
  date-heuristic path whenever a keyed marker attempt did not start its own
  line: a list bullet (`- <!-- ... -->`), a marker embedded in prose, a bare
  `run-base[k] = <sha>` with no comment wrapper, or an attempt preceded by
  leading text all read as markerless, fail-open. Measured in task 43a7ef58
  review round 3/4: five such variants each resolved `runBaseKind 'absent'`,
  `complete true`. A third, position-independent check now closes this: any
  UNQUOTED line in `00-goal.md` naming BOTH exact, case-sensitive marker
  tokens (`solution-acceptance` and `run-base`) but not accepted as a
  well-formed keyed or unkeyed marker collects into a `malformed` blocker
  (`runBaseKind: 'malformed'`); a well-formed marker (keyed or unkeyed) still
  carrying the template's `TODO` placeholder is unaffected and stays
  fail-open (`runBaseKind: 'todo'`), per the orchestrator-workflow kit's
  documented markerless/TODO contract. No change to `src/solution-verdict.ts`:
  it already composes the reader's `reasons`/`complete` generically, so the
  new blocker surfaces through the existing `owBindingBlockers` path with no
  code change there.

  Round 2 (task 6da2c230, review round 1 findings) closed three false
  positives found by measuring the round-1 check against the real corpus of
  94 run directories under pandora/harness/agent-grounding: (1) the
  well-formed-unkeyed-marker exemption now tracks what the resolver
  (`matchMarker`) actually reads a value from (a line starting with the
  comment opener, `solution-acceptance:`, `run-base`, `=`, and a
  non-whitespace value, WHATEVER follows on the line), instead of a
  whole-line-only shape; 9 real runs whose unkeyed marker carried a trailing
  annotation or the pandora multi-repo convention's `= multi-repo; see keyed
  markers below` had resolved a value AND been reported malformed under the
  whole-line-only shape, regressing `complete: true` to `complete: false`.
  (2) Orchestrator decision D-027 amends round 1's fence choice: a phrase
  occurrence entirely inside a single-backtick inline code span or a fenced
  code block now reads as a quotation of the marker syntax, not an attempted
  marker, and is exempt (a second, unquoted mention of the phrase on the same
  line still blocks). 2 real runs that only ever quoted the marker syntax in
  backticks (prose documentation, template examples) had self-blocked under
  round 1's "a fence is not an excuse" stance; this fixes them. (3) a malformed line caught
  only by the third (phrase) net now gets a distinct reason ("names the
  run-base marker tokens but is not a well-formed marker") instead of the
  keyed-shape hint, which misled an operator whose line never attempted
  bracket syntax at all. After all three fixes, re-measuring the same 94-run
  corpus: zero runs regress from `complete: true` at the pre-round-1 baseline
  to `complete: false`. Also fixed: the malformed-line excerpt is now
  truncated to its 80-char budget BEFORE the `line N: ` prefix is added (the
  prefix previously ate into the excerpt's own budget). Covered by
  `tests/ow-run-completeness.test.ts` (byte-exact regression tests for the
  real corpus lines, the quotation exemption plus negative controls, the
  distinct phrase-only reason, and a pin on the exact `line N: <excerpt>`
  text with the marker off line 1).

  Round 3 (task 6da2c230, review round 2 findings) tightened both nets D-027
  introduced, which the round-2 reviewer measured as too loose: (1) the
  single-backtick inline-span pairing was whole-file and non-greedy, so a
  stray backtick could pair with another stray backtick many lines away
  across a blank-line paragraph break, accidentally exempting a real,
  phrase-carrying line sitting between them. The span is now bounded at a
  paragraph break (never contains `\n\s*\n`); crossing one or more
  consecutive non-blank lines is still allowed, matching the one real corpus
  file (`.ai/runs/2026-07-16-ow-kit-run-base-marker/00-goal.md`) that relies
  on a span opened on one line and closed on the next. (2) the fence
  detector toggled on ANY line starting with 3+ backticks or tildes,
  regardless of character or run length, so an unclosed fence exempted
  everything to end of file (fail-open) and a tilde-delimited fence line
  inside a backtick-delimited fence closed it (or vice versa). A fence now
  closes only on a later line whose delimiter is the SAME character and AT LEAST AS LONG as the
  opener's; an opener with no matching closer fences NOTHING (fails closed,
  not "to EOF"); a blockquoted fence's `> ` prefix is not recognised as a
  fence at all (also fail-closed, and documented as a known residual: an
  unrecognised backtick-delimited fence's own backticks can still interact
  with the separate single-backtick span heuristic, a quirk of not being a
  real parser). Both fixes are covered by new tests: a `~~~`-delimited fence
  around a phrase-carrying bullet (exempt) with a negative control (a `~~~`
  pair placed after the marker line does not retroactively exempt it); an
  unclosed backtick-delimited fence opener followed by a phrase-carrying
  bullet (blocks); a `~~~` line inside a backtick-delimited fence, and the
  mirror, each still inside the fence (exempt); stray backticks before and after a bullet
  separated by blank lines (blocks); a blockquoted fence around a bullet
  (blocks); a fenced well-formed keyed marker (pinned: still selected as the
  binding, `runBaseKind: 'sha'`, an intentional asymmetry: only the phrase
  net is quoting-aware); and a purely quoted unkeyed marker as the only
  occurrence in the file (pinned: still resolved by the legacy substring
  matcher, an accepted residual). Also closed: module docstring, README, and
  the `docs/okf/solution-acceptance-verdict-contract.md` consumer doc
  previously said the quotation exemption worked "the same way rendered
  Markdown treats one": corrected to describe the actual heuristic (span
  and fence rules above) and to state the phrase-net/keyed-net asymmetry and
  the purely-quoted-unkeyed-marker residual explicitly; the corpus counts
  (94 run directories, the "2 real runs" and "9 runs" figures) and the
  concrete pandora repo-name annotation example moved out of the module
  docstring, README, and consumer doc into this changelog entry, replaced by
  a generic description ("an unkeyed marker whose value is followed by a
  trailing annotation") and a one-sentence pointer here.

  Re-measured against the real corpus under a fresh worktree checkout at
  every dated run directory found under `~/git/pandora/.ai/runs/` and every
  nested `*/.ai/runs/` (104 run directories total, 2026-09-02): zero verdict
  changes (`complete`/`runBaseKind`/`runBase`/`reasons`) between this
  round's HEAD and both (a) the commit immediately before round 3's fixes,
  and (b) the commit at the start of this task, before round 1. The one real
  corpus file relying on the cross-line inline span
  (`2026-07-16-ow-kit-run-base-marker/00-goal.md`) still resolves
  `complete: true` with no blocker reasons after the paragraph-break
  bounding.

## 0.9.0, 2026-08-28

### Added

- **OW run resolution is now pointer-first, with keyed `run-base` markers**
  (task 43a7ef58). `readOwRunCompleteness` (`src/ow-run-completeness.ts`)
  resolves the worktree-local `.ai/run` pointer file before falling back to
  the newest-run scan of `.ai/runs/`; the scan is consulted only when no
  pointer file exists. A pointer file that exists but does not resolve
  (unreadable, empty, a relative path, or a target missing / not a
  directory / not a dated run directory) is a distinct fail-closed blocker
  and never silently falls back to the scan. Which channel resolved the run
  is reported on the new `runSource: 'pointer' | 'scan' | null` field. The
  `run-base` change-binding marker in `00-goal.md` may now also be keyed per
  repo (`run-base[<repo-basename>] = <sha>`), so one run can bind more than
  one repo in a monorepo/fleet: selection tries the worktree's own basename
  first, then — for a linked git worktree — the main repository's basename
  (resolved via the worktree's `.git` `gitdir:` file and `commondir`), and
  the first key whose keyed marker is present decides, without falling
  through to a later key or the legacy unkeyed marker. `owBlockersFor`'s
  `on`-knob "no run" message (`src/solution-verdict.ts`) now names both
  resolution channels. The `.ai/run` pointer file and the keyed markers are
  written by the orchestrator-workflow kit's writer side (agent-dx task
  2c3d141c, not yet released); this repo only reads and verifies them.
  Covered by `tests/ow-run-completeness.test.ts` (reader unit tests,
  including real and fabricated linked-worktree fixtures) and
  `tests/ow-run-binding.test.ts` (`owBlockersFor` end-to-end through real
  `git worktree add` fixtures, attached and detached).
  - Review-round-1 fixes (task 43a7ef58, T-001): a goal file with keyed
    `run-base` markers but none matching this worktree's candidate keys,
    and no unkeyed marker either, is now an explicit fail-closed blocker
    naming the keys found and the keys tried — previously this fell
    through silently. Candidate-key matching against the recorded keyed
    markers is now case-insensitive. `resolveRunPointer` resolves the
    pointer target through `fs.realpathSync` before the directory/dated
    checks, so a symlinked run directory is followed to its real path.
    `findWorktreeRoot` now uses `fs.lstatSync` instead of `fs.existsSync`,
    so a dangling `.git` symlink still marks the worktree root instead of
    being treated as absent.
  - Review-round-1 fixes (task 43a7ef58, T-004): `OwRunCompleteness` gains
    `runBaseKind: 'sha' | 'todo' | 'absent' | 'unmatched-keyed'`, naming WHY
    `runBase` has the value it has. `owBindingBlockers` (`src/solution-verdict.ts`)
    now skips the legacy date-heuristic path outright when
    `runBaseKind === 'unmatched-keyed'`: previously, a goal file with keyed
    `run-base` markers that matched none of this worktree's candidate keys
    (and no unkeyed marker) correctly got the reader's own explicit
    fail-closed reason, but the binding check still ran the heuristic on top
    of it and could append a second, misleading "has no run-base marker"
    blocker for the same underlying failure. Now exactly one blocker is
    reported.
  - Review-round-2 fix (task 43a7ef58, T-005): keyed `run-base` markers are
    now a grammar instead of one regex per accepted shape. A well-formed
    keyed marker must be a WHOLE LINE (leading/trailing whitespace only)
    matching `<!-- solution-acceptance: run-base[<key>] = <value> -->`; a
    line that starts like one (`run-base[`, optionally with stray whitespace
    before the bracket) but does not match the strict shape is now collected
    as an explicit MALFORMED blocker instead of degrading silently to the
    legacy date heuristic — previously a near-miss such as `run-base
    [alpha] = <sha>` or `run-base[alpha = <sha>` (missing bracket) or an
    empty value fell straight through, unnoticed. `OwRunCompleteness`'s
    `runBaseKind` gains `'malformed'`; `owBindingBlockers` skips the
    heuristic for both `'malformed'` and `'unmatched-keyed'`, so exactly one
    blocker is still reported, never two. A strict match whose key is itself
    a documentation placeholder (`<repo-basename>`-style) is ignored, not
    counted as present; a prose line that merely quotes the marker syntax,
    or a marker that does not start its own line, is also ignored — the
    collection regex is now whole-line-anchored, so it can no longer be
    blocked by a complete line quoting the marker form, nor swallow the next
    line's first token on an empty value. Both new blocker messages are
    bounded (keys truncated to 64 chars / 10 shown, malformed lines
    truncated to 80 chars / 5 shown, `(+N more)` beyond that). The legacy
    unkeyed `run-base` matcher is unchanged (documented asymmetry: it stays
    a non-line-anchored substring match).
  - Review-round-3 fix (task 43a7ef58, T-006): the strict keyed-marker shape
    stays exact, but the LOOSE net that decides whether a line was an
    *attempt* at a keyed marker is now tolerant of the deviations that sit
    BEFORE the `run-base` token and previously slipped past both nets: it is
    case-insensitive (`RUN-BASE[`), allows whitespace around the colon
    (`solution-acceptance : run-base[`), and accepts one or more dashes in
    the comment opener (`<!--- `). Such a line now BLOCKS as malformed
    instead of falling through to the legacy date heuristic. The line-start
    anchoring of both nets is unchanged and is now documented as a
    deliberate residual rather than as "ignored": a keyed marker that does
    not start its own line (a list bullet, a marker embedded in prose, a
    bare `run-base[k] = <sha>` with no comment wrapper) is not a marker at
    all, so with no other applicable marker the run behaves as markerless
    and falls through to the legacy date heuristic (fail-open by design; a
    fully fail-closed variant is tracked as its own task, 6da2c230). Both residual
    shapes, the placeholder-key filter standing alone (no unkeyed marker to
    mask it) and the `(?!-->)` value guard are now pinned by their own
    tests.

## 0.8.0, 2026-08-19

### Added

- Dependency pin moved to `@lannguyensi/runtime-reality-checker@^0.3.0`
  (resolves to the published 0.3.0 today; satisfies the staged workspace
  0.3.2 for the pin-consistency guard). 0.3.1/0.3.2 are registry-held (package-specific
  server-side block, npm support ticket pending) and carry no API delta
  this package consumes; the rrc-internal symlink-containment fix (#142)
  follows with the next pin bump once the hold is lifted.

- **`bin` entry normalized to `dist/server.js` (no `./` prefix)** (task
  256d65a6): npm >= 11 strips `./`-prefixed bin targets from the manifest it
  submits at publish time ("auto-corrected ... and removed"), which both
  loses the bin in the registry metadata and diverges the submitted
  manifest from the tarball's own package.json. All packages in this repo
  got the same normalization; the published artifacts already carried the
  `./`-free form (they were published by npm 10).

- **`solution_evaluate` now signs the verdict marker.** The marker
  `writeVerdict` (`src/solution-verdict.ts`) writes to
  `$SOLUTION_VERDICT_DIR`/`~/.local/state/agent-grounding/solution-verdicts/`
  carries two new fields, `alg` (`'hmac-sha256-v1'`) and `signature`
  (HMAC-SHA256 hex), computed by the new `src/verdict-signing.ts`. The
  producer signs **unconditionally**: there is no unsigned fallback. The
  signing key lives at `<harness-home>/harness.generated/.approval-signing.key`
  (`getOrCreate`: read an existing >=32-byte file, else generate and write
  `crypto.randomBytes(32)` at mode `0600`, race-tolerant against a
  concurrent creator); `<harness-home>` is resolved with the same
  precedence the harness consumer uses (`$HARNESS_HOME` env override,
  else `~/.harness` if it exists, else `~/.claude` if it already carries
  harness state, else `~/.harness` created on first use). This is an
  additive change to the on-disk shape: the 7 previously-pinned verdict
  fields (`id`, `head`, `ready`, `confidence`, `blockers`, `timestamp`,
  `source`) are unchanged, so existing non-harness readers of the marker
  are unaffected. Proven against harness' own consumer-side verification
  logic by a vendored interop suite
  (`packages/grounding-mcp/tests/interop/`): a real `writeVerdict` marker
  is accepted, and tampering, cross-id replay, and an unrecognized `alg`
  are all rejected the same way harness itself rejects them.
- **`SOLUTION_VERDICT_SIGNING_KEY` env projection (primary key path).**
  When set (an absolute path to the signing-key FILE, projected by harness
  at apply time onto this MCP server's env following its
  `EVIDENCE_LEDGER_DB` pattern; slice H1 of the task-9b6c4beb Option-2
  design), the producer reads/creates the key at exactly that path and the
  mirrored home resolution above becomes the documented fallback for
  non-harness-managed setups. This removes the one ambiguity the mirror
  cannot close (a harness run under `--config` / a non-default home).
  `getOrCreate` semantics apply at the projected path too, so whichever
  side runs first creates the shared key race-tolerantly.

  **Release sequencing warning.** `grounding-mcp-v0.8.0` MUST be published
  to npm and installed on every machine running the `grounding-mcp` MCP
  server **before** harness task `c7c3f606`
  (`batch19/sign-verdict-marker`) is merged/released. Once the harness
  consumer ships, it verifies every solution-acceptance verdict marker's
  signature before trusting it, and a marker written by a producer older
  than 0.8.0 carries no `alg`/`signature` at all. That shape does **not**
  hit the consumer's narrow "genuinely unsigned, not forged" carve-out
  (which only fires when a required signed field, e.g. `timestamp`, reads
  blank AND `alg`/`signature` are both absent); a realistic legacy marker
  still has a valid `timestamp`/`source` and no `alg`/`signature`, which
  the consumer classifies `forged: true` via its generic "missing
  signature (legacy pre-signing marker, or forged file)" branch. Releasing
  harness first therefore denies the completion gate universally for
  every repo still on a pre-0.8.0 grounding-mcp, not just for genuinely
  forged markers.

## 0.7.1, 2026-08-06

### Changed

- Re-pin `runtime-reality-checker` to 0.3.1. Picks up the phantom
  `chalk`/`commander` dependency removal caught by the new repo-wide
  `check:deps` guard (`scripts/check-deps.js`); the exact-pin lockstep
  convention used for internal `@lannguyensi/*` deps means the workspace
  bump alone does not update what grounding-mcp bundles. No behavior
  changes from the re-pin itself.

## 0.7.0, 2026-07-18

### Fixed

- **OW reader: close the mixed-state findings-table bypass.** `readOwRunCompleteness` previously reported a run as `complete` whenever the solution-acceptance markers were set to an accepted value, even if the Findings table still carried the shipped review template's untouched placeholder/legend row and no concrete finding row had ever been added — an operator could flip the markers to `accepted`/`accept` without ever transferring the reviewer's findings into the table. The reader now recognizes that placeholder row by a byte-exact match of the COMPLETE shipped row (every cell, not just the Severity slash-list) and blocks with `complete: false` when it survives untouched AND no row anywhere carries a concrete severity, naming both escape hatches in the reason (transfer the findings, or delete the placeholder row for a genuine zero-findings review). Unaffected: a header row with no data rows at all (the placeholder already deleted) stays `complete: true`, and a concrete finding row sitting next to a left-behind placeholder row is still valid, as before. Lockstep with agent-dx's `packages/orchestrator-workflow/assets/templates/05-review-findings.md` placeholder row and its `test/template-markers.test.ts` pin; the exact row text is exported as `OW_FINDINGS_PLACEHOLDER_ROW` and pinned by a reciprocal test on this side.

### Changed

- Re-pin the four version-locked libs (`claim-gate`, `evidence-ledger`,
  `grounding-wrapper`, `hypothesis-tracker`) to 0.6.0. Picks up the
  evidence-ledger `getDb` guard fix and the uniform `engines >=20` baseline.
  No behavior changes from the re-pin itself.

## 0.6.1, 2026-07-17

### Changed

- Re-pin the four version-locked libs (`claim-gate`, `evidence-ledger`,
  `grounding-wrapper`, `hypothesis-tracker`) to 0.5.1. Picks up the
  evidence-ledger `better-sqlite3` `^12.9.0` bump, which unbreaks
  `npm i -g @lannguyensi/grounding-mcp` on Node 26 (9.x has no Node 26
  prebuilds and no longer compiles from source). No behavior changes.

## 0.6.0, 2026-07-02

### Added

- **OW run-to-change binding (staleness fail-open fix).** A process-complete OW run now also has to CLAIM the current change; before, the newest `.ai/runs/` dir was judged with no linkage to HEAD/branch/date, so one old accepted run kept the gate green for every later change in the repo.
  - **Marker path (new kit):** `00-goal.md` may carry `<!-- solution-acceptance: run-base = <sha> -->` (the repo HEAD recorded at run creation). The arm blocks when the recorded base does not resolve to a commit, is not an ancestor of the current HEAD, or lies strictly behind the fork point of the current change (merge-base of HEAD with the remote default branch). Marker values are validated as 7-40 hex before any git call (argv-injection guard). Without a resolvable remote default ref the fork-point check is skipped (documented residual for local-only linear history).
  - **Legacy runs without the marker (tolerant downgrade, decided fail direction):** day-granular date heuristic — blocks only when the run dir's `YYYY-MM-DD` prefix is strictly older than the author date of the oldest commit since the fork point (fallback: HEAD's author date). A same-day stale run passes (documented residual); a multi-day run does not false-block because it is compared against the FIRST commit of the change.
  - All binding state flows through the existing `blockers[]` strings (prefix `orchestrator-workflow: `); the verdict marker keeps its pinned 7-key shape.
  - `readOwRunCompleteness` now also returns `runName` and the raw `runBase` marker value; `owBlockersFor` is async.
  - **Marker producer status:** the orchestrator-workflow kit (agent-dx) does not emit the `run-base` marker yet — sibling task `ow-review-2026-07-01/run-binding-kit` adds it to the `00-goal.md` template. Until that kit version ships, every run takes the legacy heuristic path; this is the tolerant-by-design rollout order (reader first).
  - **Pre-merge by design:** evaluating at an already-pushed default-branch tip (fork point == HEAD) false-blocks on both paths; deliberate fail-closed direction, pinned by a test. Evaluate before pushing (the normal ship-flow order) or start a new run.

### Fixed

- **OW reader parser robustness bundle** (same unreleased 0.6.0, review finding 4 of 4):
  - A marker still carrying the template's `TODO` placeholder now blocks with its own reason ("marker is still TODO, replace it with the chosen enum value") instead of the misleading "no solution-acceptance marker" message, and still never falls back to prose.
  - Acceptance-marker values capture only the word-shaped enum charset, so sloppy spacing (`= accepted-->`) resolves to `accepted` instead of blocking on `accepted-->`. The `run-base` binding marker keeps its raw capture (shas may start with digits; malformed values must reach the hex guard and block explicitly).
  - ALL findings tables are parsed, not just the first: a second review round appending its own table no longer hides new high/critical findings (fail-open closed).
  - A findings section with content but no findings table anywhere now yields an explicit "not in the expected table format" blocker instead of silently reporting zero findings (fail-closed on format drift). All findings-style headings are scanned; multi-line HTML comments do not count as content.
  - A PRESENT acceptance marker whose value is not word-shaped (e.g. `= 1accepted`) now blocks as malformed instead of falling back to prose — a broken machine channel must never be overridden by a filled prose line.
  - **Adoption note:** the format blocker anchors on the `Severity` + `Decision` header from the shipped review template. Review files written with a Decision-less convention (e.g. `| Severity | Finding | Resolution |`, seen in live runs) will surface the blocker until they converge on the template header; the merge gate consuming this verdict is advisory.

### Changed

- `hypothesis_support` now returns `error: "hypothesis_not_found_rejected_or_checks_pending"` (was `hypothesis_not_found_or_rejected`) to reflect the hypothesis-tracker change that refuses to confirm a hypothesis while its declared `required_checks` are still pending (audit finding M7).
- Re-pinned the lockstep dependencies (`claim-gate`, `evidence-ledger`, `grounding-wrapper`, `hypothesis-tracker`) to `0.5.0` (the release that actually ships the M7 gating and the evidence-ledger WAL/perms hardening).

## 0.5.0, 2026-06-22

### Added

- **Orchestrator-workflow (OW) process-completeness arm in `solution_evaluate`.** The producer now folds `readOwRunCompleteness(repoPath)` (handoff accepted, review recommends accept, no unresolved high/critical findings) into the verdict's `ready` and `blockers`. OW state flows ONLY through those two existing fields, so the verdict marker keeps its pinned 7-key shape (`id`, `head`, `ready`, `confidence`, `blockers`, `timestamp`, `source`) and consumers need no change. Each OW blocker is prefixed `orchestrator-workflow: ` so a deny reason names the arm.
  - **Knob** `<repoPath>/.ai/solution-acceptance.json` `{ "orchestratorWorkflow": "auto" | "on" | "off" }` (new `resolveOwKnob` helper). `off` never gates on OW; `auto` (default) gates only when a `.ai/runs/` run is present; `on` additionally blocks when enforcement is requested but no run exists. Fail-SAFE: a missing, unreadable, unparseable, or invalid config resolves to `auto` (never silently `off`).
  - **Backward-compatible:** for a repo with no `.ai/runs/` under the default `auto` knob the produced verdict is byte-identical to the pre-OW output (preflight still solely decides `ready`/`blockers`).

## 0.4.0, 2026-06-16

### Added

- **`hypothesis_reset` verb and a bounded LRU hypothesis store** (#113). A new MCP verb clears the recorded hypotheses for a session, and the in-memory hypothesis store is now a bounded LRU so a long-lived server cannot grow it without limit.

### Changed

- Re-pinned the lockstep dependencies (`claim-gate`, `evidence-ledger`, `grounding-wrapper`, `hypothesis-tracker`) to `0.4.0` and `runtime-reality-checker` to `0.3.0` to track the coordinated 0.4.0 release.

## 0.3.3, 2026-06-09

### Fixed

- **Security (HIGH): session id path traversal in the read verbs** (#102). `grounding_advance`, `grounding_guardrail_check`, and `claim_evaluate_from_session` passed a client-controlled `sessionId` straight into `loadSession` / `sessionExists`, which built the path via `join(sessionsRoot(), `${id}.json`)` with no sanitisation, so a client could send `sessionId` `"../../../../etc/hostname"` to read or probe arbitrary `<path>.json` files outside the sessions root. A new `sanitizeSessionId()` (mirroring `sanitizeVerdictId()`: collapse non `[A-Za-z0-9._-]` to `_`, `path.basename`, reject `""` / `"."` / `".."`) is now called inside `pathFor()`, so `loadSession`, `saveSession`, and `sessionExists` all inherit the guard. Server-generated ids (`gs-<slug>-<base36>`) use only safe characters, so legitimate sessions are unaffected.

## 0.3.2, 2026-05-30

### Added

- Solution-acceptance gate (#100): two MCP tools that make "done" earned
  from a real preflight run rather than claimed.
  - `solution_evaluate`: runs `preflight run <repoPath> --json` (the
    agent-preflight lint / typecheck / test / audit / secret battery),
    derives a verdict from its real results, and records a HEAD-pinned
    verdict marker for an id. The check set comes from the repo's
    committed `.preflight.json`, not from caller input, so an agent
    cannot weaken the gate at call time (producer != solver). Fails
    closed (writes no marker) when the `preflight` binary is unavailable;
    override its path with `SOLUTION_PREFLIGHT_BIN`.
  - `solution_gate`: read-only check that allows only when a ready
    verdict exists at the current git HEAD, else returns a precise deny
    reason (no verdict / not ready + blockers / HEAD drift / unresolvable
    HEAD).
  - Verdict markers live outside the agent-writable evidence-ledger at
    `~/.local/state/agent-grounding/solution-verdicts/<id>.json`
    (`$XDG_STATE_HOME` honored, `SOLUTION_VERDICT_DIR` overrides). The
    HEAD pin invalidates a green verdict on any rework; a not-ready run
    overwrites a prior green marker.
  - Documented residual: a shell-capable agent could still hand-write the
    marker file; closing that (a harness-owned dir checked by a PreToolUse
    write-guard, then signing) is the harness wiring follow-up
    (harness task `cc43c7a4`).

## 0.3.0, 2026-05-26

### Added

- `hypothesis_*` MCP tool surface wrapping `@lannguyensi/hypothesis-tracker`:
  `hypothesis_record`, `hypothesis_list`, `hypothesis_evidence`,
  `hypothesis_check_done`, `hypothesis_reject`, `hypothesis_support`.
  In-memory store namespaced by sessionId (one Map per server process;
  persistence intentionally out of scope, the ledger is the durable record).
  Closes Phase 1 Schritt 2 of the agent-grounding phase plan, the tracker
  was previously library-only and never exercised against real sessions.
- New runtime dependency: `@lannguyensi/hypothesis-tracker@0.2.0`.

## 0.2.0, 2026-05-15

### Added

- `grounding-mcp --version` (alias `-v`): fast-exit CLI short-circuit
  that prints the package version and returns 0 without opening the
  stdio MCP transport. Tooling that probes installed MCP binaries (e.g.
  `harness doctor`'s `tools.mcp[]` `min_version` check) otherwise hangs
  on stdin waiting for the initialize request that never arrives.

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `grounding-mcp` (unscoped,
`private: true`) inside the agent-grounding monorepo. PR #66 renamed it to
`@lannguyensi/grounding-mcp`, dropped the private flag, and wired up the
tag-driven `publish-libs.yml` workflow.

### What ships

A stdio MCP server that exposes the agent-grounding stack as tools a
long-running Claude Code session can call:

- `grounding_start` / `grounding_advance` / `grounding_guardrail_check`:
  session lifecycle, wraps `@lannguyensi/grounding-wrapper`.
- `ledger_add` / `ledger_summary`: evidence-ledger surface, wraps
  `@lannguyensi/evidence-ledger`.
- `claim_evaluate` / `claim_evaluate_from_session`: claim-gate evaluation
  against caller-supplied context or auto-derived from session state.
- `verify_memory_reference`: memory-citation freshness check, wraps
  `@lannguyensi/runtime-reality-checker`.

Bin: `grounding-mcp`. Storage: `~/.grounding-mcp/sessions/<id>.json` for
session state, `~/.evidence-ledger/ledger.db` for ledger entries (override
via `GROUNDING_MCP_SESSIONS_DIR` / `EVIDENCE_LEDGER_DB`).

### Install paths

```bash
npm install -g @lannguyensi/grounding-mcp     # global, exposes the bin
# or invoke via npx in your Claude Code settings.json mcpServers config
```

### Runtime dependencies

All resolved from npm:
`@lannguyensi/claim-gate@0.2.0`,
`@lannguyensi/evidence-ledger@0.2.0`,
`@lannguyensi/grounding-wrapper@0.2.0`,
`@lannguyensi/runtime-reality-checker@0.1.0` (released alongside this one),
`@modelcontextprotocol/sdk@^1.29.0`, `zod@^3.23.8`.
