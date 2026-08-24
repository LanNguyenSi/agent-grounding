# Log

<!-- Add new entries at the top, newest first. -->

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
  (cli.ts:178-193), which skips both blank and malformed lines. Restamped
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
