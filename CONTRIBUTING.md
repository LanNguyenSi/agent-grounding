# Contributing

## Building from source

From the repo root:

```sh
npm install
npm run build
```

That's it. Do **not** use `npm run build -ws` (or `npm run build --workspaces`) directly from the root, because it skips the topological build prefix and fails with `Cannot find module '@lannguyensi/grounding-wrapper'` on a fresh checkout.

The root `build` script is two phases:

1. `build:deps`: explicitly builds the leaf packages (`grounding-wrapper`, `evidence-ledger`, `claim-gate`, `hypothesis-tracker`, `runtime-reality-checker`) first.
2. `npm run build --workspaces --if-present`: alphabetical pass over every workspace. By the time it reaches dependents (`grounding-mcp`, `grounding-sdk`, `review-claim-gate`, `understanding-gate`), their deps already have a populated `dist/`.

When adding a new package that other packages depend on, append it to the `build:deps` workspace list in the root `package.json`.

## Running a single package

```sh
npm run build -w packages/<name>     # build one package
npm test -w packages/<name>          # test one package
```

The single-package commands work fine because they target the package directly; the topology only matters for whole-monorepo builds.

## Cutting a release

Releases are per-package and tag-driven. The publish workflow (e.g. `publish-understanding-gate.yml`) triggers on a tag matching `<package>-v<version>` and runs `npm publish`.

The checklist below is the canonical cut-procedure. Skipping step 3 has bitten us before (the lockfile drifted across three understanding-gate releases before getting noticed in the PR #62 dogfood diff).

1. **Preflight + branch off latest master.**
   ```sh
   cd <repo>
   git fetch origin --quiet && git status -uno && git branch --show-current
   git checkout master && git pull --ff-only
   git checkout -b release/<package>-v<version>
   ```
2. **Bump the package's `package.json#version`.** Only one package per release branch; do not mix versions.
3. **Resync `package-lock.json`.** This step is load-bearing. Run it from the repo root:
   ```sh
   npm install --package-lock-only
   git diff package-lock.json
   ```
   The diff should touch the bumped package only. If it touches an unrelated workspace, that is pre-existing lock drift catching up with reality, not an error caused by your bump, but it does indicate a prior release skipped this step. Note it in the PR body and move on.
4. **CHANGELOG entry.** Add a new top-level section in the package's `CHANGELOG.md` matching the existing format (e.g. `## 0.2.2, 2026-05-03`). Reference the merged PR(s) the release ships. No em-dashes in new prose; the older entries keep their historical style.
5. **Build + test green** for the package being released:
   ```sh
   npm run build -w @<scope>/<name>
   npm test  -w @<scope>/<name>
   ```
6. **Dogfood the change against the real built binary**, not just unit tests. For each user-visible acceptance criterion in the release, design a small CLI / hook / HTTP probe that exercises it end-to-end against `dist/`. Document the inputs and observed outputs in the release-PR test plan. Unit tests prove code correctness; dogfooding proves feature correctness.
7. **Push the release branch and open a PR** with a Markdown test-plan checklist in the body, naming each dogfood case and its expected vs observed outcome. The PR body is a release note: it ends up referenced from the CHANGELOG and the maintainer reads it before tagging.

   **PR creation on this repo needs a human-owned credential, not the App token.** The GitHub App installation token this repo's agents mint cannot create pull requests here (`createPullRequest` is not accessible by the app's own integration/installation identity on this repo). Use `gh pr create` under a human-owned `gh` auth instead; if you hit a PR-creation 403/permission error while cutting a release here, this is why: do not spend time debugging the App token first.
8. **Run the review subagent** with a checklist that covers version bump, CHANGELOG, lockfile scope, release-worthiness audit, dogfood reproducibility, build hygiene, tag procedure, and cross-package contamination. Address blockers before merge.

   **The `merge-approval` gate has a label-free path for a pure release PR.** `.github/workflows/merge-approval.yml` computes a `pure_release` verdict from the PR's actual changed files and treats it as satisfying all five `review:*` prerequisites when the PR touches only `package.json`, `package-lock.json`, `CHANGELOG.md` (root) and/or any number of packages' `packages/<name>/package.json` / `packages/<name>/CHANGELOG.md`, each file `added` or `modified` (never `renamed`/`removed`), exactly steps 2-4 above, nothing else. For `package.json`/`package-lock.json` specifically (`scripts/release-exception.js`'s `classifyPullFiles`), the check `JSON.parse`s the file's actual content at the PR's base and head commits and requires every differing JSON path to be one of the version fields the bump is allowed to touch (`$.version`, and for the lockfile also its workspace entries' `.version`), with a real semver string on both sides: a version-bump PR that also adds a `postinstall` script, a new or renamed dependency key, a lockfile `resolved`/`integrity` repoint, or bumps a value to something that isn't semver (a `^`-ranged string, a shell command) is disqualified even though the path alone would look pure, and the check fails closed (not pure) on anything it cannot parse or read, including an `added` file (no base content to compare against). This is data-driven, not a scope widening of what the five labels mean: a release PR that also touches anything else (most commonly a source version constant, e.g. `packages/grounding-mcp/src/server.ts`, or a `docs/okf/*.md` re-stamp picked up alongside the bump) is disqualified from the exception on that file alone and falls back to the normal review + label path above. Do not add such a file to the allowlist to make it "pure"; that is the drive-by-refactor risk the labels exist to catch, so keep the version-bump commit and any source/docs changes in separate PRs when you want the label-free path. This classifier does not enforce this checklist's "only one package per release branch" rule (step 2): a PR bumping several packages' `package.json`/`CHANGELOG.md` at once, each individually version-only, still classifies pure. A cross-pin case is not automatically caught either: if package A's `package.json` pins an exact version of `@lannguyensi/B` (rather than a semver range) and the release also bumps B, A's dependency line changes too, which lands outside the allowed `$.version`-only path and correctly falls back to the label path, but only a *dependent's own* changed `package.json`/lockfile entry is checked this way; nothing here verifies which packages a release *should* have touched. See `docs/okf/merge-approval-gate-mechanics.md` for the gate's full mechanics.
9. **Merge the PR.**
10. **Tag and push** (post-merge, on master):
    ```sh
    git fetch && git checkout master && git pull --ff-only
    git tag <package>-v<version> -m "release: <package> v<version> ..."
    git push origin <package>-v<version>
    ```
    The publish workflow takes it from there. Do not push the tag before the PR merges; if the version on master differs from the tagged commit, npm publish will mismatch.

A `prerelease` npm-script that runs `npm install --package-lock-only` is a tempting safety net for step 3, but it would also run on every contributor's local `prerelease` invocation and surface lock drift unrelated to the release. The checklist is the right place for now.
