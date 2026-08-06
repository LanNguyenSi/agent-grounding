#!/usr/bin/env node
/**
 * Phantom-dependency check.
 *
 * check-pins.js asserts every internal `@lannguyensi/*` dependency pin is
 * version-consistent, but is explicitly blind to external dependencies (see
 * its file header). Nothing else in this repo asserts that a declared
 * external runtime dependency is actually used anywhere. A package can
 * declare `dependencies: { "some-lib": "^1.0.0" }` and never import it — a
 * "phantom dependency" — and nothing notices until someone manually audits
 * package.json against src/.
 *
 * This class was found twice by hand during the review of task ca2aceff
 * (2026-07-27): `glob` declared-but-unused in domain-router, and `js-yaml`
 * declared-but-unused in readme-first-resolver. Both were removed, but
 * nothing prevents the class from recurring — a re-added phantom dep, or a
 * revert of that fix, would go unnoticed the same way the originals did.
 *
 * This script walks every `packages/*\/package.json`, and for every
 * dependency declared in its `dependencies` field (RUNTIME dependencies
 * only — see "Scope" below), asserts the dependency's package name is
 * referenced by at least one `import`/`export ... from`/`require()`/dynamic
 * `import()` somewhere under that package's `src/` tree.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 *
 * Only the `dependencies` field is checked, not `devDependencies`: an unused
 * *dev* dependency is not a shipped-artifact closure problem the way an
 * unused *runtime* dependency is (out of scope per task a5cd84a0 — devDeps
 * are a housekeeping concern, not a phantom-dep-class correctness bug).
 * `peerDependencies` / `optionalDependencies` are also not checked: no
 * package in this repo declares either today, and both have looser "must be
 * imported" semantics (a peer dep is often provided-but-not-imported by
 * design) that would need their own rule if they ever show up — deliberately
 * left for a follow-up rather than guessed at here.
 *
 * Internal `@lannguyensi/*` dependencies are skipped entirely (check-pins.js's
 * job, not this script's — see its header).
 *
 * Jest/Vitest test-layout asymmetry: `walkSourceFiles` walks a package's
 * entire `src/` tree, test files included — it has no notion of "test" vs.
 * "production" files, only "under src/" vs. not. Four packages
 * (debug-playbook-engine, domain-router, readme-first-resolver,
 * grounding-wrapper) use Jest and keep their tests inside
 * `src/__tests__/`, so an import that appears ONLY in one of those test
 * files still counts as usage evidence for this checker — a dependency
 * genuinely dead in production code but imported by a test would NOT be
 * flagged as phantom in those four packages. Every other package uses
 * Vitest with tests in a sibling `tests/` directory (outside `src/`
 * entirely), where the same test-only import would NOT count and the
 * dependency WOULD be flagged. This asymmetry is a false-negative risk only
 * (an unused-in-production dependency slipping through in the four Jest
 * packages), never a false phantom, so it is accepted rather than special-
 * cased — narrowing `walkSourceFiles` to exclude `__tests__/` would also
 * strip genuine test-only devDependency usage from view, which is out of
 * this checker's scope (devDependencies aren't checked at all, per above).
 *
 * ── Assumption: workspaces === packages/* ─────────────────────────────────
 *
 * This script (like check-pins.js) hardcodes `packages/` as the one and only
 * workspace root, matching this repo's root `package.json` `workspaces:
 * ["packages/*\/"]` today. If a second workspace glob were ever added (e.g.
 * `apps/*\/`) alongside `packages/*\/`, this script would silently check only
 * the `packages/` half — it does not read the root `workspaces` field, so it
 * has no way to notice the mismatch. Renaming `packages/` away entirely
 * fails loudly instead (loadWorkspacePackagesWithImports's `readdirSync`
 * throws), which is why that failure mode isn't the concerning one; a
 * second, unchecked glob added *alongside* `packages/*\/` is the silent one.
 *
 * ── Dynamic load paths ──────────────────────────────────────────────────
 *
 * A plain import/require grep is proof a dependency IS used, but not proof
 * it ISN'T: a package that resolves a module via a variable or a template
 * string (e.g. a plugin-loading `require(moduleName)`) would statically
 * look unused here even though it's genuinely loaded at runtime. Resolving
 * arbitrary dynamic expressions statically is undecidable in general, so
 * this script does not attempt it. Instead: a dependency that is only
 * reachable through such a dynamic path must be added to the ALLOWLIST
 * below with an explicit reason ('dynamic-import' or otherwise) — the same
 * deliberate escape hatch used for type-only, bin-script-only, and
 * config-driven dependencies (see ALLOWLIST doc comment).
 *
 * A related, narrower blind spot in the same family: `createRequire`-based
 * requires. `understanding-gate/src/cli.ts` does `const requireFromHere =
 * createRequire(import.meta.url); requireFromHere('../package.json')` — a
 * fully static, literal-string require, not a dynamic one, but REQUIRE_RE
 * only matches the literal identifier `require` (optionally
 * `require.resolve`), so a call through a renamed binding like
 * `requireFromHere(...)` is invisible to this checker even though it could
 * statically be resolved just as easily as a plain `require(...)` call.
 * Today's only real-repo instance requires a relative path (not an npm
 * package), so it doesn't currently cause a false phantom — but a future
 * package requiring a real dependency this way would need an ALLOWLIST
 * entry (reason: e.g. 'createRequire-alias'), the same as any other
 * statically-invisible load path above.
 *
 * A second blind spot, this one in the comment stripper added to feed
 * cleaner text to the patterns above: it is a plain regex pass, not a real
 * tokenizer, so it cannot distinguish `//`/`/* *\/`-shaped text inside a
 * string literal from an actual comment. See stripComments' doc comment for
 * the full reasoning on why this is safe here (a negative lookbehind spares
 * scheme-prefixed URLs, and every import/require in this repo's source is
 * its own statement on its own line) — but it remains a real limitation the
 * stripper does not resolve in general, not just a stylistic note.
 *
 * Usage: `node scripts/check-deps.js` (wired as the `check:deps` npm
 * script). Exits non-zero and prints one line per phantom dependency found.
 * Also exits non-zero (instead of vacuously passing) if zero workspace
 * packages are found, or if zero external runtime dependencies end up
 * checked across the whole repo (e.g. every package's `dependencies` field
 * emptied, or the ALLOWLIST grew to swallow everything) — mirrors
 * check-pins.js's guard against silently disabling the gate.
 */
