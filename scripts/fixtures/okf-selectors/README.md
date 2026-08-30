# `scripts/check-okf-selectors.js` fixtures

Both `clean-report.json` and `drifted-report.json` are real
`okf-kit@0.8.0` `check --require-anchors --json` output, not hand-written
JSON -- produced from the small synthetic OKF bundles checked in here
(`bundle-clean/`, `bundle-drifted/`, `src/`), so the fixture's field names
and message shapes are exactly what a real run produces, not what this
task assumed from memory. Each report's `bundleDir` field was normalized
by hand after generation (`scripts/fixtures/okf-selectors/bundle-*`,
repo-relative) so it doesn't embed a throwaway checkout's absolute path;
`findings` and `summary` are untouched tool output.

## Regenerating

From the repo root, with `okf-kit@0.8.0` reachable via `npx`:

```sh
npx -y okf-kit@0.8.0 check --require-anchors --json scripts/fixtures/okf-selectors/bundle-clean > scripts/fixtures/okf-selectors/clean-report.json
npx -y okf-kit@0.8.0 check --require-anchors --json scripts/fixtures/okf-selectors/bundle-drifted > scripts/fixtures/okf-selectors/drifted-report.json
```

Then patch `bundleDir` in both files back to the repo-relative form shown
above (`jq '.bundleDir = "scripts/fixtures/okf-selectors/bundle-clean"'`
etc.) and re-run `npm run test:check-okf-selectors`.

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

Which `okf-kit` version produced these: `okf-kit@0.8.0` (matches the pin
in `.github/workflows/ci.yml` and `okf-staleness.yml` as of this fixture's
creation; see `scripts/check-okf-kit-pin.js` for the check that keeps
those two in sync going forward).
