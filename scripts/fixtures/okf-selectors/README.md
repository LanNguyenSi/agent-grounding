# `scripts/check-okf-selectors.js` fixtures

`clean-report.json`, `drifted-report.json`, and `error-report.json` are
all real `okf-kit@0.8.0` `check --require-anchors --json` output, not
hand-written JSON -- produced from the small synthetic OKF bundles
checked in here (`bundle-clean/`, `bundle-drifted/`, `bundle-error/`,
`src/`), so the fixture's field names and message shapes are exactly
what a real run produces, not what this task assumed from memory. Each
report's `bundleDir` field was normalized by hand after generation
(`scripts/fixtures/okf-selectors/bundle-*`, repo-relative) so it doesn't
embed a throwaway checkout's absolute path; `findings` and `summary` are
untouched tool output.

`fixture-version.json`'s `"okfKitVersion"` field records which `okf-kit`
version generated all three reports above. `scripts/check-okf-selectors.js`
compares it against `.github/workflows/ci.yml`'s own `okf-kit@...` pin on
every run and fails loud on a mismatch -- bumping the pin in ci.yml
without regenerating these fixtures (below) and updating this field
together is a check failure, not a silent no-op.

## Regenerating

From the repo root, with the pinned `okf-kit` version reachable via
`npx` (`<VERSION>` below must match `.github/workflows/ci.yml`'s
`okf-kit@...` pin and this directory's `fixture-version.json` once
you're done):

```sh
npx -y okf-kit@<VERSION> check --require-anchors --json scripts/fixtures/okf-selectors/bundle-clean > scripts/fixtures/okf-selectors/clean-report.json
npx -y okf-kit@<VERSION> check --require-anchors --json scripts/fixtures/okf-selectors/bundle-drifted > scripts/fixtures/okf-selectors/drifted-report.json
npx -y okf-kit@<VERSION> check --require-anchors --json scripts/fixtures/okf-selectors/bundle-error > scripts/fixtures/okf-selectors/error-report.json
```

Then patch `bundleDir` in all three files back to the repo-relative form
shown above (`jq '.bundleDir = "scripts/fixtures/okf-selectors/bundle-clean"'`
etc.), update `fixture-version.json`'s `"okfKitVersion"` to `<VERSION>`,
and re-run `npm run test:check-okf-selectors`.

`src/untracked.ts` was deliberately left untracked (never `git add`ed) at
the moment `drifted-report.json` was generated -- it's the one source
`bundle-drifted/doc.md` declares under `sources:`, so `okf-kit`'s
`sources-fresh` rule reported exactly the one "untracked by git,
staleness unknown" notice this fixture wants and nothing else. It is
committed here as part of this fixture set (so the fixture directory is
complete and self-contained), which means it is now git-tracked and a
literal re-run of the two commands above will NOT reproduce that one
notice verbatim. To regenerate faithfully, remove `src/untracked.ts` from
the index first (`git rm --cached scripts/fixtures/okf-selectors/src/
untracked.ts`, keep the working-tree file) before running `okf-kit`, then
re-add it afterwards. None of the other `src/*` files are declared under
any doc's `sources:` key, so their git-tracked state doesn't matter.

## What each fixture is engineered to contain

`bundle-clean/`: one doc, no `sources:` key, one citation that resolves
and anchors cleanly. Real `okf-kit` output: 0 findings, 0/0/0 summary.

`bundle-drifted/`: `doc.md` plus a reserved `log.md` (no frontmatter, per
`docs/okf/log.md`'s own convention), engineered so the real tool reports,
in order:

- `sources-fresh` / notice / `doc.md`: the one untracked source above --
  this task's example of a non-citation notice `otherNotices` must select
  and the guard must never block on.
- `citations-resolve` / warning / `doc.md` / `[missing-file]`: citation
  into a file that does not exist -- the "base" `citations-resolve`
  warning, not one of the four `--require-anchors`-only subtypes below.
- `citations-resolve` / warning / `doc.md` / `[anchor-required]`: a full
  citation with no `#anchor` at all.
- `citations-resolve` / warning / `doc.md` / `[anchor-not-on-last-line]`:
  an anchor that resolves, but not on the cited range's last line.
- `citations-resolve` / warning / `doc.md` / `[anchor-not-unique-in-range]`:
  an anchor text that occurs on more than one line of the cited range.
- `citations-resolve` / warning / `doc.md` / `[test-range-straddles-block]`:
  a `*.test.ts` citation range that starts mid-body and straddles into a
  sibling `it(` block.
- `citations-resolve` / notice / `doc.md` / `[unresolved-ambiguous]`: a
  bare filename (`shared.ts`) that matches two files
  (`src/dirA/shared.ts`, `src/dirB/shared.ts`).
- `citations-resolve` / warning / `log.md` / `[anchor-not-found-in-range]`:
  the same base rule as above, but filed against the reserved `log.md`
  doc -- this must be selected by `logFindings` and must NOT leak into
  either blocking selector (`citationFindings`, `ambiguousFindings`).

`bundle-error/`: one doc (`doc.md`) with no opening `---` frontmatter
delimiter at all, no citations. Real `okf-kit` output: exactly one
`frontmatter-required` / `error` / `doc.md` finding ("Missing frontmatter
block..."), `.summary.errors: 1`, nothing else. `clean-report.json` and
`drifted-report.json` both leave `.summary.errors` at 0, so without this
fixture the `errors` selector's contribution to the blocking verdict
(the first `-gt 0` leg in ci.yml's `if [ "${errors}" -gt 0 ] || ...`
line) was never asserted at a real positive value.

Which `okf-kit` version produced these: recorded in `fixture-version.json`
(`0.8.0` as of this fixture's creation; matches the pin in
`.github/workflows/ci.yml` and `okf-staleness.yml` at the same time --
see `scripts/check-okf-kit-pin.js` for the check that keeps those two in
sync going forward, and `scripts/check-okf-selectors.js` for the check
that keeps `fixture-version.json` itself coupled to ci.yml's pin).