const fs = require('fs');
const path = require('path');

const INTERNAL_SCOPE_PREFIX = '@lannguyensi/';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Deliberate allowlist for external runtime dependencies that are declared
 * but cannot (or should not) be proven "imported under src/" by this
 * script's static check. Every entry needs a `reason` — this is meant to
 * stay small and auditable, not become a blanket suppression list. Empty
 * today: every declared external runtime dependency in this repo is
 * statically imported under its package's src/.
 *
 * Shape: { package: '@lannguyensi/x', dependency: 'some-lib', reason: '...' }
 *
 * Legitimate reasons this exists for (constraints from task a5cd84a0):
 *   - type-only: only ever referenced via `import type`, and the checker
 *     can't reliably distinguish that from a real dependency it can't yet
 *     see (not needed today — `import type` still matches the `from '...'`
 *     pattern this script looks for, so genuinely type-only deps are NOT a
 *     false positive in practice; kept here as a named reason in case a
 *     future dependency is referenced only via ambient/triple-slash types).
 *   - bin-script-only: used only by a script outside src/ (e.g. a
 *     postinstall or postbuild script at the package root).
 *   - config-driven: resolved by a config file or plugin system, never a
 *     literal import/require in source.
 *   - dynamic-import: resolved via a variable or template string at
 *     runtime (see "Dynamic load paths" above).
 */
const ALLOWLIST = [];

