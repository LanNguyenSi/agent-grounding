# Contributing

## Building from source

From the repo root:

```sh
npm install
npm run build
```

That's it. Do **not** use `npm run build -ws` (or `npm run build --workspaces`) directly from the root — that skips the topological build prefix and fails with `Cannot find module '@lannguyensi/grounding-wrapper'` on a fresh checkout.

The root `build` script is two phases:

1. `build:deps` — explicitly builds the leaf packages (`grounding-wrapper`, `evidence-ledger`, `claim-gate`, `hypothesis-tracker`, `runtime-reality-checker`) first.
2. `npm run build --workspaces --if-present` — alphabetical pass over every workspace. By the time it reaches dependents (`grounding-mcp`, `grounding-sdk`, `review-claim-gate`, `understanding-gate`), their deps already have a populated `dist/`.

When adding a new package that other packages depend on, append it to the `build:deps` workspace list in the root `package.json`.

## Running a single package

```sh
npm run build -w packages/<name>     # build one package
npm test -w packages/<name>          # test one package
```

The single-package commands work fine because they target the package directly; the topology only matters for whole-monorepo builds.
