# Log

<!-- Add new entries at the top, newest first. -->

- 2026-09-07T06:15:00Z, merge-approval pure-release exception, round 2
  (task `4493b316`): fixes from the reviewer's first pass over the round-1
  diff below. The path-shape check alone was blind to content: a PR
  touching only `package.json` could still add a `postinstall` script or a
  new dependency, and a lockfile-only PR could repoint `resolved`/
  `integrity`, while still classifying pure on path alone. Added
  `classifyPullFiles(files)` (`scripts/release-exception.js`), which takes
  the real `listFiles` API objects rather than plain path strings and
  additionally requires: (1) `status` is `added` or `modified`, never
  `renamed`/`removed` (a rename's `previous_filename` is never itself
  checked against the allowlist); (2) for `package.json`/
  `package-lock.json` only, the `patch` diff text changes nothing but
  `"version": "…"` value lines, and a missing `patch` field is NOT pure,
  fail-closed. `classify(paths)` is kept unchanged as the path-only CLI
  helper. `.github/workflows/merge-approval.yml`'s release-exception step
  now calls `classifyPullFiles` with each file's `filename`/`status`/
  `patch`
  (`merge-approval.yml:46-91#"core.setOutput('pure_release', pure_release.toString());"`)
  and also compares the paginated file count against the PR's own
  `changed_files`, forcing `pure_release: false` on a mismatch rather than
  risking a partial page reading as pure. The five action inputs
  themselves are unchanged
  (`merge-approval.yml:119-123#"evidence-logged: ${{ steps.labels.outputs.evidence_logged == 'true' || steps.release_exception.outputs.pure_release == 'true' }}"`).
  New unit tests cover: the real package.json/package-lock.json
  version-bump patches of PR #190 (captured read-only via `gh api
  repos/LanNguyenSi/agent-grounding/pulls/190/files`), a postinstall
  addition and a lockfile `resolved` change (both not pure), a missing
  `patch` field (not pure), a version line with and without a trailing
  comma, a nested unrelated `"version"` key (still fine), a rename into an
  allowlisted `CHANGELOG.md` path and a removed `package.json` (both not
  pure), a multi-package pure list, case-insensitive allowlist matching
  (`PACKAGE.JSON`/`Package.json` and a nested-package uppercase form, all
  rejected), and a leading-`./` path form (rejected). Mutation probes via
  `agent-primitives probe --plan`, each on the test command `node --test
  scripts/release-exception.test.js`: replayed the round-1 pair (widening
  `PACKAGE_ALLOWLIST_PATTERN`, and the empty-list `>= 0` swap, both still
  killed), plus four new mutants: adding an `/i` flag to
  `PACKAGE_ALLOWLIST_PATTERN` (killed by the new nested-package
  case-sensitivity assertions), disabling the version-line content check
  (killed by the postinstall and `resolved` tests), treating a missing
  `patch` as pure (killed by the missing-patch test), and treating status
  `renamed` as pure (killed by the rename test); all six restored,
  verified by hash. `.github/workflows/ci.yml`'s smoke-check step
  classified only the empty list before, which cannot discriminate a
  broken classifier from a working one (`pure_release: false` is also
  what an always-false stub prints); it now pipes a known-pure file list
  through the CLI and asserts `pure_release` reads back true, replayed
  locally under `bash --noprofile --norc -eo pipefail` with both a pure
  and a not-pure input. CONTRIBUTING.md and
  `docs/testing/merge-approval-rollout.md` reworded "a single package's"
  to "any number of packages'" (the code never capped package count) and
  now describe the status and content checks; CONTRIBUTING's PR-creation
  paragraph dropped the batch date and the internal MCP tool name,
  keeping the App-token rule and the 403 troubleshooting hint.
  `merge-approval-gate-mechanics.md` documents the three-part pure check,
  the pagination-mismatch guard, and one added trust-boundary sentence:
  the classifier and the workflow both come from the PR ref on
  `pull_request` events, so the exception is a discipline mechanism, not
  an integrity boundary. `grounding-stack-overview.md` and
  `evidence-ledger-session-key-shapes.md` were re-verified against the
  current `merge-approval.yml`/`package.json` and re-stamped; no content
  drift found beyond the line-number shift the new step introduced,
  re-pointed the same way as round 1 (citations above; `merge-approval.yml`
  citations in `evidence-ledger-session-key-shapes.md` moved 89→117 and
  87→115). This entry's own predecessor's "15 cases"/"15/15 green" wording
  was replaced with delta language, since totals rot as more tests are
  added; this entry states deltas only. `okf-kit check --require-anchors`
  against this bundle: unchanged from the round-1 measurement, 2 warnings,
  both pre-existing `citations-resolve` findings against `log.md` (a
  reserved, append-only doc excluded from the anchor-guard job's blocking
  selectors), 0 `sources-fresh`. No package version was bumped and no live
  release PR was opened by this task; that remains open (see this task's
  own tracking).

- 2026-09-07T05:45:00Z, merge-approval pure-release exception (task
  `4493b316`): added `scripts/release-exception.js`, a dependency-free
  classifier that turns a PR's real changed-file list into a
  `{ pure_release, allowed, rejected }` verdict, and wired it into
  `.github/workflows/merge-approval.yml` as a new `Determine release
  exception from the PR's real changed files` step
  (`merge-approval.yml:46-73#"core.setOutput('pure_release', verdict.pure_release.toString());"`)
  between the label-extraction step and the pinned gate action. Each of
  the five action inputs is now `<label == 'true'> || <pure_release ==
  'true'>` (`merge-approval.yml:91-95#"evidence-logged: ${{ steps.labels.outputs.evidence_logged == 'true' || steps.release_exception.outputs.pure_release == 'true' }}"`),
  so a pure version-bump PR (root `package.json` / `package-lock.json` /
  `CHANGELOG.md`, or a single package's `packages/<name>/package.json` /
  `CHANGELOG.md`) satisfies the gate without a `review:*` label round; the
  five prerequisites, the pinned action SHA, the job/check name, and the
  triggers are unchanged. Inserting the new step ahead of the gate action
  shifted the action-pin and `task-id` line numbers this same doc and
  `docs/okf/evidence-ledger-session-key-shapes.md` cite
  (47→87, 49→89); both re-stamped in this commit, sibling lines checked
  against the current file. New unit tests
  (`scripts/release-exception.test.js`, `node --test`) use the
  real changed-file lists of PR #190 (understanding-gate 0.5.0: 3 files,
  pure) and PR #215 (grounding-mcp 0.11.0: 9 files including
  `packages/grounding-mcp/src/server.ts` and five `docs/okf/*.md`
  re-stamps, not pure (the source file and all five docs land in
  `rejected`)), captured read-only via `gh pr view <n> --repo
  LanNguyenSi/agent-grounding --json files`; plus the negative-control
  shape (an otherwise-pure list plus one `.ts` file, not pure), a nested
  `packages/a/b/package.json` (not pure), the workflow file alone (not
  pure), the empty list (not pure), a `..`-traversal path and a
  leading-`/` path (both rejected, not pure), and the CLI's argv/stdin
  input paths including malformed-stdin exit codes. Mutation probes via
  `agent-primitives probe --plan`, each on the test command `node --test
  scripts/release-exception.test.js`: (1) widening
  `PACKAGE_ALLOWLIST_PATTERN` to accept any `packages/*` path, killed
  (the PR #215 and nested-path tests both catch it, since
  `packages/grounding-mcp/src/server.ts` then reads as allowed); (2)
  making the empty-list branch `pure_release: files.length >= 0`,
  killed (the empty-list test catches it); both restored, verified by
  hash. (3) The workflow's five-input OR-to-AND swap has no automated
  test in this repo: manually flipped one `||` to `&&` in
  `merge-approval.yml` and reran the full `node --test
  scripts/release-exception.test.js` suite (still green,
  confirming no repo test reacts to a workflow-level operator change),
  then restored the file byte-identical; left as an explicit residual
  for the orchestrator's live release-PR probe (criterion 3's negative
  control at the workflow level), not claimed as covered here. CONTRIBUTING.md's
  "Cutting a release" section documents both the label-free path and its
  disqualifiers (a source version constant or a `docs/okf/*.md`
  re-stamp riding along with the bump disqualifies a release PR from the
  exception on that file alone), plus the separate, pre-existing finding
  that the App-token PR-creation path does not work on this repo and
  which credential to use instead. No package version was bumped and no
  live release PR was opened by this task; that remains open (see this
  task's own tracking).

- 2026-09-06T21:11:51Z, review-round polish, round 2 (task `3846b4d5`):
  fixes from the reviewer's first pass over the round-1 diff below,
  packages/grounding-mcp only. Extracted `compactUnderLock`'s inline temp-file
  template into an exported `compactionTempPathForKey(key, pid, nowMs)`, now
  called by both `compactUnderLock` and the NAME_MAX basename test, so the
  test's longest-candidate basename comes from the SAME production code
  rather than a second, independently-maintained copy of the template (the
  round-1 test had reimplemented it). Fixed the basename assertion from
  `toBeLessThan(NAME_MAX)` to `toBeLessThanOrEqual(NAME_MAX)`: 255 bytes is
  itself a legal basename length on this filesystem (measured: 255 succeeds,
  256 raises ENAMETOOLONG), so `< NAME_MAX` was one byte stricter than the
  real limit. Re-measured the constant's own failure boundary under the
  corrected `<=` form with `agent-primitives probe`: `MAX_ID_FILENAME_LENGTH`
  at 207 passes (248+7=255 bytes at the true worst-case digit counts is the
  binding basename), at 208 fails (256 bytes); the round-1 entry below had
  measured 206/207 under the stricter `<` form, one lower, which is exactly
  the shift the `<=` fix produces. Added a comment above
  `resolveForLookup`'s own `this.pruneOwned()` call explaining why running it
  before `release()` is safe there (the release sits in that same try's own
  `finally`, unlike the ordering hazard `execute()`'s own comment guards
  against). Recorded the `MAX_LOOKUP_ID_LENGTH` rename and the
  `InvalidVerdictIdError` sentinel export from round 1 in
  `CHANGELOG.md`'s `[Unreleased]` section (neither had a changelog line yet).
  Design doc section 6's write-side re-read sentence now names the specific
  outside-the-ordinary-path case precisely: "(`compromised`, section 7,
  including the starvation residual described later in the document, where
  the lock is already gone before this process's own heartbeat reports it)",
  replacing the bare "(`compromised`, section 7)" a reader could otherwise
  read as the flag alone rather than the specific residual bullet under
  "Concurrency" / "Residuals". Corrected this file's own round-1 entry below:
  it claimed "two citations" into the pre-shift `solution-verdict.ts` range
  where there is exactly one (the `2026-09-06T06:20:23Z` entry's own
  `solution-verdict.ts:746-803#"const markerPath = writeVerdict(verdict);"`
  citation); fixed the count and the surrounding singular/plural wording in
  place, since that entry is this branch's own unmerged commit, not shared
  history yet. Mutation probes (`agent-primitives probe`, worktree
  isolation): inverting `execute()`'s finally release/prune order still
  kills the release-before-prune ordering test (replay of round 1's probe);
  raising `MAX_ID_FILENAME_LENGTH` to 208 (the new failure boundary under
  `<=`) still kills the NAME_MAX test, and 207 (boundary minus one) passes
  as expected (replay of round 1's probe, boundary shifted by one per the
  `<=` fix above); appending 8 characters to `compactionTempPathForKey`'s
  own `.compact-` suffix kills the NAME_MAX test (new probe: the coupling
  the medium finding asked for). Appending exactly 1 character to that same
  suffix does NOT kill it (249 of 255 bytes, still 6 bytes under the limit
  at the production constant's own 7-byte headroom): reported honestly as a
  discriminating-probe caveat rather than claimed as a kill, since the
  brief's own "for example append one character" wording undersells how
  much headroom `MAX_ID_FILENAME_LENGTH`'s docstring already reserves.
  `solution-acceptance-verdict-contract.md` declares
  `solution-attempt-log.ts` as a source with no line-anchored citation into
  it (a bare `sources:` entry and one prose mention with no line number), so
  the helper extraction needed only this doc's own `timestamp:` re-stamp,
  not a citation re-pin; re-stamped to this commit's own real UTC instant.
  No other doc in this bundle cites `solution-attempt-log.ts`. Package
  checks in packages/grounding-mcp: `npm run build`, `typecheck`, `lint`,
  `test` (465 passed), and `test:ci` (coverage gate) all green. Root checks:
  `check:pins`, `check:deps`, `check:lockfile-integrity`, and
  `check:okf-test-citation-shape` all green (`check:okf-kit-pin` out of
  scope, unchanged by this round).

- 2026-09-06T20:51:25Z, review-round polish (task `3846b4d5`): five
  independent low findings from PR #214's review rounds, packages/grounding-mcp
  only. Design doc section 6 corrected: the write-side re-read before a
  `terminal` record write runs while the ORDINARY path still holds the id's
  lock (`execute`'s own release happens later, in its `finally`), never after
  release as the doc previously claimed; both mentions in that section fixed
  to name the real ordering, verified against `solution-attempt-log.ts` at
  HEAD. Added a deterministic test for the release-before-prune ordering in
  that same `finally` (spies on `pruneOwned` to sample whether the lock is
  already free at the instant it runs) and a test computing every basename
  the module derives from a maximal-length id (attempt log, lock anchor,
  proper-lockfile's own lock directory, verdict marker, compaction temp
  file) against NAME_MAX, pinning the compaction temp file as the longest
  one per the bound constant's own docstring; both verified with
  `agent-primitives probe` against a real mutant (inverted release/prune
  order; the constant raised to the exact byte where the computed basename
  reaches NAME_MAX), each killing its test, then restored and byte-verified.
  Renamed `MAX_LOOKUP_ID_LENGTH` to `MAX_ID_FILENAME_LENGTH` (it bounds an id
  as it becomes a file name, not a lookup key): `server.ts`'s three `.max()`
  schema sites and the comment above them, `solution-attempt-log.ts`'s
  definition and docblock, every referencing test, and this doc's sibling
  `solution-acceptance-verdict-contract.md`'s own args-sentence mention.
  CHANGELOG.md's 0.11.0 entry and this file's own 2026-09-06T09:15:00Z entry
  above keep the old name on purpose: they describe what shipped under that
  name at the time, not the current source. `agent-primitives drift` over
  the rename reported the one removed declaration and every prose mention of
  it in this file as allowlisted (CHANGELOG's released section automatically,
  this file's own mentions via an explicit `--allow` glob matching this
  file's own established convention above of leaving historical citations
  exactly as written): clean otherwise. Exported `InvalidVerdictIdError` from
  `solution-verdict.ts` as a sentinel for `sanitizeVerdictId`'s rejection,
  scoped to that sanitizer alone, not its mirrors `sanitizeSessionId`
  (session-store.ts) or `sanitizeHypothesisSessionId` (hypothesis-store.ts),
  each of which throws its own distinct message naming its own kind of id;
  `SolutionAttemptRegistry.lookup`'s own catch classification now matches
  `instanceof InvalidVerdictIdError` instead of the message string, and one
  `solution-verdict.test.ts` case now asserts `toThrow(InvalidVerdictIdError)`
  instead of a bare `toThrow()`. That same change inserted the new class and
  its docblock ahead of `sanitizeVerdictId`, shifting every later line in
  `solution-verdict.ts` uniformly for the rest of the file; every citation
  into that file in `solution-acceptance-verdict-contract.md` was re-derived
  individually against the file at HEAD and re-pinned, from the sanitizer
  helpers' own citations through the whole `evaluateSolution`/
  `owBlockersFor` producer section down to the final marker write. This
  file's own one citation into the same pre-shift range (the entry
  documenting the original attempt-lifecycle PR, above) is left exactly as
  written, per this file's own established convention for historical
  entries: it describes what was true at its own commit, not now.
  `server.ts` itself gained no net line shift from the rename (a pure
  same-line identifier swap at each site), so neither
  `evidence-ledger-session-key-shapes.md` nor
  `hypothesis-tracker-persistence-split.md` needed any citation re-pin, only
  the re-stamp below, since both declare `server.ts` as a source and it
  changed. Package checks in packages/grounding-mcp: `npm run build`,
  `typecheck`, `lint`, `test`, and `test:ci` (coverage gate) all green.
  Root checks: `check:pins`, `check:deps`, `check:lockfile-integrity`, and
  `check:okf-test-citation-shape` all green (`check:okf-kit-pin` out of
  scope, untouched by this round). Bundle check with the source-built
  okf-kit CLI, `check --require-anchors --json docs/okf` (this repo's own
  `ci.yml` invocation, repo root): clean on citations-resolve and errors
  (the anchor-guard job's own blocking selectors); this file's one
  citations-resolve finding above stays non-blocking there, matching its
  carve-out. The two pre-existing `sources-fresh` warnings on
  `claim-gate-vs-review-claim-gate.md` and `merge-approval-gate-mechanics.md`
  are another branch's concern and untouched here; `sources-fresh` itself
  stays out of scope for the anchor-guard job by design (see that job's own
  header comment) and is watched instead, warn-only, by `okf-staleness.yml`.

- 2026-09-06T20:26:39Z, sources-fresh re-verification (task 7c21ca25):
  `claim-gate-vs-review-claim-gate.md` was flagged STALE against
  `packages/review-claim-gate/package.json:3#"version": "0.1.6"` (bumped
  by PR #207, review-claim-gate 0.1.5 to 0.1.6); the doc's Publish status
  section, `claim-gate-vs-review-claim-gate.md:132#"@lannguyensi/review-claim-gate"`,
  already names 0.1.6, so no content changed, only the stamp.
  `merge-approval-gate-mechanics.md` was flagged STALE against
  `.github/workflows/merge-approval.yml:47#"review-claim-gate-v0.1.6"` and
  `packages/review-claim-gate/action/action.yml:54#"uses: actions/setup-node@v5"`
  (PR #207's Node-24 action-runtime bump and PR #208's matching SHA
  re-pin); the doc's own quote at
  `merge-approval-gate-mechanics.md:28#"uses: LanNguyenSi/agent-grounding/packages/review-claim-gate/action@cd3971866e48050514bfa5056bcb7e1d79615bd7"`
  already cites the post-bump SHA and tag, and the doc makes no claim
  about action.yml's Node or action-runtime versions, so no content
  changed there either. Re-checked every full citation in both docs
  against HEAD (`packages/claim-gate/src/lib.ts` and `src/cli.ts`,
  `packages/review-claim-gate/src/lib.ts` and `src/cli.ts` for the first
  doc; `packages/review-claim-gate/README.md`,
  `.github/workflows/merge-approval.yml`, and
  `docs/testing/merge-approval-rollout.md` for the second): all resolved
  at their cited lines, no anchors moved. `node
  agent-dx/packages/okf-kit/dist/cli.js check --require-anchors --json
  docs/okf` reported no `sources-fresh` finding on either doc after the
  re-stamp.

- 2026-09-06T13:01:19Z, grounding-mcp 0.11.0 release preparation: moved the
  unchanged grounding-mcp Unreleased notes (the attempt lifecycle plus
  `solution_evaluate_status`/`solution_evaluate_result`, the per-id attempt
  log, and the progress notifications from PR #212) into the dated 0.11.0
  release block and updated the package manifest, lockfile, and server
  `PACKAGE_VERSION`. Re-pointed the solution-acceptance consumer's version
  anchor to 0.11.0 and the release-topology overview's package-version claim;
  re-verified and re-stamped the two bundle docs that cite `server.ts` without
  a version claim (their line citations were unaffected, the version bump is
  a single-line, same-length edit).

- 2026-09-06T09:15:00Z, `solution_evaluate` attempt lifecycle, review round 4 (task
  `431a8e27`): docs-only delta on the accept_with_notes findings from round 3, no
  change under `src/` or `tests/`. Two overstatements corrected: the round-3 entry
  below said "both tests in that describe exec that build artifact" for a describe
  holding one `it`, now "the test in that describe"; `packages/grounding-mcp/CHANGELOG.md`'s
  `pruneOwned` bullet said the sweep runs "at the tail of every `solution_evaluate`
  call's own acquisition", now "at the tail of every uncompromised acquisition", since
  `execute()` only calls it inside `if (compromise.error === null)`.

  This log's own historical entries had drifted into a form the bundle's own
  convention forbids: a bare `path:N-M#"anchor"` token stands for the anchor's
  location NOW, never for a past line number, and a citation that does not resolve
  against the current file is not an allowed way to record history. The round-1 entry
  below (11 citations) and the round-2 entry below (2 citations) had 13 such tokens
  whose `server.ts` line numbers were left at their round-2-era values after round 3's
  own +11 shift moved every citation at and after the `solution_evaluate` registration;
  all 13 are re-pointed here to the lines that registration and the tools below it sit
  at now, each checked to still resolve verbatim. The one token this same round-3 entry
  introduced for a line it explicitly called "round 2's line" (server.ts line 368,
  where `solution_evaluate` was registered as of round 2, no longer that tool's line
  today) is reworded to prose naming the round instead of carrying an anchor token.

  Verification: a script walked every `path:N(-M)?#"anchor"` token in this file and
  confirmed the anchor text is present verbatim in the addressed line range of the
  file at HEAD; zero mismatches across every token in this file, server.ts-addressed
  or not. `npx okf-kit@0.9.0 check docs/okf --require-anchors`, run from the
  repository root against the committed tree, is clean (0 errors, 0 warnings, 0
  notices).

- 2026-09-06T08:37:00Z, `solution_evaluate` attempt lifecycle, review round 3 (task
  `431a8e27`): bounded-delta fix round on accept_with_notes findings from round 2 (one
  medium, four low). `MAX_LOOKUP_ID_LENGTH` now bounds `solution_evaluate`'s own `id`
  schema too, not only the two lookups' (`server.ts`, `.max(MAX_LOOKUP_ID_LENGTH)` added
  next to the existing `.min(1)`), and `SolutionAttemptRegistry.evaluate()` enforces the
  identical bound again at the registry's own entry point, returning the ordinary
  `{status:"failed", error}` payload before any filesystem call, so a library caller
  that bypasses the MCP schema cannot reach the sanitizer, the lock, or the log with an
  id that would overrun the filesystem name limit. The constant's own docstring is
  re-derived candidate by candidate against `NAME_MAX` (255 bytes) rather than restating
  the earlier approximate number: the binding case is the compaction temp file, 48 bytes
  past the key (generous 10-digit `pid` headroom over Linux's own 7-digit `pid_max`
  ceiling, plus a 13-digit `Date.now()`, true until the year 2286), not the lock
  directory `proper-lockfile` creates beside the anchor (18 bytes past the key). README
  and CHANGELOG corrected the same false claim ("`solution_evaluate` keeps its unbounded
  schema... an over-long id already comes back from it as failed"), which was never true
  once an id passed the lookups' bound but exceeded the filesystem's.

  Two smaller risk points, same module: `execute()`'s `finally` used to run the
  process-local `pruneOwned()` BEFORE releasing the id lock, so an unexpected throw
  there would have skipped the release entirely and leaked the lock for up to the stale
  window; `pruneOwned()` now runs after the release, so the same failure can cost only
  the retention convenience. `lookup()`'s catch was a single undiscriminated branch
  (any thrown error, `EACCES`/`ENOSPC`/`EMFILE` against `verdictDir()` included, became
  `{status:"unknown"}` with the raw exception message, which can interpolate
  `verdictDir()`'s own filesystem path); it is now split, keeping the broad catch (every
  thrown error still resolves to `unknown`, never an isError envelope) but classifying
  by the error itself: the sanitizer's own error keeps today's exact message, any other
  error is routed through `warnSwallowed` and answered with a fixed, path-free message.

  Tests: `grounding-gate-mcp-roundtrip.test.ts`'s id-band test now covers
  `solution_evaluate` itself (accepted at the bound and round-tripped through both
  lookups afterwards, schema-rejected one over it), not only the two lookups.
  `solution-attempt-lifecycle.test.ts` gained two new describes, `id length bound on
  solution_evaluate` (the registry's own `evaluate()` rejects one over the bound with
  no preflight invocation and nothing written under `verdictDir()`, accepts one exactly
  at the bound) and `lookup() catch classification` (a forced `EACCES` on the lock
  anchor, via a `chmod 0o555` verdict dir restored in a `finally`, same pattern already
  used in `solution-verdict.test.ts`, resolves to `unknown` with the fixed message and
  is reported through `warnSwallowed`, asserted against a `console.error` spy), and the
  two-process describe now drains child stderr into a buffer instead of leaving it
  unread on the pipe, gives `send()` a 20s timeout that rejects naming the method and
  including that buffered stderr instead of hanging forever on a wedged child, tracks
  and kills every spawned child in an `afterEach` backstop in addition to the test's own
  `finally`, and asserts in a describe-level `beforeEach` that `dist/server.js` exists
  and is not older than `src/server.ts`, naming `npm run build` in the failure message,
  since the test in that describe execs that build artifact directly.

  Citation impact, re-verified individually against the actual diff rather than by a
  blanket offset: the `server.ts` edit (a new comment block before the
  `solution_evaluate` registration, plus widening its `id` schema to four lines, minus
  one line off the now-redundant sentence in the lookups' own comment) shifted every
  citation at or after line 368 as the file stood after round 2 (the
  `solution_evaluate` registration's line at that point) by +11, uniformly, all the
  way to the end of the file: re-pointed to
  `packages/grounding-mcp/src/server.ts:376#"'solution_evaluate'"` and
  `packages/grounding-mcp/src/server.ts:451#"'solution_gate'"` in
  `solution-acceptance-verdict-contract.md`, and to
  `packages/grounding-mcp/src/server.ts:496#"'hypothesis_record',"`,
  `packages/grounding-mcp/src/server.ts:510#"saveStore(sessionId, store);"`,
  `packages/grounding-mcp/src/server.ts:516#"'hypothesis_list',"`,
  `packages/grounding-mcp/src/server.ts:539#"'hypothesis_evidence',"`,
  `packages/grounding-mcp/src/server.ts:556#"saveStore(sessionId, store);"`,
  `packages/grounding-mcp/src/server.ts:562#"'hypothesis_check_done',"`,
  `packages/grounding-mcp/src/server.ts:588#"saveStore(sessionId, store);"`,
  `packages/grounding-mcp/src/server.ts:594#"'hypothesis_reject',"`,
  `packages/grounding-mcp/src/server.ts:610#"saveStore(sessionId, store);"`,
  `packages/grounding-mcp/src/server.ts:616#"'hypothesis_support',"`,
  `packages/grounding-mcp/src/server.ts:632#"error: 'hypothesis_not_found_rejected_or_checks_pending',"`,
  `packages/grounding-mcp/src/server.ts:637#"saveStore(sessionId, store);"` and
  `packages/grounding-mcp/src/server.ts:643#"'hypothesis_reset',"` in
  `hypothesis-tracker-persistence-split.md`. `evidence-ledger-session-key-shapes.md`'s
  own citations sit entirely before line 368 (`server.ts:241`, `server.ts:248-253/254`)
  and did not move, but the file is re-stamped anyway: it declares `server.ts` as a
  source, and that file changed. Every quoted anchor text is unchanged and still
  resolves verbatim at its new line; none of the re-pointed docs' `sources:` lists
  changed. `solution-acceptance-verdict-contract.md`'s `solution_evaluate` args
  sentence also gained the new bound (`max 200, MAX_LOOKUP_ID_LENGTH, the same bound
  the two lookups below enforce`), a prose correction tied to the fix, not a citation
  move. `log.md`'s own historical citations at these same pre-round-3 line numbers
  (this entry and the one below it) are left exactly as written: this file is
  reserved/append-only history, excluded from citations-resolve's blocking selectors by
  the CI job's own carve-out, and describes what was true at ITS commit, not now.

  Re-stamp ancestry: the three docs above are re-stamped in this FINAL, docs-only
  commit, made after every source-touching commit of this round. The last such commit
  is `5cf48929d77f196f8a79ea312fa4fde669a7de86` (test commit, committer time
  2026-09-06T08:33:13Z); the preceding fix commit is
  `2da953dc121be3f5c55c867aa798eac8c17dc0c3` (2026-09-06T08:33:02Z). The three docs'
  `timestamp:` values are set to 2026-09-06T08:37:00Z, later than both, and this same
  commit is the one that changes each doc's stamp value.

  Verification, on the committed tree: `npx okf-kit@0.9.0 check docs/okf
  --require-anchors` clean on the three re-stamped docs (only `log.md`'s own reserved,
  non-blocking historical citations warn, per the carve-out above); a build of
  okf-kit from `agent-dx` master (commit `08cfc07`, `packages/okf-kit`, `npm ci && npm
  run build`) run as `node <build>/dist/cli.js check docs/okf --strict --json` reports
  no `sources-fresh` or `sources-fresh-future` finding on the three re-stamped docs (the
  pre-existing warnings on the two untouched docs from round 2 are unchanged, and remain
  follow-ups, not this round's responsibility). In `packages/grounding-mcp`,
  `agent-primitives verify -c build,typecheck,lint,test -x 'test=npm run test:ci'`
  passes with 463 tests (was 460) and the configured coverage thresholds met, and the
  lifecycle test file passes three consecutive runs with no flake and no orphaned
  `server.js` process left behind afterward. Root `npm run build`, `npm run typecheck
  --workspaces --if-present`, `npm run test --workspaces --if-present` and `npm run
  test:ci --workspaces --if-present` all pass, with the same per-workspace test counts
  as round 2 except grounding-mcp's own (463, was 460). All six `check:*` scripts at
  the repo root pass.

- 2026-09-06T07:35:00Z, `solution_evaluate` attempt lifecycle, review round 2 (task
  `431a8e27`): fix round on the entry below. `pruneOwned()` gained the two
  production call sites it never had, beside the `compactUnderLock` it shares a
  retention window with (the tail of `execute`'s successful acquisition, and
  `resolveForLookup`'s acquisition branch). The two read-only lookups now bound
  `id` at `MAX_LOOKUP_ID_LENGTH` and answer a still-unusable id with
  `{status:"unknown", id, error}` instead of letting the sanitizer's throw or an
  `ENAMETOOLONG` reach the caller as an MCP error envelope. `createServer`'s
  option type stopped intersecting `AttemptRegistryOptions`, which had published
  a second, undocumented spelling of every attempt knob. Tests were added for
  the terminal write order, the retention clamp at the point where it binds, the
  two prune call sites, a real two-process race, and the `expired` half of "only
  an acquisition licenses a new attempt". Two doc comments were corrected: the
  module header's rule 3 and `appendTerminal` both claimed the writer no longer
  holds the id's lock when it performs the write-side re-read, which on the
  ordinary path is false (`execute` releases in its `finally`, after the
  append). `Verdict`, `writeVerdict`'s signed shape, `verdictPath`,
  `evaluateGate` and `solution_gate` are unchanged again this round.

  Citation impact, re-verified individually rather than by a blanket offset: the
  `server.ts` edits (the import swap, the spelled-out `createServer` option
  type, the comment above the two lookup registrations, and the two widened `id`
  schemas) shifted the citations below them by +9 as far as
  `packages/grounding-mcp/src/server.ts:376#"'solution_evaluate'"`, and by +23
  from `packages/grounding-mcp/src/server.ts:451#"'solution_gate'"` onward. The
  new README paragraph shifted
  `packages/grounding-mcp/README.md:214#"the root cause is the backend container's missing OPENAI_API_KEY env var"`
  by +2, and the one new import in the roundtrip test shifted
  `packages/grounding-mcp/tests/grounding-gate-mcp-roundtrip.test.ts:671-685#"blockers).toContain('test: 2 failing')"`
  by +1. 31 citations were re-pointed across
  `evidence-ledger-session-key-shapes.md`,
  `hypothesis-tracker-persistence-split.md`,
  `solution-acceptance-verdict-contract.md` and this log, each cited line mapped
  through that file's own diff individually rather than by adding one offset,
  and every quoted anchor text is unchanged and still resolves verbatim at its
  new line.

  Bare continuation tokens were re-pointed AND lifted into the anchored form,
  not merely re-pointed. The `saveStore` sentence in
  `hypothesis-tracker-persistence-split.md` carried one anchored citation
  followed by four bare `:N` continuations, all four still pointing at
  pre-change lines; they are now five separately anchored citations, one per
  call site. The `loadStoreFromDisk at :132` back-reference later in the same
  doc was lifted as well, although its target file did not shift this round, so
  the doc now follows one convention throughout. A grep of the bundle for bare
  `:N` and `,N-M` continuation tokens found no others outside this log; the one
  unanchored reference that remained, a frozen line range into
  `grounding-gate-mcp-roundtrip.test.ts` inside an earlier entry below, was
  reworded to name that span's current anchored citation instead of numbers that
  had stopped resolving to the block the sentence describes (they are written
  out here without their line numbers on purpose, so this entry does not
  reintroduce the same unanchored citation it is describing).

  Re-stamp ancestry, which the entry below got wrong: the three docs are
  re-stamped in a FINAL, docs-only commit made after every source-touching
  commit of this round, and their `timestamp:` values are later than the
  committer time of the last of those (`76a82f2e`, 2026-09-06T07:34:38Z). Each
  doc's own last commit is therefore later than the last commit of every source
  it declares, and that same commit is the one that changed its stamp value. The
  round-1 entry below claimed the docs had been "re-stamped past it in that same
  commit" while the stamp they carried, 2026-09-06T06:20:23Z, was four seconds
  EARLIER than `aa3239c6`, the last commit touching the declared source
  `packages/grounding-mcp/src/solution-attempt-log.ts`.

  Verification, on the committed tree: `npx okf-kit@0.9.0 check docs/okf
  --require-anchors` clean, 0 findings; `npm run check:okf-test-citation-shape`,
  `npm run check:okf-selectors`, `npm run check:okf-kit-pin`, `npm run
  check:pins`, `npm run check:deps` and `npm run check:lockfile-integrity` all
  pass. In `packages/grounding-mcp`, `agent-primitives verify -c
  build,typecheck,lint,test -x 'test=npm run test:ci'` passes with 460 tests and
  the configured coverage thresholds met, and the lifecycle test file passes
  five consecutive runs with no flake. Root `npm run build`, `npm run typecheck
  --workspaces --if-present` and `npm run test --workspaces --if-present` all
  pass.

- 2026-09-06T06:20:23Z, `solution_evaluate` attempt lifecycle (task `431a8e27`): added
  `src/solution-attempt-log.ts` (bounded wait plus running handle, per-sanitized-id
  append-only attempt log, `proper-lockfile` mutual exclusion, startup and read-path
  reconciliation), registered `solution_evaluate_status` and
  `solution_evaluate_result` in `server.ts`, and extended `evaluateSolution` in
  `solution-verdict.ts` with one optional `preWriteGuard` read immediately before
  `writeVerdict`. `Verdict`, `writeVerdict`'s signed shape, `verdictPath`,
  `evaluateGate` and `solution_gate` are unchanged, and every pre-existing test in
  `tests/solution-verdict.test.ts` and `tests/grounding-gate-mcp-roundtrip.test.ts`
  passes unmodified.

  Citation impact, re-verified individually rather than by a blanket offset: the
  `server.ts` edits (one import block, the registry construction inside
  `createServer`, the extended `solution_evaluate` handler, the two new
  registrations, and the reconciliation call in `main()`) shifted every citation
  below them, by +5 at `PACKAGE_VERSION` (the version literal was `'0.10.0'` at
  the time of this entry, now `'0.11.0'`)
  (`packages/grounding-mcp/src/server.ts:55#"PACKAGE_VERSION = '0.11.0'"`), by +26
  through the `ledger_add` handler
  (`packages/grounding-mcp/src/server.ts:241#"Session id"`,
  `packages/grounding-mcp/src/server.ts:248-254#"session: sessionId,"`), by +26 at
  the `solution_evaluate` registration
  (`packages/grounding-mcp/src/server.ts:376#"'solution_evaluate'"`), and by +63
  from `solution_gate` (`packages/grounding-mcp/src/server.ts:451#"'solution_gate'"`)
  through every `hypothesis_*` tool below it
  (`packages/grounding-mcp/src/server.ts:496#"'hypothesis_record',"`,
  `packages/grounding-mcp/src/server.ts:510#"saveStore(sessionId, store);"`,
  `packages/grounding-mcp/src/server.ts:516#"'hypothesis_list',"`,
  `packages/grounding-mcp/src/server.ts:539#"'hypothesis_evidence',"`,
  `packages/grounding-mcp/src/server.ts:562#"'hypothesis_check_done',"`,
  `packages/grounding-mcp/src/server.ts:594#"'hypothesis_reject',"`,
  `packages/grounding-mcp/src/server.ts:616#"'hypothesis_support',"`,
  `packages/grounding-mcp/src/server.ts:632#"error: 'hypothesis_not_found_rejected_or_checks_pending',"`,
  `packages/grounding-mcp/src/server.ts:643#"'hypothesis_reset',"`), since the two
  new tool registrations sit between those two anchors. The `preWriteGuard` block
  moved the marker-write anchor's range end only
  (`packages/grounding-mcp/src/solution-verdict.ts:746-803#"const markerPath = writeVerdict(verdict);"`),
  and the README additions (two catalog rows, two storage rows, the new
  "Attempt lifecycle: when to poll, and when to retry" section) shifted the
  collateral OPENAI_API_KEY citation
  (`packages/grounding-mcp/README.md:214#"the root cause is the backend container's missing OPENAI_API_KEY env var"`).
  Every quoted anchor text is unchanged and still resolves verbatim at its new
  pinned line.

  Prose corrected where a claim changed, not only line numbers:
  `solution-acceptance-verdict-contract.md`'s tool-surface section named two MCP
  tools and said `solution_evaluate` calls `evaluateSolution` directly; it now names
  four, records that the call goes through the attempt registry into the same
  unchanged `evaluateSolution`, states that `solution_gate` never consults the
  attempt log or the lock, and records that reaching `writeVerdict` now also
  requires the optional `preWriteGuard` not to veto. That doc's `sources:` gained
  `packages/grounding-mcp/src/solution-attempt-log.ts`. The other two affected docs
  (`evidence-ledger-session-key-shapes.md`,
  `hypothesis-tracker-persistence-split.md`) needed line numbers only: their claims
  about ledger session keys and hypothesis persistence are untouched by this change.

  Verification: `npx okf-kit@0.9.0 check docs/okf --require-anchors` run from the
  repository root against the committed tree; the same command run against a
  `git archive` export of the pre-change commit `536559e` (re-initialized as a git
  work tree, since staleness and citation resolution are skipped outside one)
  reported "clean, no findings", establishing that every finding this edit
  introduced was repaired rather than inherited. A second commit in the same
  task made the module report its two swallowed failure paths (a failed
  compaction, a failed lock release) on stderr instead of dropping them; it
  touched no citation target and no claim in any bundle doc, and the three docs
  above carry a timestamp re-stamped past it in that same commit.

- 2026-09-05T19:03:38Z, `solution_evaluate` progress notifications (task
  `8c9a99fc`): added `src/progress.ts` (`withProgressPings`) and wrapped
  `solution_evaluate`'s single preflight invocation in `server.ts` with it;
  no change to `solution-verdict.ts`, signing, gate, or verdict/marker
  shape. The edit shifted every citation into `server.ts` past the new
  import line and `createServer`'s `progressIntervalMs` setup (a uniform
  +3 through `ledger_add` and the start of `solution_evaluate`'s own
  registration, +7 from `solution_gate` through every `hypothesis_*` tool
  below it, since that handler's body itself grew by 4 lines); a
  README.md insertion (new "Progress notifications while `solution_evaluate`
  runs" section) shifted the collateral OPENAI_API_KEY citation, and two
  new import lines at the top of
  `tests/grounding-gate-mcp-roundtrip.test.ts` shifted the not-ready-preflight
  test citation. Re-pinned every affected citation individually in
  `evidence-ledger-session-key-shapes.md`, `hypothesis-tracker-persistence-split.md`,
  and `solution-acceptance-verdict-contract.md` (line numbers only; every
  quoted anchor text was unchanged and still resolves verbatim at its
  pinned line). `okf-kit check --json --require-anchors docs/okf` reported
  0 errors, 0 warnings, 0 notices against a clean pre-edit baseline run
  from the same commit (`eefd18f`), confirming the fixes account for every
  finding this edit introduced.

- 2026-09-04T05:43:29Z, grounding-mcp 0.10.0 release preparation (task
  `62c3865a`): moved the unchanged grounding-mcp Unreleased notes into the
  dated 0.10.0 release block and updated the package manifest, lockfile, and
  server `PACKAGE_VERSION`. Re-pointed the solution-acceptance consumer's
  version anchor to 0.10.0; re-verified and re-stamped every bundle doc that
  cites `server.ts`, plus the release-topology overview whose package-version
  claim changed. Verification commands and final committed-tree OKF results
  are recorded in the task's orchestrator run.

- 2026-09-02T08:36:59Z, task `6da2c230` round 4 (review of round 3):
  commit `10e4004` addressed the round-3 medium finding (two triple-backtick
  lines indented four or more spaces are not fences to the heuristic, so
  their backticks pair as an inline span around a marker attempt between
  them and exempt it) as a pinned, documented residual rather than a
  behaviour change: the docstring residual paragraph of
  `ow-run-completeness.ts` was rewritten within the same line count, so no
  citation moved (`okf-kit check` 0 errors with and without
  `--require-anchors`), and one test pins the case. The round-4 reviewer
  then found `solution-acceptance-verdict-contract.md` stale against that
  commit (measured before the commit, not after); timestamp-only re-stamp
  here, measured after this commit. Also earlier in round 3: one historical
  span citation in the round-2 entry of this log stated in prose (commit
  `f09c6bc`), which cleared the closing-brace warning it had started to
  raise.

- 2026-09-02T08:08:21Z, task `6da2c230` round 3 (run-base fail-closed phrase
  check, review round 2 fix-up): `solution-acceptance-verdict-contract.md`
  re-verified and re-pointed against `ow-run-completeness.ts` after the
  round-2 reviewer found the D-027 quotation exemption too loose in two
  ways. (1) the single-backtick inline-span pairing was whole-file and
  non-greedy, so a stray backtick could pair with another stray backtick
  many lines away across a blank-line paragraph break, accidentally
  exempting a real phrase-carrying line sitting between them; the span is
  now bounded at a paragraph break (never contains a blank line), still
  allowed to cross one or more consecutive non-blank lines, matching the
  one real corpus file (`2026-07-16-ow-kit-run-base-marker/00-goal.md`)
  that relies on a span opened on one line and closed on the next. (2) the
  fence detector toggled on any line starting with 3+ backticks or tildes
  regardless of character or run length, so an unclosed fence exempted
  everything to end of file and a tilde run inside a backtick fence closed
  it (or vice versa); a fence now closes only on a later line whose
  delimiter is the same character and at least as long as the opener's, an
  opener with no matching closer fences nothing (fails closed, not
  everything to EOF), and a blockquoted fence's `> ` prefix is not
  recognised as a fence at all. Nine new tests cover both fixes plus two
  pinned residuals (a fenced well-formed keyed marker is still selected as
  the binding, an intentional asymmetry since only the phrase net is
  quoting-aware; a purely quoted unkeyed marker as the only occurrence in
  the file is still resolved by the legacy substring matcher). Also closed:
  the module docstring, README, and this doc previously described the
  exemption as working "the same way rendered Markdown treats one", now
  corrected to describe the actual heuristic and to state the phrase-net
  versus keyed-net asymmetry explicitly; the corpus counts and the concrete
  pandora repo-name annotation example moved out of the module docstring,
  README, and this doc into `packages/grounding-mcp/CHANGELOG.md`
  `[Unreleased]`, replaced by a generic description and a one-sentence
  pointer. All `ow-run-completeness.ts` citation spans in this doc shifted
  again and were re-pointed one by one against the current source, each
  re-verified against its cited excerpt. Measured against the real corpus
  (every dated run directory under `~/git/pandora/.ai/runs/` and every
  nested `*/.ai/runs/`, 104 run directories total, via a synthetic
  `.ai/run`-pointer worktree so every run directory is read, not just each
  repo's active one): zero verdict changes against both the commit
  immediately before this round's fixes and the commit at the start of
  this task, before round 1; the one real corpus file relying on the
  cross-line inline span still resolves `complete: true` with no blocker
  reasons. Re-verified: `okf-kit check --json docs/okf` and `okf-kit check
  --json --require-anchors docs/okf` on the committed tree both 0 errors, 1
  pre-existing warning on a frozen historical citation further down this
  log file, an append-only line-number reference from an earlier anchor
  fix that now happens to land on a closing brace after this round's line
  shifts; unrelated to this round's source edits and left untouched; `npm
  run check:okf-test-citation-shape` and `npm run
  test:check-okf-test-citation-shape` both pass; root `npm run build
  --workspaces --if-present` then `npm test` exit 0, 1494 tests (1485 + 9
  new regression tests this round).

- 2026-09-02T07:29:00Z, task `6da2c230` round 2 (run-base fail-closed phrase
  check, review round 1 fix-up): `solution-acceptance-verdict-contract.md`
  re-verified and re-pointed against `ow-run-completeness.ts` after three
  round-1 review findings were closed there, measured against the real corpus
  of 94 run directories under pandora/harness/agent-grounding (before: 9 runs
  regressed `complete: true` to `complete: false`; after: zero regress). (1)
  The unkeyed-marker exemption from the phrase check now tracks what
  `matchMarker` actually reads a value from (line start + the comment opener
  through a non-whitespace value, whatever follows), not a whole-line-only
  shape, fixing an annotated-sha unkeyed marker and the pandora multi-repo
  convention line both resolving a value AND being reported malformed. (2)
  Orchestrator decision D-027 amends round 1's fence stance: a phrase
  occurrence entirely inside a single-backtick inline span or a fenced code
  block is now a quotation, exempt from the check (a second unquoted mention
  on the same line still blocks), fixing two real runs that only ever quoted
  the marker syntax in backticks. (3) a malformed line caught only by the
  phrase net (no keyed bracket syntax attempted) now gets a distinct reason
  instead of the misleading keyed-shape hint. All `ow-run-completeness.ts`
  citation spans in the doc shifted again (the module docstring's decision
  paragraph and the `collectKeyedRunBaseMarkers`/`malformedRunBaseReasons`
  functions both grew) and were re-pointed one by one against the current
  source, each re-verified against its cited excerpt; the `run-base` grammar
  paragraph and the top-level README paragraph were both rewritten to
  describe the code's actual current exemptions rather than the round-1
  ones. `solution-verdict.ts` citations were untouched (that file did not
  change). Re-verified: `okf-kit check --json docs/okf` and `okf-kit check
  --json --require-anchors docs/okf` on the committed tree both 0 errors / 0
  warnings; `npm run check:okf-test-citation-shape` and `npm run
  test:check-okf-test-citation-shape` both pass; root `npm run build
  --workspaces --if-present` then `npm test` exit 0, 1485 tests (1479 +
  6 new regression tests this round).

- 2026-09-02T06:42:12Z, task `6da2c230` (run-base fail-closed phrase check):
  `solution-acceptance-verdict-contract.md` re-verified and re-pointed
  against `ow-run-completeness.ts` after the reader gained a third,
  position-independent malformed check (`lineCarriesRunBasePhrase`): any
  line in `00-goal.md` naming both marker tokens (`solution-acceptance` and
  `run-base`) but not accepted as a well-formed keyed/unkeyed marker now
  blocks as `runBaseKind: 'malformed'`, closing the line-position residual
  (list bullet, prose, no comment wrapper, leading text) documented as
  fail-open by task 43a7ef58's review round 4. All 26 `ow-run-completeness.ts`
  citation spans in the doc shifted (the reader's header docstring and the
  `run-base` grammar section both grew) and were re-pointed one by one against
  the current source, each re-verified against its cited excerpt; the
  `run-base` grammar paragraph was rewritten with an explicit decision
  paragraph naming the new check and its rationale, plus two new citations
  (`UNKEYED_RUN_BASE_STRICT`, `lineCarriesRunBasePhrase`). `solution-verdict.ts`
  citations were untouched (that file did not change; the verdict layer needs
  no change since it already composes `readOwRunCompleteness`'s `reasons`/
  `complete` generically). Re-verified: `okf-kit check --json docs/okf` and
  `okf-kit check --json --require-anchors docs/okf` on the committed tree
  both 0 errors / 0 warnings; `npm run check:okf-test-citation-shape` and
  `npm run test:check-okf-test-citation-shape` both pass.

- 2026-09-02T05:43:25Z, task `44ee799a` (pin sweep, post-rebase): `merge-approval-gate-mechanics.md`
  went STALE against `.github/workflows/merge-approval.yml` after the
  Node-24 action bump landed on master (`actions/checkout` v4 to v5,
  `actions/github-script` v7 to v8, no line moved). Re-verified every
  cited span in the workflow (lines 4-11, 19-21, 31-44, 40-44, 47, 49,
  51-55: unchanged), corrected the one claim that named the old major
  (`actions/github-script@v7` is now `@v8`), and re-stamped.

- 2026-09-02, round-2 review fix-up for the 0.9.0 pin bump below (task
  44ee799a): reworded a fleet-count claim in
  `.github/workflows/okf-staleness.yml`'s branch-name comment and its
  continuation-shorthand summary line; fixed a mis-escaped
  continuation-shorthand notation (`:N`, `-M`, `(N)`) in this file and in
  `.github/workflows/ci.yml`; corrected a stale "two canonical" ->
  "three canonical" fixture-count comment in `ci.yml`; cleaned up two
  weak anchors in `evidence-ledger-session-key-shapes.md` (the
  trailing-space `policyDecisions: all.filter((e) => e.type === "` form
  replaced with the clean `policyDecisions: all.filter` spelling already
  used elsewhere in the same doc) and one weak anchor in
  `claim-gate-vs-review-claim-gate.md` (`} else {` replaced with
  `opts.evidenceLogged === true`, on the forced branch's actual
  condition rather than the following else-head). Re-verified: `okf-kit
  check --require-anchors --json docs/okf` on the committed tree still
  0 errors / 0 warnings / 0 notices; only the cited spans in the two
  touched docs were re-opened and confirmed for this sweep, not every
  prose paragraph. Also fixed the drifted-fixture regeneration procedure
  (`scripts/fixtures/okf-selectors/`): the fixture source file
  (previously `src/never-committed.ts`) had itself been committed by the
  0.9.0 bump below, which silently falsified its own name and would have
  broken the "untracked by git" notice on the next literal regeneration;
  renamed it to `src/fixture-source-2.ts` (a plain sequence number
  instead of a claim a future commit falsifies), regenerated
  `drifted-report.json` with the new file still uncommitted, and moved
  the rename requirement to the first line of the README's Regenerating
  section. Added a unit test asserting `drifted-report.json` carries
  exactly one `sources-fresh` notice, so a future in-place regeneration
  that silently loses it fails loud instead of shipping a stale fixture.

- 2026-09-02, okf-kit pin bump 0.8.0 -> 0.9.0 for fleet parity (task
  44ee799a): bumped both `.github/workflows/ci.yml`'s blocking
  `okf-anchor-guard` job and `.github/workflows/okf-staleness.yml`'s
  warn-only job to `okf-kit@0.9.0`. 0.9.0 adds the
  `anchor-required-continuation` rule (opt-in, `--require-anchors`): a
  continuation citation (`:N`, `-M`, `(N)`) chained to a full,
  in-repo-resolving citation cannot carry its own `#anchor`, and is now
  flagged rather than silently exempt. `npx -y okf-kit@0.9.0 check --json
  --require-anchors docs/okf` on the pre-bump tree: 0 errors, 24
  warnings, all `anchor-required-continuation`, 12 each in
  `claim-gate-vs-review-claim-gate.md` and
  `evidence-ledger-session-key-shapes.md` (plain `okf-kit check --json`,
  without `--require-anchors`: 0 findings both before and after -- this
  is purely the new opt-in rule). Every one of the 24 was lifted into its
  own full `path:N-M#anchor` citation after opening the cited span and
  confirming it still describes the code named (see the implementer
  report on task 44ee799a for the old -> new list); two were re-pointed
  rather than merely re-anchored where the original span's true last
  content line carried a `"` that the anchor grammar cannot embed
  (`review-claim-gate/src/cli.ts` runCheck precedence citation narrowed
  248-294 -> 248-290; `evidence-ledger/src/db.ts` `getSummary` citation's
  anchor landed on the same `policyDecisions: all.filter((e) => e.type
  === ` prefix rather than the full quoted arm), and one was corrected
  for drift (`review-claim-gate/README.md`'s "reviewer-template usage"
  parenthetical pointed at line 161, which is mid-sentence about
  `ledger hypothesis` logging, not the export bridge it was glossing --
  re-pointed to line 165, the actual `review-claim-gate export --task-id
  <TASK-ID> --from-session <GROUNDING-SESSION-ID>` line). Post-fix `npx
  -y okf-kit@0.9.0 check --json --require-anchors docs/okf`: 0 errors, 0
  warnings, 0 notices. The ci.yml "Citation guard" step's own commands
  (the `okf-kit check --require-anchors --json` invocation plus its five
  jq selectors and blocking `if`) were replayed by hand against the
  committed tree: prints "Clean: 0 errors, 0 citations-resolve warnings,
  0 unresolved-ambiguous citations (log.md excluded, see above)." and
  exits 0. `scripts/fixtures/okf-selectors/{clean,drifted,error}-report.json`
  regenerated against real `okf-kit@0.9.0` output per that directory's
  README.md; `clean-report.json` and `error-report.json` are
  byte-identical to their 0.8.0 versions (neither bundle exercises the
  new rule). `bundle-drifted/`'s one `sources:` entry
  (`src/untracked.ts`) was renamed to `src/never-committed.ts`: okf-kit's
  `sources-fresh` "untracked by git" notice is driven by `git log -1
  --format=%ct -- <path>` against commit history, not index state, so
  once `src/untracked.ts` had ever been committed (by an earlier
  regeneration), `git rm --cached` alone could no longer reproduce the
  notice under either 0.8.0 or 0.9.0 -- confirmed both ways before the
  rename. `fixture-version.json` bumped to `"0.9.0"`.
  `scripts/check-okf-selectors.test.js`'s M1 negative-control test
  (which mutates a ci.yml copy's pin to a version newer than the
  committed fixtures, expecting exit 1) had its hardcoded literals
  bumped from `0.8.0`/`0.9.0` to `0.9.0`/`0.9.1` in lockstep, since the
  real pin is now `0.9.0` and the test's own `assert.notEqual(...,
  'the okf-kit pin must actually be present to mutate')` guard fails
  otherwise; only the version-number literals changed, not the test's
  assertions or check-okf-selectors.js's validation logic.
  `npm run check:okf-kit-pin` / `test:check-okf-kit-pin` /
  `check:okf-selectors` / `test:check-okf-selectors` (25 pass) /
  `check:okf-test-citation-shape` / `test:check-okf-test-citation-shape`
  (16 pass): all exit 0 on the committed tree.

- 2026-08-30, `scripts/check-okf-selectors.js` review round 2 (task
  922857bf, fixes on top of the entry directly below): a reviewer pass on
  the round-1 change found seven findings, all applied here.
  Sources-fresh (HIGH): the round-1 diff edited `README.md` and
  `package.json`, both `sources:` of `docs/okf/grounding-stack-overview.md`,
  without re-stamping it; re-verified every claim that doc makes against
  both files (the README diagram citation, lines 13 through 49 with its "helpers --> el" anchor, and the
  `package.json` private/workspaces/`build:deps` claims all still hold --
  this round's README/package.json edits land well past the cited ranges),
  bumped its frontmatter `timestamp:` to `2026-08-30T09:15:00Z` (past this
  round's own commit), grepped every other `docs/okf/*.md` `sources:` list
  for ci.yml/README.md/package.json/scripts paths (none besides this one
  doc cite any file this branch touches). `npx -y okf-kit@0.8.0 check
  --require-anchors --json docs/okf` on the tree with the re-stamp: 0
  errors, 0 warnings, 0 notices (was 2 sources-fresh STALE warnings before
  the re-stamp). Fixture-version coupling (MEDIUM): added
  `scripts/fixtures/okf-selectors/fixture-version.json` (`"okfKitVersion":
  "0.8.0"`); `run()` now extracts ci.yml's own pin via
  `check-okf-kit-pin.js`'s exported `extractPins()` and fails loud on a
  mismatch, naming both versions and the fixtures README's "Regenerating"
  section. Blocking-verdict extraction (MEDIUM): `blockingCondition` is
  now a sixth extracted pattern (ci.yml's `if [ "${errors}" -gt 0 ] ||
  [ "${count}" -gt 0 ] || [ "${ambiguousCount}" -gt 0 ]; then` line) with
  one small `evaluateBlockingCondition()` evaluator shared by both the
  observed and expected verdict computation, replacing the previous
  hardcoded JS boolean. Errors-leg fixture (MEDIUM): added
  `bundle-error/`/`error-report.json` (a doc with no opening frontmatter
  delimiter -- real `okf-kit@0.8.0` output: one `frontmatter-required` /
  `error` finding, `.summary.errors: 1`, nothing else), the first fixture
  to exercise the `errors`-leg of the blocking verdict at a real positive
  value. Two LOW findings: a comment above ci.yml's `logFindings=$(jq
  ...)` block and above the "Install okf-kit (exact pin)" step now both
  point at `scripts/check-okf-selectors.js`/its fixtures on a pin bump;
  the `otherNotices` "untracked by git" `EXPECTED` entry now carries a
  comment plus a check-time hint pointing at the fixtures README's
  regeneration caveat. One more LOW finding: dropped the undocumented
  `process.argv[2]`/`OKF_SELECTORS_CI_YAML` CLI overrides entirely (`run()`
  keeps its own tested `rootDir`/`ciYamlOverridePath` parameters; `main()`
  now just calls `run()`). Added the missing tests the reviewer named:
  field-rename probes (`severity`->`level`, `file`->`path`), a
  message-suffix probe (`[anchor-required]`->`(anchor-required)`), and
  fail-closed probes for malformed fixture JSON, a non-numeric
  `.summary.errors`, and `jq` missing from `PATH`.
  `node --test scripts/check-okf-selectors.test.js`: 25 pass, 0 fail.
  `node scripts/check-okf-selectors.js` against the real ci.yml and all
  three committed fixtures: exit 0. Manual mutation probes: a temp ci.yml
  copy pinning `okf-kit@0.9.0` (fixtures left at `0.8.0`) -> exit 1 on the
  version mismatch; a temp ci.yml copy with the `ambiguousCount` leg
  dropped from the blocking line -> exit 1, `blockingCondition` reported
  missing; a working-tree edit narrowing `evaluateBlockingCondition` to
  drop the `errors` leg -> the `error-report.json` test went red
  (`error-report.json must make the guard block on the errors leg alone`),
  restored, re-run: 25 pass again. `npm run check:okf-kit-pin`,
  `test:check-okf-kit-pin`, `check:okf-test-citation-shape`,
  `test:check-okf-test-citation-shape`, `check:lockfile-integrity`,
  `test:check-lockfile-integrity`: all exit 0, unaffected by this round's
  changes.

- 2026-08-30, `scripts/check-okf-selectors.js` added (task 922857bf,
  follow-up to the 4a4af64b entry below): couples ci.yml's Citation guard
  step's five jq selectors (`logFindings`, `citationFindings`,
  `ambiguousFindings`, `otherNotices`, `errors`) to okf-kit's actual JSON
  finding shape, so a future okf-kit rename of `ruleId`/`severity`/`file`/
  the `[rule]` message suffix gets caught instead of the guard silently
  selecting 0 findings from a broken bundle. Fixtures under
  `scripts/fixtures/okf-selectors/` are real `okf-kit@0.8.0
  check --require-anchors --json` output (not hand-written): a clean
  bundle and a bundle with one finding per citations-resolve rule
  subtype, one unresolved-ambiguous notice, one citations-resolve warning
  filed against a reserved log.md, and one sources-fresh notice.
  `node --test scripts/check-okf-selectors.test.js`: 10 pass, 0 fail.
  `node scripts/check-okf-selectors.js` against the real, unmodified
  ci.yml and the committed fixtures: exit 0. Negative control run
  manually against a temp copy of ci.yml with `.severity == "warning"`
  narrowed to `.severity == "warnin"` on the `citationFindings` selector:
  exit 1, reporting `citationFindings` selected 0 of the 5 expected
  findings; the committed ci.yml was left untouched. A second manual
  probe renamed the `[anchor-required]` finding's `ruleId` in a temp copy
  of the drifted fixture: exit 1, naming `citationFindings` as short one
  expected match. Restored, re-run: exit 0 again.

- 2026-08-27, `scripts/check-okf-anchors.js` replaced by okf-kit@0.8.0's
  `--require-anchors` (task 4a4af64b): okf-kit's own `citations-resolve`
  gained four opt-in checks (`anchor-required`, `anchor-not-on-last-line`,
  `anchor-not-unique-in-range`, `test-range-straddles-block`) that cover
  rules (a)/(b)/(c) this repo used to enforce by hand; all four are
  reported under the existing `ruleId: "citations-resolve"`,
  `severity: "warning"` shape (message tagged e.g. `[anchor-required]`),
  so ci.yml's `okf-anchor-guard` job's existing blocking selector already
  catches them once `--require-anchors` is passed, no new jq logic
  needed. Verified against the committed bundle:
  `node scripts/check-okf-anchors.js` (pre-change): 171 full citations
  across 8 docs, 0 violations. `okf-kit check --require-anchors --json
  docs/okf` (post-change, dist build of the unreleased 0.8.0 CLI from
  agent-dx master): `{"errors":0,"warnings":0,"notices":0}` measured
  locally pre-commit (corrected below: this number was already wrong for
  the committed state, see the review-round-2 correction paragraph).
  Four negative controls, one per opt-in rule, run against a
  disposable fixture bundle (not this repo's real docs/okf/) with the
  same CLI: missing anchor -> `anchor-required` warning; anchor off the
  range's last content line -> `anchor-not-on-last-line`; anchor
  duplicated in-range -> `anchor-not-unique-in-range`; a `*.test.ts`
  citation's range straddling into a sibling block-head ->
  `test-range-straddles-block`; all four `citations-resolve`/`warning`,
  all reverted after.

  One rule has no okf-kit equivalent: `test-citation-shape` (a `*.test.ts`
  citation's range must start on the test's own `describe(`/`it(`/`test(`
  head and end on that test's own closing `});`, not just avoid
  straddling into a sibling/outer block, which is all
  `test-range-straddles-block` checks). Kept as a new, much smaller
  script, `scripts/check-okf-test-citation-shape.js` (229 lines as of the
  review-round-2 fixes below, `wc -l` measured; vs. the removed script's
  468, trimmed to only the path resolution one rule needs), with its own
  fixture tests including both required negative controls (range not
  starting on a head, range not ending on the test's own close), plus
  (added in review round 2) unresolved/path-traversal citations and a
  zero-citations-checked case now failing loud instead of silently
  passing. Currently exercises the bundle's one `*.test.ts` full citation
  (`evidence-ledger-session-key-shapes.md`, citing
  `grounding-mcp/tests/grounding-gate-mcp-roundtrip.test.ts`); passes.

  Correction (review round 2, same day, applied in place since this
  entry is still unmerged): this entry originally said `~185 lines`
  (now 229, corrected above) and `{"errors":0,"warnings":0,"notices":0}`
  (corrected above) for the `okf-kit check --require-anchors` run; both
  were wrong for the state the entry describes. The line count was a
  rough pre-commit estimate that undercounted. The `{0,0,0}` claim missed
  that this very commit's own `README.md`/`package.json` edits made
  `grounding-stack-overview.md`'s frontmatter `timestamp:` (which lists
  both as `sources:`) stale the moment the commit landed:
  `okf-kit check --require-anchors --json docs/okf` against the
  committed de995f0 tree actually reported `{"errors":0,"warnings":2,"notices":0}`
  (both `sources-fresh` STALE warnings on `grounding-stack-overview.md`).
  Re-verified in review round 2: the doc's cited content
  (the README diagram in lines 13 through 49, the `package.json` workspaces/build:deps
  facts it describes narratively) is unchanged by de995f0's edits (those
  landed at README.md:200-202 and in package.json's `scripts` block,
  neither touching what the doc cites), so this was a stale-timestamp
  false positive, not stale content; the doc's frontmatter `timestamp:`
  was re-stamped to postdate this fix commit and re-verified clean:
  `okf-kit check --require-anchors --json docs/okf` on the fix commit's
  own committed tree reports `{"errors":0,"warnings":0,"notices":0}`.

  Both `.github/workflows/ci.yml` and `.github/workflows/okf-staleness.yml`
  bumped their `npm install -g okf-kit@...` pin from 0.6.0 to 0.8.0
  together (`npm run check:okf-kit-pin` requires every pin identical
  across every workflow file); confirmed locally: 2 pin occurrences
  across 8 workflow files, all `okf-kit@0.8.0`. okf-kit@0.8.0 is not yet
  published to npm as of this entry (release in progress in parallel);
  `okf-anchor-guard` and `okf-staleness` are both expected red on this
  branch's own CI until that publish lands, `npm install -g
  okf-kit@0.8.0` failing to resolve is the only expected failure mode.
  `npm run build`, `typecheck --workspaces`, `test --workspaces`, and
  `test:ci --workspaces` (coverage gate) all ran locally and passed:
  build clean; typecheck clean across all 10 packages with a `typecheck`
  script; `test --workspaces` (41+35+39+125+267+13+58+38+23+58+125+602 =
  1424 tests across the 12 packages with a `test` script, 0 failures);
  `test:ci --workspaces` (jest/vitest `--coverage`) passed with every
  declared `coverageThreshold` met.

- 2026-08-26, citation anchors normalized bundle-wide, plus a red-on-drift
  CI guard, advisory for PR merges and blocking for releases (task
  79f9e0fd, refiled from the halt in task 9b6c4beb: citations drifted in
  three consecutive review rounds of that PR because nothing mechanical
  failed when a commit shifted lines). Three rounds, all against okf-kit
  0.6.0 (already pinned in okf-staleness.yml on this branch):

  Round 1 (line-citation inventory and drift fix, scoped initially to
  `solution-acceptance-verdict-contract.md`): 61 line citations found in
  that one doc across two prose forms ("line N", "lines N-M", not
  backtick-wrapped, invisible to citations-resolve) and two already-valid
  forms (bare "path.ts, colon, N[-M]" inside backticks). All 61
  normalized into full backtick "path, colon, N[-M]" citations against
  `solution-verdict.ts`, `verdict-signing.ts`, `server.ts`, and
  `ow-run-completeness.ts` (all four already in this doc's `sources`, so
  a bare filename resolves via the resolver's rule 1). Re-reading each
  cited range against the real source (not trusting the existing number)
  found 20 drifted citations -- wrong function, wrong comment lines, or a
  range that no longer covered the described behavior (e.g.
  `evaluateSolution` cited at line 574, actually at 577; `owBindingBlockers`
  cited as spanning 388 through 437, actually 391 through 440) -- all 20
  corrected. `verdict-signing.ts` and `ow-run-completeness.ts` turned out
  to already be pinned exactly to what the doc cites (`verdict-signing.ts`
  even says so in its own EOF comment: "These EOF declarations are placed
  here deliberately: it keeps every line anchor above (cited by the OKF
  doc) stable").

  Round 2, three follow-up gaps from review: (a) round 1 used PLAIN line
  ranges, not okf-kit's anchored-citation feature -- exactly the class of
  check already proved insufficient by an earlier run where a 15-line
  drift stayed green under plain line ranges. Every full citation across
  all five `docs/okf/*.md` files whose
  target lives inside this repo (131 total: the 61 above plus 70 more in
  `claim-gate-vs-review-claim-gate.md` (13), `evidence-ledger-session-key-shapes.md`
  (25), `hypothesis-tracker-persistence-split.md` (4), and
  `merge-approval-gate-mechanics.md` (23) -- reserved files `index.md`/
  `log.md` and the two docs with no in-repo `.ts`/`.md`/`.yml` full
  citations needed no work) now carries a string-form range-anchor (hash, quote, text, quote) suffix,
  chosen from a token that actually carries the citing sentence's claim
  (never a bare `describe(`/`return`/`});`/`const`). Fixed two more
  genuine drifts found while anchoring: a citation naming
  grounding-gate-mcp-roundtrip.test.ts, line 632, as where "preflight:" appears
  incidentally in a test description string actually pointed at an
  unrelated `client.callTool` call -- the real string lives at line 648
  (`it('not-ready preflight: ...')`); corrected. (b) an anchor okf-kit
  accepts merely needs to occur somewhere in the cited range, which
  misses any insertion smaller than the range -- so every anchor was
  additionally placed on the cited range's LAST line specifically (an
  anchor on the last line detects an insertion of any size above it),
  narrowing 36 ranges in the main doc (and more elsewhere) whose natural
  last line was generic (`}`, blank, `);`) back to their last real
  claim-bearing line, verified against the WHOLE TARGET FILE's occurrence
  count rather than against the cited range itself. That file-wide measure
  turned out to be the wrong criterion (round 3 below corrects it): it
  passed evidence-ledger/src/types.ts lines 9 through 14's anchor,
  `policy_decision`, as an "accepted residual" because the identifier
  recurs 4 times file-wide (three surrounding comments plus the union
  member itself), when the only count that actually matters is 1
  occurrence within the cited range 9 through 14, on its last line -- which
  it already was, so nothing there needed re-anchoring in round 3, just
  the stale round-2 rationale correcting here. Also fixed one anchor
  discovered non-robust after fix (c) below: `resolveOwKnob`'s two
  identical `return 'auto';` statements (lines 307 and 309) meant a
  1-line shift could still coincidentally match the wrong one; re-pointed
  to the unique `v === 'auto' || v === 'on' || v === 'off'` check instead
  (narrowing that citation's range to 301-306). (c) Negative-control
  measurement, insert-k-lines at the very top of `solution-verdict.ts`
  (shifts every one of its 31 citations' line numbers by k, none of them
  landing back on real content by chance): k=1 -> 31/31 anchors fired
  (`anchor-not-found-in-range` or a base-rule finding); k=2 -> 31/31
  fired. Both reverted (file diff empty afterward, `okf-kit check`
  back to baseline). False-positive probe: bumping
  `packages/grounding-mcp/package.json`'s `version` field (not a cited
  target) changes 0 findings; reverted.

  `okf-kit check --json docs/okf` on the UNCOMMITTED round-1/round-2
  working tree measured errors 0, warnings 6, notices 1, and this entry
  originally (wrongly) reported that as "unchanged" through both rounds
  and both negative controls. Round 3 below corrects this: measured again
  on the actually-COMMITTED round-2 tree (commit `b595903`, this task's
  branch before its round-3 rebase), the real numbers are errors 0,
  warnings 1, notices 1 -- 5 of the 6 "pre-existing" warnings were never
  real; they were `sources-fresh` STALE findings on docs this same PR's
  own round-1/round-2 commits had just touched, which reset via
  `sources-fresh`'s doc-commit-epoch rule (a doc committed at/after its
  source's own last commit is not reported stale, regardless of its
  frontmatter `timestamp:`) the moment those edits were committed, without
  anyone re-verifying the content was actually still fresh. The 1
  remaining warning (grounding-stack-overview.md's `package.json`
  staleness) and the 1 notice (the ambiguous bare `cli.ts` citation,
  line 178 through 193, in this file's own history) are addressed in
  round 3 below.

  New job `okf-anchor-guard` in `.github/workflows/ci.yml` (installs
  okf-kit@0.6.0 with the identical exact-pin recipe `okf-staleness.yml`
  uses, runs the identical `okf-kit check --json docs/okf`, then fails
  the build on any `citations-resolve` finding at WARNING severity --
  every base and anchor subtype, but never a NOTICE, matching `--strict`'s
  own severity split so the pre-existing `unresolved-ambiguous` notice
  above never trips it). `okf-staleness.yml` itself stays warn-only and
  unmodified for `sources-fresh`; this is a separate, additive job, not a
  change to that one's exit contract. Verified by running the job's exact
  jq/exit shell logic locally (not just reading it): clean bundle ->
  count=0, exit 0; the same insert-1-line mutation used above -> count=31,
  exit 1; reverted -> count=0, exit 0; the package.json version-bump
  false-positive probe -> count=0, exit 0. `python3 -c "import yaml;
  yaml.safe_load(...)"` confirms `ci.yml` still parses after the new job
  is added. Round 3 below finds and fixes a real gap in this posture: it
  never blocked on `.summary.errors` or on an `unresolved-ambiguous`
  notice, so it was still green on a structurally broken bundle.

  Round 3 (review fix round): rebased onto `origin/master` (the pin
  commit this branch started from, `722ee4a`, had already been
  squash-merged there as `#193`; `git rebase --onto origin/master
  931aec7` replayed only this task's own two commits, cleanly, no
  conflicts). Re-parsed `docs/okf/*.md` with okf-kit's own `CITATION_RE`
  (backtick-optional) directly, not trusting round 2's "131 anchored"
  count: 166 full citations outside log.md, 131 anchored, 35 unanchored
  (34 in `hypothesis-tracker-persistence-split.md`, doc lines 28 through
  145, targeting `lib.ts`/`hypothesis-store.ts`/`server.ts`/
  `hypothesis-store-fs.ts`/`hypothesis-sync.ts`/`hypothesis-bridge.ts`;
  1 in `merge-approval-gate-mechanics.md`:110), plus 2 pre-existing
  unanchored citations in `log.md` itself, excluded from this coverage
  scope as instructed (reserved/append-only, matches okf-kit's own
  `short-form` carve-out for that file, though full citations there --
  see the bare `cli.ts` fix below -- are still in scope for
  drift/ambiguity). All 35 in-scope citations re-verified against the
  real current source first (semantic check before anchoring, per this
  round's brief) -- no drift found in any of them, all 34
  hypothesis-tracker citations and the 1 merge-approval one landed
  exactly where the doc already said -- then anchored. Also normalized 5
  in-repo prose citations never in citable form at all (bare "lines N-M",
  invisible to `CITATION_RE`, not the 4 this round's own brief estimated):
  `runtime-reality-policy-pointer.md`'s "lines 26-36" / "line 88" /
  "lines 113-116" into `handle-pre-tool-use.ts` (re-verified: `PolicyEnv`
  spans exactly 26 through 36 as claimed, `envOn` is exactly line 88, the
  `auditEnv` object literal's four fields are exactly 113 through 116 --
  no drift, just never citable; anchored the `PolicyEnv` citation as 26
  through 35, narrowed by one line off the doc's own 26-36, so the anchor
  lands on the interface's last real field instead of its closing `}` --
  same "land on real content, not a generic closer" narrowing the
  `README.md` fix two sentences below does explicitly), and
  `grounding-stack-overview.md`'s
  "lines 9-50" into the root `README.md`'s mermaid diagram (actually the
  fenced block, lines 13 through 50; anchored 13 through 49 to land the
  anchor on real content, not the closing fence) and "lines 9-30" into
  the root `CHANGELOG.md` (verified: still exactly the version-lock
  paragraph through the `readme-first-resolver` bullet, no drift).
  Bundle total after this round: 171 full citations outside log.md, all
  171 anchored.

  Anchor rule was wrong (review MEDIUM): okf-kit's own `checkAnchor` only
  asks "does the anchor text occur ANYWHERE in the cited range", so an
  anchor whose text also occurs EARLIER in the same range still passes
  okf-kit today even though a line-shift that only moves the LATER
  occurrence leaves the earlier one to falsely keep the check green.
  Corrected rule, now enforced mechanically (see `check-okf-anchors.js`
  below) for every string anchor in the bundle outside log.md: the anchor
  text must occur on the cited range's own LAST line, AND exactly once
  within the range -- file-wide rarity (round 2's own criterion) is no
  longer it, and never was the right one. Re-scanned the whole bundle
  under the corrected rule and found exactly 2 real violations, both
  named by the review and both confirmed reproducing:
  `solution-acceptance-verdict-contract.md`:128 (`verdict-signing.ts:100-109`,
  anchor `return newPath;` also matches line 107, not just the last line
  109) and same doc:245 (ow-run-completeness.ts lines 397 to 454 at that commit, anchor
  `return scan;` also matches line 399, not just the last line 454). Both
  fixed by widening the anchor text to include its own 2-space indent
  (`  return newPath;` / `  return scan;`), which the shallower-indented
  earlier occurrence on each target's own line (`if (...) return X;`,
  1-space before `return`) does not contain, so the substring is now
  unique to the deeper-indented bare `return` on the range's actual last
  line -- verified via direct line-by-line inspection of both targets,
  not assumed. The review's third named example,
  `evidence-ledger-session-key-shapes.md`:32/:37 (evidence-ledger's
  `types.ts`, lines 9 through 14, anchor `policy_decision`),
  was checked directly against `types.ts` and turned out to be a false
  alarm under the CORRECTED rule: `policy_decision` occurs exactly once
  within lines 9 through 14 (on line 14, the range's own last line); round
  2's "occurs 4 times, accepted residual" note was measuring file-wide
  occurrence, the wrong scope, corrected above where that note lives. The
  mechanical scan also caught two citations THIS round's own prose-anchoring
  work introduced: `hypothesis-sync.ts:31-36`'s anchor `hypotheses.json`
  landed one line short of the range's real last line (`*/`, the JSDoc
  close, at 36; the content itself is at 35) -- narrowed to 31 through 35;
  and the addendum's new *.test.ts shape rule (below) reshaped
  `evidence-ledger-session-key-shapes.md`:51's citation to span the whole
  `it(...)` block it names instead of a single line. That span moves with the
  file and is re-pointed with it rather than frozen at the numbers it had when
  this entry was written; it stands at
  `packages/grounding-mcp/tests/grounding-gate-mcp-roundtrip.test.ts:671-685#"blockers).toContain('test: 2 failing')"`
  on this commit.

  CI guard was green on a structurally broken bundle (review MEDIUM):
  `okf-anchor-guard` treated any okf-kit exit 1 as "findings, keep going"
  and only ever counted `citations-resolve` WARNINGs, so (a) a
  frontmatter error (`.summary.errors > 0`, e.g. a missing `type:` field)
  passed with exit 0, and (b) an `unresolved-ambiguous` citation --
  meaning citations-resolve never evaluated it at all -- was silently
  excluded from the count as "just a notice", the same non-evaluation
  reading as a clean bill of health. Fixed: the job now also fails when
  `.summary.errors > 0`, and also fails on any citations-resolve
  `unresolved-ambiguous` notice specifically (every other notice is still
  non-blocking, surfaced in the step summary instead). Simulated all four
  scenarios against the job's own literal `run:` block, extracted via
  `python3 -c "import yaml; ... doc['jobs']['okf-anchor-guard']['steps']"`
  (not a paraphrase of the shell): clean bundle -> exit 0; drifted
  (inserted 1 line at the top of `lib.ts`) -> exit 1, 11
  `citations-resolve` errors reported for
  `hypothesis-tracker-persistence-split.md`, file reverted after (empty
  diff); wrong bundle path (`docs/does-not-exist`) -> exit 2, tool/usage
  posture unchanged; frontmatter error (deleted `type:` from
  `grounding-stack-overview.md`) -> now exit 1 via `errors=1` in the step
  summary (previously exit 0 on this exact scenario, the vacuous-green bug
  the review measured), file reverted after (empty diff). Fixed the
  bundle's own instance of the ambiguity gap as a prerequisite (this
  round's guard fix would otherwise turn log.md's pre-existing
  `unresolved-ambiguous` notice into a permanent CI failure): the historical
  bare `cli.ts` citation (line 178 through 193) in this file's own
  2026-08-22T04:54:02Z entry is qualified to
  `packages/review-claim-gate/src/cli.ts:178-193`, the
  file this same entry's later cross-reference (`countEvidenceFileLines` /
  `buildContext` in `packages/review-claim-gate/src/cli.ts`) already names;
  re-verified against current source (still exactly the
  `countEvidenceFileLines` function body through its closing `for` loop,
  no drift) before re-pointing, per this round's instruction to fix
  rather than mask a drifted/ambiguous historical citation, recorded here
  as that fix's own log entry.

  Pin coupling (review MEDIUM): `okf-kit@0.6.0` was hardcoded
  independently in `okf-staleness.yml` and `ci.yml` with nothing coupling
  the two pin strings. Added `scripts/check-okf-kit-pin.js` (+
  `scripts/check-okf-kit-pin.test.js`, 9 tests, including a negative
  control: a deliberately diverging pin fixture fails), same
  fixture-tested idiom as `check-pins.js`/`check-deps.js`/
  `check-lockfile-integrity.js`; wired into `ci.yml`'s `okf-anchor-guard`
  job and `package.json` (`check:okf-kit-pin` / `test:check-okf-kit-pin`).

  Mechanical anchor discipline (orchestrator decision D21): added
  `scripts/check-okf-anchors.js` (+ `scripts/check-okf-anchors.test.js`,
  23 tests) as this repo's own, stricter check on top of okf-kit, which
  only validates an anchor IF one is present and only that its text
  occurs somewhere in the range. Walks `docs/okf/*.md` (log.md excluded),
  parses full citations with a `CITATION_RE` copied verbatim from okf-kit
  0.6.0 (backtick-optional; deliberately NOT skipping fenced code blocks
  for full citations, confirmed by reading okf-kit's `scanDoc` directly --
  its own full-citation scan does not skip fences either, only its
  separate short-form matcher does), resolves in-repo targets mirroring
  okf-kit's own `resolveCitation` precedence (doc `sources:` match,
  ancestor climb, root-relative, doc-relative, prior-qualified-citation,
  repo-wide basename search), and asserts (a) every resolved citation
  carries a `#"..."` anchor unless allowlisted with a reason (empty
  today), (b) the anchor text sits on the range's own last line, (c) it
  occurs exactly once within the range. A `*.test.ts` target gets a shape
  rule INSTEAD OF (b): the range must start on the test's own
  `describe(`/`it(`/`test(` head and end on that test's own closing
  `});`. It is (b) that is dropped entirely for these citations, not (c):
  a bare `});` recurs at every nesting depth inside a test body, so
  requiring the anchor to also sit on that exact closing line would fight
  the shape rule instead of composing with it. (c) itself is unchanged --
  it was always "occurs exactly once within the range" with no last-line
  qualifier of its own, so it still applies to a test citation exactly as
  written, unrelaxed. Wired into the `okf-anchor-guard` job and
  `package.json` (`check:okf-anchors` / `test:check-okf-anchors`).
  Three required negative controls, all fixture-based (disposable temp
  dirs, never the real bundle), each restored after: removing an anchor
  entirely -> fails, naming the citation (`missing-anchor`); shifting the
  anchor off the range's last line -> fails (`anchor-not-on-last-line`);
  duplicating the anchor token inside the range -> fails
  (`anchor-not-unique-in-range`).

  Numbers (review MEDIUM) and wording (review LOWs): job renamed from
  "OKF bundle citation guard (blocking)" to "OKF bundle citation guard";
  its header comment now says plainly that `master` carries no required
  status checks today (verified via the GitHub API), so this job is
  advisory for a PR's Merge button, but DOES gate `release.yml`'s
  tag-triggered release (that workflow's `release` job `needs: ci`, and
  `ci` there is this whole `ci.yml` invoked via `workflow_call`). Noted
  that `npm install -g okf-kit@0.6.0` is a registry install with no
  lockfile entry and no integrity hash, a deliberate, narrow exception to
  this repo's lockfile-integrity posture. `verdict-signing-interop.test.ts
  (14 tests)` corrected to 15 (re-counted `^\s*it\(` against the real
  file). "batch 27" in this log replaced with what it actually was (an
  earlier run where a 15-line drift stayed green under plain line ranges).

  Negative-control measurement, per file per k, insert-k-lines at the
  very top of each target (shifts every one of that file's citations' line
  numbers by k, none landing back on real content by chance): solution-verdict.ts
  k=1 -> 31/31 fired, k=2 -> 31/31 fired; hypothesis-store.ts k=1 -> 8/8
  fired, k=2 -> 8/8 fired (this file's citations did not exist before this
  round, so there was nothing to fire at either k previously); ow-run-completeness.ts
  k=1 -> 17/17 fired, k=2 -> 17/17 fired. All three files reverted (diff
  empty afterward). False-positive probe unchanged: bumping
  `packages/grounding-mcp/package.json`'s `version` field changes 0
  findings (`.summary` byte-identical before/after), reverted.

  Staleness (review MEDIUM): six docs' frontmatter `timestamp:` restamped
  after genuine re-verification (their cited lines and factual claims
  checked against current source content, no drift found):
  `grounding-stack-overview.md`, `hypothesis-tracker-persistence-split.md`
  (re-verified as part of anchoring its 34 citations),
  `claim-gate-vs-review-claim-gate.md`, `evidence-ledger-session-key-shapes.md`,
  `merge-approval-gate-mechanics.md`, `solution-acceptance-verdict-contract.md`.
  The last four were genuinely stale by frontmatter-timestamp comparison
  (a listed source committed after the doc's own `timestamp:`) even
  though `sources-fresh` never reported it on this branch, because this
  same PR's own earlier commits already carried the doc-commit-epoch
  escape hatch (see the correction near the top of this entry);
  re-verifying instead of trusting that escape hatch is the point.

  `okf-kit check --json docs/okf` on this round's tree, measured BEFORE
  commit (an uncommitted file has no git history yet, so `sources-fresh`
  falls back to a pure frontmatter-timestamp comparison with no
  doc-commit-epoch benefit -- stricter than the post-commit measurement,
  not looser): errors 0, warnings 0, notices 0.
  `node scripts/check-okf-anchors.js`: 171 full citations across 8 docs
  (log.md excluded from scope), 171 anchored, 0 unresolved, 0 ambiguous,
  0 violations.

  Review fix pass on round 3, same commit chain, before merge (accept
  with notes; the HIGH from round 3 stayed closed, 171/171 confirmed
  independently, okf-kit still 0/0/0): (1) `check-okf-anchors.js`'s own
  docblock wrongly claimed the `*.test.ts` shape rule "composes with
  (b)"; corrected to say it REPLACES (b) (only (c) still applies), which
  is what the code at the `isTestCitation` branch actually does and
  always did. (2) the CLI/step summary printed "N anchored (all last-line
  + unique-in-range)" unconditionally, false for the one `*.test.ts`
  citation; `run()` now tracks `anchoredLastLineUnique` and
  `anchoredTestShaped` separately and both the pass and failure paths
  print both counts (170 + 1 today). (3) `log.md` is RESERVED in
  `check-okf-anchors.js` (exempt from the anchor discipline entirely),
  but okf-kit's own `citations-resolve` still drift/ambiguity-checks its
  7 full citations at HEAD (2 pre-existing, 5 this round's own entry
  added while narrating the fixes) like any other doc -- a future SOURCE
  refactor shifting one of those 7 could turn CI red over an append-only
  history entry despite the anchor-discipline exemption. Fixed in
  `ci.yml`: both blocking jq selectors (`citationFindings`,
  `ambiguousFindings`) now exclude `.file == "log.md"`; every
  citations-resolve finding against `log.md` is instead collected into
  its own `logFindings` bucket and surfaced, non-blocking, in its own
  step-summary section, with the asymmetry stated in the job's own header
  comment. `PR_BODY.md`'s "Excluded (log.md)" count corrected from 2 to
  7. (4) added `permissions: contents: read` to the `okf-anchor-guard`
  job (it only ever reads; matches `okf-staleness.yml`'s own
  workflow-level grant). (5) `check-okf-kit-pin.js` rewritten: globs
  `.github/workflows/*.yml` instead of a hardcoded two-file list (a third
  workflow that starts pinning okf-kit is now automatically in scope),
  collects EVERY `npm install -g okf-kit@X.Y.Z` match per file (a global
  regex, not just the first), and asserts every occurrence found agrees,
  including two differing occurrences inside the SAME file. `PIN_RE` was
  tightened to require a real semver shape after `okf-kit@`, not a bare
  `\S+`: the bare form matched this very file's own header comment (the
  literal string `okf-kit@...` used descriptively), a false positive
  caught while testing the glob rewrite, not by the review. `readFileSync`
  is now wrapped so an unreadable file is a named `unreadable-file`
  violation instead of an uncaught exception; a zero-workspace-style
  vacuous-pass guard was added (0 pins found anywhere is itself a
  violation). Tests added: two install lines with different versions in
  one file, a third workflow file that diverges, a third workflow file
  that agrees, an unreadable file, and the zero-pins guard (22 tests
  total, up from 9). (6) `resolveCitedPath` now rejects a `citedPath`
  containing a `..` segment as an explicit `path-traversal-rejected`
  violation (mirrors okf-kit's own `hasParentSegment`, checked before any
  filesystem lookup) instead of letting it fall through and read as
  merely "unresolved" -- a silent skip would have hidden a traversal
  attempt inside an innocuous-looking count. Tested directly and via
  `run()`. (7) doc fixes: this entry's own "(c) relaxed to..." wording
  was backwards -- it is (b) that is dropped for a `*.test.ts` citation,
  not (c) (which was always "occurs exactly once within the range" with
  no last-line qualifier of its own, so it is literally unchanged, not
  "relaxed"); corrected above. Also added the missing clause that the
  `PolicyEnv` citation was anchored as 26 through 35, narrowed by one
  line off the doc's own 26-36, so the anchor lands on the interface's
  last real field instead of its closing `}` (same narrowing the
  `README.md` fix right after it already states explicitly). `ci.yml`'s
  header comment's point-in-time "verified via the GitHub API, no
  required status checks" observation is replaced with the mechanism
  (the `gh api .../branches/master/protection` command an operator can
  re-run) plus a pointer to this log for the state as last verified,
  since a hardcoded observation goes stale silently the moment an
  operator changes branch protection. (8) `ci.yml`'s `errors=$(jq
  '.summary.errors' ...)` now asserts the shape (`jq -e '.summary.errors
  | numbers'`), so a missing or non-numeric field fails the step loudly
  instead of being read as zero; the `count`/`ambiguousCount`/
  `logFindingCount`/`otherNoticeCount` array-length reads got the same
  `jq -e` treatment for consistency. (9) `check-okf-anchors.test.js`:
  added a test that pins the `*.test.ts` (b)-relaxation as intentional
  (asserts `anchoredTestShaped: 1, anchoredLastLineUnique: 0` on a
  fixture whose anchor is deliberately NOT on the range's last line), and
  a negative control where a `*.test.ts` citation's anchor occurs TWICE
  in range (must still fail `anchor-not-unique-in-range`, proving (c)
  keeps applying even though (b) does not).

  Re-measured after all of the above: `node --test scripts/*.test.js`
  180 tests, 0 failures (was 161 before this pass; `check-okf-anchors.test.js`
  grew from 23 to 29, `check-okf-kit-pin.test.js` from 9 to 22).
  `okf-kit check --json docs/okf`: errors 0, warnings 0, notices 0,
  unchanged. `node scripts/check-okf-anchors.js`: 171 anchored (170
  last-line + unique-in-range, 1 test-shaped), 0 violations, unchanged.
  `node scripts/check-okf-kit-pin.js`: 2 pin occurrences across 8
  workflow files, all okf-kit@0.6.0. Simulated the `okf-anchor-guard`
  job's exact `Citation guard` step (extracted via `python3 -c "import
  yaml; ..."`, not paraphrased) against six scenarios, each reverted
  after (file diff empty afterward): clean -> exit 0; drifted (1 line
  inserted at the top of `lib.ts`) -> exit 1; wrong bundle path -> exit
  2 (tool/usage posture unchanged); frontmatter error (`type:` line
  deleted from `grounding-stack-overview.md`) -> exit 1 via `errors=1`;
  a NEW ambiguous bare `cli.ts:1` mention added to
  `hypothesis-tracker-persistence-split.md` (not `log.md`) -> exit 1,
  unresolved-ambiguous notices: 1; a drifted `log.md`-ONLY citation (this
  file's own hypothesis-sync.ts prose-citation range hand-edited to point
  at lines 200 through 210 instead, no source file touched) -> exit 0,
  surfaced instead as `log.md findings (non-blocking): 1` in the step
  summary, proving item 3's fix actually holds.

- 2026-08-24, okf-kit citations-resolve replaces the repo-local script
  (task 21f76bfe): this repo's own `scripts/okf-citations-resolve.mjs`
  (PR #185) and its tests/fixtures are deleted; okf-staleness.yml is
  bumped to `okf-kit@0.5.0` and now checks citations via that pin's
  `citations-resolve` rule in the same `okf-kit check --json docs/okf`
  pass as `sources-fresh`, replacing the separate "Check okf citations"
  CI step and the `check:okf-citations` / `test:check-okf-citations` npm
  scripts (both removed, ci.yml's unit-test step for them removed too).
  agent-dx PR #111 ported the resolver into okf-kit with exact parity on
  this repo's bundle: local script vs okf-kit 0.5.0, same commit, same
  result -- 0 citation findings, 1 ambiguous notice, measured before this
  entry was added (the notice is an older log entry citing lines 178-193
  of a bare `cli.ts`, which matches four same-basename candidates:
  packages/claim-gate, evidence-ledger, review-claim-gate,
  understanding-gate `src/cli.ts`; the bare form is quoted here without
  the colon syntax so this entry does not add a second notice).
  The pin jump 0.3.1 to 0.5.0 also adopts okf-kit 0.4.0's sources-fresh
  change: a doc whose own last commit is at or after its source's last
  commit no longer reports STALE (fixes squash-merge stale-on-arrival,
  with the documented limitation that any commit touching a doc
  suppresses staleness for sources changed before it), so STALE counts
  on this bundle can drop after this merge without any re-verification
  having happened. The kit differs from the old script
  in two documented ways: a bare filename citation resolves doc-relative
  and via ancestor directories before falling back to the repo root, and
  a citation at column 0 on a line that itself ends in `-` is skipped as
  a wrapped path, not treated as a fresh citation.
  `scripts/okf-citation-anchor-spike.mjs` (task 42c5d5fd, throwaway,
  never CI-wired) imported seven helpers from the deleted script
  (`CITATION_RE`, `findDocFiles`, `parseArgs`, `parseFrontmatterSources`,
  `resolveCitation`, `splitLines`, `hasParentSegment`); `resolveCitation`
  itself calls several more private, unexported helpers (basename search
  with a repo-wide cache, prior-qualified-citation lookup), so vendoring
  would mean copying most of the ~630-line resolver into spike-only
  tooling that was already documented as disposable. Removed instead of
  vendored; nothing else referenced it.
  Note: the pinned `okf-kit@0.5.0` in okf-staleness.yml only resolves
  once agent-dx's OIDC-driven npm publish for that version has run;
  until then the workflow's install step 404s on PRs against this
  branch.

- 2026-08-22T07:33:36Z, citation-anchor detection spike (task 42c5d5fd,
  NOT MET, nothing shipped, corrected after review): tested whether the
  seven citation drifts hand-caught in PR #184
  (docs/okf/merge-approval-gate-mechanics.md's
  `merge-approval-rollout.md:N-M` citations, all landing on real, non-blank,
  in-range content, i.e. exactly the class scripts/okf-citations-resolve.mjs
  is structurally blind to) can be caught mechanically. Reconstructed the
  drift from commit 891821f (its own gate-mechanics.md still carries the
  seven old, pre-fix ranges; ground truth for the old/new ranges is this
  log's own 2026-08-22T04:45:51Z entry, not PR #184's body, which does not
  carry this table). Two strategies, scripts/okf-citation-anchor-spike.mjs
  (throwaway, not CI-wired):
  (a) quoted-phrase pairing (each double-quoted verbatim excerpt paired
  with the single nearest FOLLOWING citation, flagged if the quote is not
  verbatim inside the resolved range): 0/7 caught. Only the "task-id
  sentence" citation has an adjacent quote to test at all, and it fails a
  negative control: the quote is hard-wrapped across two source lines in
  the citing doc (891821f docs/okf/merge-approval-gate-mechanics.md, lines
  73-74), so QUOTE_RE (which excludes newlines) can never extract it from
  the real document, so it is reported "not extractable", not counted as
  a catch.
  Even ignoring that, it also fails a positive control: the current
  rollout.md hard-wraps the same phrase across two lines too, so the
  strategy flags both the old (wrong) range and the corrected range alike,
  unable to discriminate drift from a correct citation. 71 quote/citation
  pairs evaluated across the current 10-doc bundle at the time this entry
  was written (the script prints this count on every run so it can be
  checked live; the number moves with the bundle, including this file:
  docs/okf/log.md is itself scanned like any other doc, and this entry's
  own quoted phrases and citations are part of what gets counted), 38
  false positives -- worse than the reviewer's original whole-paragraph
  prototype (1/7, 12 FP) because "nearest following citation" often pairs
  a quote to an unrelated citation one or two sentences later.
  (b) named-anchor verification (a markdown-heading anchor, hand-supplied
  per citation from this log's own plain-English label for each drift --
  "label table", "reviewer cheat sheet", etc. -- then mechanically checked:
  does the anchor's heading still exist in the target, and does the cited
  range fall inside its current span): two pairings were measured, and
  they are not interchangeable. FAITHFUL (891821f's citing doc checked
  against 891821f's OWN rollout.md, the file its author actually had
  open): 4/7 caught (misses: "label table", "task-id sentence",
  "ALLOWED-verdict citation"). VARIANT (891821f's citing doc checked
  against HEAD's later-restructured rollout.md): 5/7 caught (misses:
  "label table", "task-id sentence"). The one citation where the two
  pairings disagree, "ALLOWED-verdict citation" (old range 82), is caught
  only in the VARIANT pairing; that catch is an artefact of the
  `## Reviewer flow` heading moving from line 82 to line 83 during the
  later restructuring, not genuine content drift. False positives NOT
  measured for either pairing: no citation in the live bundle carries an
  anchor today, and hand-authoring one per citation bundle-wide is out of
  this spike's scope, so (b)'s catch rate is real but its false-positive
  rate is unknown at either catch rate.
  Decision: neither strategy meets the ship bar (5/7 with 0 false
  positives, demonstrated, at HEAD). (a) fails outright on both counts
  (0/7, 38 FP). (b) reaches 5/7 only on the VARIANT pairing, and that
  fifth catch is a heading-move artefact, not genuine drift detection; the
  fairer FAITHFUL measurement is 4/7. Either way its false-positive rate
  was never measured, so "0 false positives" cannot be claimed for (b) at
  any catch rate. Nothing promoted into scripts/okf-citations-resolve.mjs;
  its rule set is unchanged (the only edit there is exporting five
  already-existing internal functions so the spike script could reuse the
  real resolution logic instead of duplicating it -- verified
  behavior-preserving via the existing 23-test suite, still 0 findings,
  same as before). The okf-kit promotion (this task's scope item 2) is
  handled separately: agent-dx task a05dd87e is already porting the
  resolver to okf-kit as `citations-resolve`; this spike adds no new rule
  for that port to carry. AC 1's false-positive number for strategy (b) is
  structurally unmeasurable today (no live citation carries an anchor);
  consciously accepted as partially met on that point rather than claimed
  as "0 FP". Worth revisiting: author real section-heading anchors on this
  bundle's markdown citations and re-run strategy (b) for a genuine
  false-positive number, rather than the hand-supplied 7-case replay done
  here.

- 2026-08-22T06:31:26Z, okf-citations-resolve review round-3 fix (task
  28ee6911): the round-1 fix (commit f802013) had grown the
  review-claim-gate pin-bump comment in `.github/workflows/merge-approval.yml`
  from 6 to 13 lines, sitting above the `uses:`/`with:` block it annotates,
  which shifted `uses:` from line 47 to 60 and every line under `with:`
  along with it, without a restamp — breaking five citations across
  merge-approval-gate-mechanics.md (`:47`, `:51-55`, `:49`) and
  evidence-ledger-session-key-shapes.md (`:49`, `:47`). Fixed by moving the
  comment below the `with:` block instead of shortening it, which restores
  every line number the comment had shifted (uses: back to 47, task-id
  back to 49, tests-pass..evidence-logged back to 51-55) without touching
  the docs. Re-measured all nine `merge-approval.yml:N[-M]` citations in
  docs/okf/ against the fixed file (`:47`, `:49` x2, `:51-55`, `:31-44`,
  `:40-44` x2, `:4-11`, `:19-21`); all nine match. Restamped both docs'
  frontmatter timestamps since their cited lines were re-verified, though
  no citation content needed to change.

- 2026-08-22T06:05:30Z, okf-citations-resolve follow-up fix round (task
  28ee6911): merge-approval-gate-mechanics.md's README.md citation fix
  (line 74-78, shifted to 75-78; commit 085e062, prior round of this same
  task) changed doc content without a restamp or log entry; restamped
  here. Extended scripts/okf-citations-resolve.mjs to also resolve the
  bundle's colon, dash, and parenthesized continuation-citation shorthands
  (~21 instances across claim-gate-vs-review-claim-gate.md and
  evidence-ledger-session-key-shapes.md), distinguishing a genuinely new
  start line from the tail of a split range (a range legitimately ending
  on a closing brace is not drift, unlike a citation that starts there).
  `npm run check:okf-citations` against the extended resolver reports 0
  findings at HEAD (one pre-existing ambiguous review-claim-gate cli.ts
  reference in this log's own 2026-08-05 entry below, unresolvable
  between four same-named cli.ts files and left as-is, out of scope for
  prose in a log). No citation content changed as a result; the extended
  checks confirm the bundle's continuation refs, not just its full
  citations, are clean.

- 2026-08-22T04:54:02Z, docs-freshness audit round-2 review fix (task 4f61601d,
  medium/low batch): merge-approval-gate-mechanics.md hard-gate bullet
  (107-110) said the Merge button is blocked "until all five labels are
  present"; corrected to "all five prereqs are satisfied" to match the
  evidence_logged dual-route wording added in the prior round. Widened its
  rollout.md citation from `6-8, 99` to `6-8, 99-100` (the ALLOWED sentence
  spans both lines). Changed "counting non-empty JSON lines" (line 86) to
  "counting valid JSON lines", matching countEvidenceFileLines
  (packages/review-claim-gate/src/cli.ts:178-193), which skips both blank and malformed lines. Restamped
  grounding-stack-overview.md's frontmatter (00:00:00Z placeholder to a real
  `date -u` value; content itself was already re-verified in round 1) and
  fixed the round-1 log entry header timestamp to match, so the round-1
  entry's own claim about real timestamps is true.

- 2026-08-22T04:45:51Z, docs-freshness audit fix round (task 4f61601d,
  medium/low batch, reviewer follow-up): re-resolved the seven
  `merge-approval-rollout.md:NNN` line citations in
  merge-approval-gate-mechanics.md that had drifted after the prior round's
  edits (label table 15-21 -> 19-25; force-override paragraph 31-43 ->
  44-51; committed-evidence paragraph 31-43 -> 36-42; task-id sentence
  27-28 -> 31-32; ALLOWED-verdict citation 6-8,82 -> 6-8,99; "Making the
  check Required" 40-67 -> 53-81; reviewer cheat sheet 69-82 -> 83-97; the
  6-8 branch-protection citation was unchanged and left alone). Rewrote
  merge-approval-gate-mechanics.md step 5 and merge-approval-rollout.md's
  cheat-sheet step 5 to describe both routes for `evidence_logged`
  (committed file via `review-claim-gate export`, or the
  `review:evidence-logged` label force-override), not just the label.
  Added the "at least one valid JSONL entry" precondition to both docs'
  committed-file claims (countEvidenceFileLines / buildContext in
  packages/review-claim-gate/src/cli.ts). Renamed
  merge-approval-rollout.md's "What is NOT enforced yet" heading to "What
  is enforced, and what is still honour-system" to stop contradicting its
  own first paragraph, and updated the gate-mechanics citations that name
  it. Appended a verify-fix step to the debug-playbook-engine README
  example (not a full regeneration; the pre-existing `-p` vs Problem-line
  mismatch is unchanged and out of scope). Frontmatter and this entry use
  real UTC timestamps instead of the prior round's 00:00:00Z placeholder.

- 2026-08-22T04:32:48Z, docs-freshness audit follow-up (task 4f61601d,
  medium/low batch): grounding-stack-overview.md re-stamped, grounding-mcp
  0.7.0 -> 0.8.0 and runtime-reality-checker 0.3.0 -> 0.3.2 (both
  package.json-verified). merge-approval-gate-mechanics.md re-stamped: the
  evidence-source precedence section wrongly said CI evidence is "forced by
  label"; corrected to say the committed evidence-file auto-detect (action.yml,
  review-claim-gate CLI) already satisfies `evidence_logged` in CI without the
  label, which is the label's optional override only.

- 2026-08-19T11:34:00Z, re-verify + extend (task d0daa18a, G1-Nachzug der
  Option-2-Spec aus 9b6c4beb): documents the new
  `SOLUTION_VERDICT_SIGNING_KEY` env projection as the PRIMARY signing-key
  path (harness H1 apply-time projection; mirrored home resolution becomes
  the fallback). Code anchors re-checked against the branch: the env
  additions live at the END of verdict-signing.ts and the two in-place
  lines inside `getOrCreateSigningKey` (156-193) keep every previously
  restamped line citation into verdict-signing.ts valid (each cited symbol
  re-resolved after the change). Review then found and fixed in the same
  PR: the solution-verdict.ts citations carried a 3-line offset since #177
  (now 185-191 / line 187 / docblock 159-184) and the mkdirSync quote had
  drifted with the env change; both corrected.

- 2026-08-19T10:38:21Z, restamp (task 9b6c4beb, round-2 review fix G2 of
  `.ai/runs/2026-08-19-verdict-signing-producer`): closes R2-M1 (round-2
  review finding: the prior restamp below was correct for commit `2db3098`,
  but the very fix commit that landed it, `c4a89d9`, immediately made it
  stale again by growing `writeVerdict`'s docblock with the new F6/D-006
  stale-marker-on-signing-failure paragraph, and separately regressed the
  `EvaluateResult` docblock the same commit touched). All 38
  `solution-verdict.ts`/`verdict-signing.ts` line citations in this doc were
  individually re-resolved against the current file (grep the cited symbol,
  confirm it sits at the cited line; not a constant-offset guess) and 38
  needed correcting; 25 others (8 into `solution-verdict.ts`/`server.ts`
  whose citations sit before every shift, 17 into the untouched
  `ow-run-completeness.ts`) were re-checked and confirmed still exact,
  no edit needed. Two shift bands account for the movement:
  `solution-verdict.ts` citations at/after `writeVerdict` (line 182, was
  155) shifted +27 (a +1 from the `Verdict.alg` docblock rewording below,
  landed by this same task's round-2 fix G3, then +26 more from
  `writeVerdict`'s new docblock paragraph); `verdict-signing.ts` citations
  at/after the D-001 comment (line 10) shifted +2 (D-001/D-005 provenance
  text reworded away from the `.ai/runs/...` path per F3, same as this doc's
  own prior sweep already did). The "7-key shape is pinned by the harness
  consumer" citation (`lines 536-537`, echo `line 602`) also moved content,
  not just position: round-2 fix G3 reworded both the `evaluateSolution`
  docblock paragraph and its inline echo to state precisely what they now
  mean (the OW arm adds no field of its own; the *returned* `verdict` stays
  pre-signing, `writeVerdict`'s `alg`/`signature` addition is separate and
  applies only to the on-disk marker) after a round-2 finding (R2-L1) that
  the old wording still read as "the whole marker is pinned to 7 keys",
  contradicting the `alg`/`signature` fields two sections above; this doc's
  citation now points at the reworded text (`lines 562-563`, echo
  `lines 631-632`), which still supports the same claim this doc makes.
  `okf-kit check --json docs/okf` (v0.4.0) re-run against the updated
  bundle: exit 0, 0 errors, warnings/notices unchanged from the prior sweep
  below (same 9 pre-existing `sources-fresh` staleness warnings in the 5
  OTHER docs untouched by this task; `solution-acceptance-verdict-contract.md`
  itself produced zero findings, same as before).

- 2026-08-19T09:24:20Z, re-verification sweep + new section (task 9b6c4beb,
  T-003 of `.ai/runs/2026-08-19-verdict-signing-producer`):
  solution-acceptance-verdict-contract re-checked line-for-line against
  grounding-mcp 0.8.0 (`packages/grounding-mcp` bumped 0.7.1 -> 0.8.0 in the
  same change). Substantive: new "Verdict marker signing (0.8.0)" section
  documents `src/verdict-signing.ts` (new file, T-001): the key path
  `<harness-home>/harness.generated/.approval-signing.key`, the mirrored
  3-tier-plus-create `resolveHarnessHome()` precedence, `getOrCreateSigningKey`
  (getOrCreate/0600/`wx`/truncated-key-repair), the fixed-order
  `canonicalPayload`/`signVerdict` payload, and D-001's independent-mirror /
  no-package-dependency rationale, plus a corrected account of the harness
  consumer's "genuinely unsigned, not forged" carve-out (T-002 finding: it is
  narrower than an earlier plan paraphrase; it fires only when a required
  signed field reads blank AND `alg`+`signature` are BOTH absent; a realistic
  pre-0.8.0 legacy marker, valid `timestamp`/`source` with no `alg`/`signature`
  at all, does NOT hit it and is classified `forged: true`), proven by the new
  `tests/interop/` suite (T-002, vendored source-stamped mirror of the harness
  consumer). The stale `PACKAGE_VERSION = '0.7.0'` citation is corrected to
  `0.8.0`; the "7 keys, pinned" verdict-shape section now also documents the
  two additive optional `alg`/`signature` fields; the "Hand-writing the
  marker" and "Out-of-repo boundary note" sections are updated to describe
  what 0.8.0 signing does and does not close (same-UID threat model,
  unchanged from harness' own posture, not a new authorization boundary).
  Restamp-only (line citations re-derived, no semantic change): every other
  `solution-verdict.ts` citation shifted, non-uniformly (+9 to +21 lines),
  because the `Verdict` interface grew from 16 to 27 lines to fit the two new
  fields and their doc comments, and `src/verdict-signing.ts` gained a new
  import line; `evaluateSolution` 523->544, `evaluateGate`'s HEAD-mismatch
  block 204-211->225-232, `writeVerdict`'s unconditional-overwrite line
  135->159, `verdictDir()` 91-98->103-110, `sanitizeVerdictId` 106-113->
  118-125, `verdictPath` 115->127, `owBlockersFor` 282->303, the
  `ready = pf.ready && ...` fold-in 584-586->601-607, the
  `orchestrator-workflow: ` prefix line 296->317, `owBindingBlockers`
  340-389->361-410, `RUN_BASE_SHA` 303->324, the legacy date-heuristic block
  380-388->401-409, `resolveOwKnob` 250-260->271-281, and the pre-merge-by-
  design test-pin comment 332-338->353-360; each was re-derived by grepping
  the current file for the named symbol, not by a constant offset. Citations
  into `ow-run-completeness.ts` and `session-store.ts` were left untouched
  (verified via `git log` that neither file has changed since the 2026-08-05
  sweep below, so their prior re-verification still holds); `README.md` was
  out of this task's allowed-changes scope and was not re-verified or edited
  here: its solution-acceptance-gate paragraph still describes the
  hand-write residual as fully open, which the new signing section above
  narrows; flagged as a follow-up, not fixed in this pass. `okf-kit check
  --json docs/okf` (v0.4.0) run against the updated bundle: exit 0, 0 errors,
  9 warnings, 0 notices, all pre-existing `sources-fresh`
  staleness in 5 OTHER docs (claim-gate-vs-review-claim-gate.md,
  evidence-ledger-session-key-shapes.md, grounding-stack-overview.md,
  hypothesis-tracker-persistence-split.md, merge-approval-gate-mechanics.md)
  untouched by this task; solution-acceptance-verdict-contract.md itself
  produced zero findings.

- 2026-08-05T15:56:24Z, re-verification sweep (task d6f48ad9): 5 stale docs
  re-checked against current sources. Substantive: solution-acceptance-verdict-contract
  gained a new bullet for the Mixed-State-Bypass-Guard (task `8f173547`,
  `OW_FINDINGS_PLACEHOLDER_ROW` / `scanFindings` / `isPlaceholderRow` in
  ow-run-completeness.ts) and had every ow-run-completeness.ts line citation
  re-pinned — that file's header docstring and body grew substantially for the
  guard, shifting citations by anywhere from 0 to +97 lines (non-uniform, so each
  was re-derived by function name, not by a constant offset); solution-verdict.ts
  itself was untouched (all its citations still held exactly). grounding-stack-overview
  and claim-gate-vs-review-claim-gate had drifted version numbers (four locked
  packages 0.5.0 → 0.6.0, grounding-mcp 0.6.0 → 0.7.0, review-claim-gate
  0.1.3 → 0.1.5, review-claim-gate's pinned claim-gate/evidence-ledger deps
  0.5.0 → 0.6.0) — all from the lockstep v0.6.0 release train + consumer re-pins (PR #151,
  97dfa51); no behavior change in the version-number edits themselves, though
  the same release's grounding-mcp 0.7.0 carries the OW mixed-state guard. evidence-ledger-session-key-shapes' db.ts line refs shifted +11
  (session column, rebuild copy, idx_session, listEntries filter, getSummary)
  from further db.ts churn since the 2026-07-18 getDb-guard re-stamp, plus one
  stale test-file line ref (grounding-gate-mcp-roundtrip.test.ts:645 → :632).
  hypothesis-tracker-persistence-split re-checked line-for-line against
  hypothesis-tracker/src/lib.ts, grounding-mcp's hypothesis-store.ts and
  server.ts hypothesis_* verbs, and understanding-gate's hypothesis-store-fs/
  -sync/-bridge — zero drift, restamp only. Checked PR #160/#161's
  `@modelcontextprotocol/sdk` 1.30.0 bump and lockfile-only audit fix against
  all 5 docs: no doc makes a claim it invalidates.

- 2026-07-18T05:08:08Z, ride-along re-verify (task 56e26999, getDb path
  guard): evidence-ledger-session-key-shapes re-stamped with db.ts line
  refs shifted +44 by the new singleton path guard (guard changes no
  session-key semantics); claim-gate-vs-review-claim-gate re-stamped
  unchanged (its db.ts claims — `listEntries(getDb(dbPath))` ledger
  fallback — still hold; the CLI's `resetDb()`-before-`getDb` hygiene
  predates the guard).

- 2026-07-16T02:31:52Z, re-verification sweep (task de7982e2): 5 stale docs re-checked
  against current sources. Substantive: grounding-mcp hypothesis state is
  disk-backed since PR #139 (doc premise inverted); review-claim-gate's
  evidence-path guard gained a symlink-aware backstop (PR #141); the
  ghost `add`-verb example was corrected to the real `ledger fact` verb here
  and in merge-approval-gate-mechanics.md. claim-gate version bug
  541c19e8 confirmed fixed on master (PR #136).

- 2026-07-16T01:03:30Z, CI now watches staleness: warn-only
  `okf-kit check` on every PR (.github/workflows/okf-staleness.yml,
  canonical pattern from harness#350).
- 2026-07-10T01:54:48.122127Z, initial 7 docs authored and verified against sources at master
  20cf37f: grounding-stack-overview, runtime-reality-policy-pointer,
  evidence-ledger-session-key-shapes, solution-acceptance-verdict-contract,
  claim-gate-vs-review-claim-gate, hypothesis-tracker-persistence-split,
  merge-approval-gate-mechanics.

- 2026-09-05T16:52:20Z, solution-preflight diagnostics contract (task
  60930b4e): solution-acceptance-verdict-contract now distinguishes advisory
  diagnostics from the unchanged signed verdict marker: availability, original
  payload, execution outcome, completeness, and issues are response-only and
  never authority. It also corrects the prior committed-configuration claim:
  preflight loads repository configuration from the worktree at execution;
  callers cannot supply a replacement check list. All live
  solution-verdict.ts citations were re-derived individually; the complete
  not-ready MCP test citation and the collateral README citation were
  re-pinned. `okf-kit check --require-anchors --json docs/okf` reported 0 errors, 0 warnings, and 1 nonblocking
  notice for the new untracked helper source; `check:okf-test-citation-shape`
  and its test both passed (one check each).

- 2026-09-05T17:04:29Z, diagnostics review correction (task 60930b4e):
  completeness now documents bounded confidence and canonical UTC timestamp
  validation, and the duplicate-run condition now names its full unchanged
  scope. Re-pinned the helper, MCP test, and README references after the
  reviewed source/test additions; prior validation evidence remains unchanged.

- 2026-09-05T19:25:07Z, progress-notifications review-round-2 closing delta
  (task 8c9a99fc): added `packages/grounding-mcp/src/progress.ts` to sources
  and one clause to the `solution_evaluate` bullet noting it calls
  `evaluateSolution` wrapped in `withProgressPings` when the request carries
  a `progressToken`, with no effect on the verdict. The underlying
  `server.ts` edit (interval validation via a new exported
  `resolveProgressIntervalMs`, plus an explicit `message` argument) shifted
  every later line in the file by +14/+15; re-pinned both bounds of every
  shifted citation in this doc (`solution_evaluate`/`solution_gate`
  registration lines) and, because the shift also broke citations outside
  this doc's own edits, in `evidence-ledger-session-key-shapes.md` (the
  `ledger_add` sessionId param doc and write-through range, plus the
  `preflight:` incidental-match test citation) and
  `hypothesis-tracker-persistence-split.md` (all seven `hypothesis_*`
  registration lines, the `saveStore` call-site list, and the
  not-found-rejected-or-checks-pending error line). `okf-kit check
  --require-anchors --json docs/okf` reported 0 errors, 0 warnings, 0
  notices; `check:okf-test-citation-shape` and `check:okf-selectors` both
  passed.