/**
 * Recursively walks `dir` and returns every file path whose extension is in
 * SOURCE_EXTENSIONS. Returns `[]` if `dir` does not exist (a package with no
 * src/ directory at all has nothing to check).
 */
function walkSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

// Matches `import ... from '<spec>'` and `export ... from '<spec>'`
// (including `import type`, multi-line named imports/exports, `export *
// from`). The character class excludes quotes and semicolons so it cannot
// cross from one statement into another; it does NOT exclude newlines, so
// a `from` on a later line than `import` is still matched.
const IMPORT_EXPORT_FROM_RE = /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;
// Matches a bare side-effect import: `import '<spec>'` (no `from`).
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
// Matches `require('<spec>')` / `require("<spec>")`, and also
// `require.resolve('<spec>')` / `require.resolve("<spec>")` — a caller that
// only needs a module's resolved path (not its exports) still declares a
// real runtime dependency on it.
const REQUIRE_RE = /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Matches dynamic `import('<spec>')`.
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const SPECIFIER_PATTERNS = [
  IMPORT_EXPORT_FROM_RE,
  SIDE_EFFECT_IMPORT_RE,
  REQUIRE_RE,
  DYNAMIC_IMPORT_RE,
];

/**
 * Strips `//` line comments and `/* ... *\/` block comments from
 * `sourceText` before the specifier patterns above ever see it. Without
 * this, a comment that happens to contain an apostrophe or a semicolon
 * (e.g. `// don't use bar`, `// trailing; note`) can break
 * IMPORT_EXPORT_FROM_RE's `[^'";]*?` gap between `import`/`export` and
 * `from` — the quote inside the comment looks, to that character class,
 * indistinguishable from the start of a second statement, and the whole
 * match fails, silently turning a genuinely-used dependency into a phantom.
 * A commented-out import/require is the mirror-image problem: without
 * stripping, `// import x from 'pkg';` would count as real evidence the
 * checker never intended to trust.
 *
 * This is a plain regex pass, not a real tokenizer: it does not distinguish
 * `//`/`/* *\/` inside a string literal from an actual comment. The
 * specific case that matters here is a URL string containing `//` (e.g.
 * `'https://example.com'`) — stripping "starting" at that `//` would delete
 * the rest of the physical line. Two things keep this from ever causing a
 * FALSE PHANTOM (a real dependency wrongly reported unused), which is the
 * only direction of error this checker cannot tolerate:
 *
 *   1. A negative lookbehind spares any `//` immediately preceded by `:`
 *      (the `http://`, `https://`, `ws://`, `git://`, ... shape — the
 *      overwhelming majority of URLs that appear in source comments/
 *      strings), so a same-line scheme-prefixed URL does not trigger
 *      stripping at all.
 *   2. Even for a URL this misses (a bare protocol-relative `//host/path`,
 *      with no scheme before it — not used anywhere in this repo today),
 *      the only way stripping it could delete a real import/require
 *      specifier is if that specifier sits on the exact same physical line,
 *      AFTER the URL. Every import/require/dynamic-import in this repo's
 *      source is its own statement on its own line (the enforced style) —
 *      there is nothing else on those lines a URL could hide behind. If
 *      this ever changes, the failure mode is a loud, obvious CI red (the
 *      dependency starts failing check:deps), not silent drift, and the fix
 *      is a one-line reflow (move the string off the import's line), not a
 *      rewrite of this stripper into a full parser.
 *
 * The reverse trade (a `//` right after a `:` that IS a real trailing
 * comment, e.g. a `case 'x'://comment` label with no space) is deliberately
 * left unstripped by the same lookbehind: that only risks a comment's text
 * being scanned as if it were code, which can at most manufacture spurious
 * import-like evidence (a false NEGATIVE on phantom detection — a
 * genuinely-unused dependency looking used) — the safe direction to err in
 * for a CI gate, never a false phantom.
 *
 * Block comments are stripped with `[\s\S]*?` (non-greedy, so a `/*` and
 * the NEXT `*\/` bound the removal, never spanning past it) so a
 * `/* ... *\/`-shaped run does not swallow unrelated code past its close.
 */
