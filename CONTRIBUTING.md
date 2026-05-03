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
8. **Run the review subagent** with a checklist that covers version bump, CHANGELOG, lockfile scope, release-worthiness audit, dogfood reproducibility, build hygiene, tag procedure, and cross-package contamination. Address blockers before merge.
9. **Merge the PR.**
10. **Tag and push** (post-merge, on master):
    ```sh
    git fetch && git checkout master && git pull --ff-only
    git tag <package>-v<version> -m "release: <package> v<version> ..."
    git push origin <package>-v<version>
    ```
    The publish workflow takes it from there. Do not push the tag before the PR merges; if the version on master differs from the tagged commit, npm publish will mismatch.

A `prerelease` npm-script that runs `npm install --package-lock-only` is a tempting safety net for step 3, but it would also run on every contributor's local `prerelease` invocation and surface lock drift unrelated to the release. The checklist is the right place for now.
