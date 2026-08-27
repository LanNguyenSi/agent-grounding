# Log

<!-- Add new entries at the top, newest first. -->

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
  (`README.md:13-49`'s diagram, the `package.json` workspaces/build:deps
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
  109) and same doc:245 (`ow-run-completeness.ts:397-454`, anchor
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
  `evidence-ledger-session-key-shapes.md`:51's citation into
  `grounding-gate-mcp-roundtrip.test.ts:648-662`, spanning the whole
  `it(...)` block it names instead of a single line.

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