function stripComments(sourceText) {
  return sourceText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

/**
 * Given a bare-module import specifier (e.g. `"chalk"`,
 * `"@modelcontextprotocol/sdk/server/mcp.js"`, `"./lib.js"`, `"node:fs"`),
 * returns the npm package name it belongs to, or `null` if the specifier is
 * a relative/absolute path (not a dependency) or a `node:`-prefixed
 * built-in. A scoped specifier's package name is its first two path
 * segments (`@scope/name`); an unscoped specifier's is its first segment.
 */
function extractPackageNameFromSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
  }
  return segments[0];
}

/**
 * Pure function: given the text of one source file, returns the Set of npm
 * package names it references via import/export-from/require/dynamic
 * import. Operates purely on the string — safe to unit test with literal
 * source snippets, never touches the filesystem. Comments are stripped
 * first (see stripComments' doc comment for what that does and does not
 * protect against), so a specifier mentioned only in a comment — commented-
 * out code, or an apostrophe/semicolon in a stray note breaking the
 * import/export/from character class — is never mistaken for real evidence.
 */
function extractImportedPackageNames(sourceText) {
  const strippedText = stripComments(sourceText);
  const names = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(strippedText)) !== null) {
      const packageName = extractPackageNameFromSpecifier(match[1]);
      if (packageName) names.add(packageName);
    }
  }
  return names;
}

/**
 * Reads every packages/*\/package.json under `rootDir` and, for each one,
 * returns `{ name, dependencies, importedPackageNames }` where
 * `dependencies` is the raw `dependencies` field (or `{}`) and
 * `importedPackageNames` is the union of extractImportedPackageNames(...)
 * across every source file under that package's `src/` (or an empty Set if
 * the package has no src/ directory). Skips any workspace directory that
 * has no package.json.
 */
function loadWorkspacePackagesWithImports(rootDir) {
  const packagesDir = path.join(rootDir, 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

    const importedPackageNames = new Set();
    for (const filePath of walkSourceFiles(path.join(pkgDir, 'src'))) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const name of extractImportedPackageNames(content)) {
        importedPackageNames.add(name);
      }
    }

    workspaces.push({
      name: pkg.name,
      dependencies: pkg.dependencies || {},
      importedPackageNames,
    });
  }
  return workspaces;
}

/**
 * Pure checker: given the array of workspace package shapes (as returned by
 * loadWorkspacePackagesWithImports, or an equivalent in-memory fixture) and
 * an allowlist array, returns an array of violation objects. Empty array
 * means every checked external runtime dependency is imported somewhere
 * under its package's src/.
 *
 * Skips internal `@lannguyensi/*` dependencies (check-pins.js's job) and any
 * (package, dependency) pair present in `allowlist`.
 *
 * Each violation: { reason: 'phantom-dependency', consumer, dependency }
 */
function collectDependencyViolations(workspacePackages, allowlist = ALLOWLIST) {
  const allowedPairs = new Set(allowlist.map((entry) => `${entry.package}::${entry.dependency}`));
  const violations = [];

  for (const pkg of workspacePackages) {
    for (const dependency of Object.keys(pkg.dependencies || {})) {
      if (dependency.startsWith(INTERNAL_SCOPE_PREFIX)) continue;
      if (allowedPairs.has(`${pkg.name}::${dependency}`)) continue;
      if (!pkg.importedPackageNames.has(dependency)) {
        violations.push({ reason: 'phantom-dependency', consumer: pkg.name, dependency });
      }
    }
  }

  return violations;
}

/**
 * Pure helper: returns how many (package, external-runtime-dependency)
 * pairs would actually be evaluated by collectDependencyViolations for the
 * given workspace packages and allowlist — i.e. excluding internal
 * `@lannguyensi/*` deps and allowlisted pairs. Used by main() to guard
 * against a vacuously-green run (see file header).
 */
function countCheckedDependencies(workspacePackages, allowlist = ALLOWLIST) {
  const allowedPairs = new Set(allowlist.map((entry) => `${entry.package}::${entry.dependency}`));
  let count = 0;
  for (const pkg of workspacePackages) {
    for (const dependency of Object.keys(pkg.dependencies || {})) {
      if (dependency.startsWith(INTERNAL_SCOPE_PREFIX)) continue;
      if (allowedPairs.has(`${pkg.name}::${dependency}`)) continue;
      count += 1;
    }
  }
  return count;
}

function formatViolation(violation) {
  return (
    `  - ${violation.consumer} declares "${violation.dependency}" in dependencies, but no file under ` +
    `its src/ imports or requires it. Remove the dependency if it's genuinely unused, or add it to the ` +
    `ALLOWLIST in scripts/check-deps.js with a reason if it's used dynamically, from a bin script outside ` +
    `src/, or via config.`
  );
}

/**
 * CLI core: runs the full check against `rootDir` (a repo root containing a
 * `packages/` directory, in the same shape as this repo — or a disposable
 * fixture root in tests) and returns the process exit code it should
 * produce (`0` pass, `1` fail), printing the same pass/fail messages `main()`
 * always has. Pulled out of `main()` so tests can assert on the exit code
 * directly against real (temporary, disposable) directory trees, instead of
 * only exercising the pure `collectDependencyViolations`/
 * `countCheckedDependencies` core with in-memory fixtures — this is the
 * function that actually reproduces the two vacuous-green guards end to end.
 *
 * `rootDir` defaults to this script's own repo root (`path.join(__dirname,
 * '..')`), matching `main()`'s prior behavior when called with no argument.
 */
function run(rootDir = path.join(__dirname, '..')) {
  const workspaces = loadWorkspacePackagesWithImports(rootDir);

  if (workspaces.length === 0) {
    // Fail loudly instead of vacuously passing — mirrors check-pins.js's
    // zero-workspace guard. If packages/ were ever renamed, moved, or
    // emptied, silently reporting success here would disable this CI gate
    // without anyone noticing.
    console.error(
      'Dependency consistency check failed: found 0 workspace packages under packages/. ' +
        'Expected at least one packages/*/package.json; packages/ exists but contains no ' +
        'subdirectory with a package.json (renamed, emptied, or reorganized?).',
    );
    return 1;
  }

  const checkedCount = countCheckedDependencies(workspaces);
  if (checkedCount === 0) {
    // Same fail-loud principle applied to the dependency count: if every
    // package's `dependencies` field is empty (or the ALLOWLIST grew to
    // swallow everything), this check would otherwise vacuously pass
    // without checking anything at all.
    console.error(
      'Dependency consistency check failed: 0 external runtime dependencies to check across ' +
        `${workspaces.length} workspace package(s) (after excluding internal ${INTERNAL_SCOPE_PREFIX}* ` +
        'dependencies and the ALLOWLIST). Expected at least one declared external runtime dependency ' +
        'somewhere in packages/*/package.json.',
    );
    return 1;
  }

  const violations = collectDependencyViolations(workspaces);

  if (violations.length > 0) {
    console.error(`Dependency consistency check failed (${violations.length} phantom dependency(ies)):\n`);
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    console.error('\nSee each violation above for its specific fix.');
    return 1;
  }

  console.log(
    `Dependency consistency check passed: ${checkedCount} external runtime dependency(ies) across ` +
      `${workspaces.length} workspace package(s), all imported somewhere under their src/.`,
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  stripComments,
  extractImportedPackageNames,
  extractPackageNameFromSpecifier,
  loadWorkspacePackagesWithImports,
  collectDependencyViolations,
  countCheckedDependencies,
  run,
  ALLOWLIST,
};

if (require.main === module) {
  main();
}
