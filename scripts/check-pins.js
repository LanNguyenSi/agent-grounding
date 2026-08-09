#!/usr/bin/env node
/**
 * Pin-consistency check.
 *
 * The per-tag version guard (publish-libs.yml / publish-npm.yml) only
 * validates that the *tagged* package's own `version` field matches the git
 * tag. Nothing asserts that every internal `@lannguyensi/*` dependency pin
 * declared by one workspace package actually points at a version the
 * corresponding sibling workspace carries (or is being bumped to in the same
 * PR). A stale pin left behind after a version bump would only surface much
 * later, as an npm install resolution error or a runtime mismatch.
 *
 * This script walks every `packages/*\/package.json`, and for every
 * `@lannguyensi/*` dependency pin (in `dependencies`, `devDependencies`,
 * `peerDependencies`, or `optionalDependencies`), asserts the pin is
 * satisfiable (semver `satisfies`, prereleases excluded) by the current
 * `version` of the workspace package it names. An exact pin (`"0.5.0"`) must
 * equal the sibling's version; a range pin (`"^0.1.0"`) just needs to still
 * match after a patch/minor bump.
 *
 * Assumption: every `@lannguyensi/*` dependency named anywhere in this
 * monorepo is one of *this* monorepo's own workspace packages (true today;
 * verified by grep over packages/*\/package.json). If a package ever pins a
 * `@lannguyensi/*` dependency that is published from a different repo (not a
 * workspace member here), that pin has no corresponding entry in
 * `versionByName` and is deliberately hard-failed as `unknown-workspace`
 * rather than silently skipped. Introducing a cross-repo `@lannguyensi/*`
 * dependency would need an explicit allowlist added here first.
 *
 * ── Override coupling (brace-expansion / minimatch / test-exclude) ────────
 *
 * PR #159 closed GHSA-mh99-v99m-4gvg (brace-expansion DoS, HIGH) by pinning
 * the root `overrides` block to brace-expansion@^5.0.8, but that fix is only
 * safe together with minimatch@^10.2.5 and test-exclude@^8.0.0: those are
 * the first releases of minimatch/test-exclude that consume brace-expansion
 * 5.x's named `expand` export instead of the pre-5.x callable default. The
 * three overrides are a COUPLED SET, and npm enforces nothing about that
 * coupling on its own — removing (or never adding) only the minimatch and
 * test-exclude overrides, while the brace-expansion override stays in
 * place, still resolves brace-expansion@5.x (nothing else in the tree pins
 * it lower) and stays `npm audit --audit-level=high` green (no known CVE in
 * the resolved versions), while the old minimatch/test-exclude that npm's
 * ordinary resolution falls back to in their absence — versions that
 * predate brace-expansion 5.x's named export — throw at runtime:
 *   TypeError: (0 , brace_expansion_1.default) is not a function
 * (reproduced 2026-08-06 against a fresh install with only the
 * brace-expansion override present: minimatch resolves to 9.0.9, with a
 * nested test-exclude -> minimatch@3.1.5, both declaring a pre-5.x
 * brace-expansion range, while brace-expansion itself resolves to 5.0.9.)
 *
 * Two checks below guard this coupling from opposite ends:
 *   - `collectOverrideCouplingViolations` checks the root package.json
 *     `overrides` block: if any of the three coupled keys is present, all
 *     three must be present.
 *   - `collectBraceExpansionCouplingViolations` checks package-lock.json
 *     itself (the ground truth for what actually installs): every resolved
 *     minimatch/test-exclude entry that declares its own brace-expansion
 *     dependency must declare a range confined to 5.x. This catches a stale
 *     lockfile even if the overrides block above is correct (e.g. hand-
 *     edited, or generated before the coupled overrides existed and never
 *     regenerated).
 * Neither check repairs anything; both only fail loudly. (Deliberately not
 * adding `glob` as a fourth coupled override: glob@13's CJS build sets
 * `__esModule: true` without a `default` export, which breaks Jest's
 * `_interopRequireDefault` in consuming packages; test-exclude@8 already
 * pulls glob ^13.0.6 itself where it needs it.)
 *
 * ── Advisory floor guard (curated CVEs) ────────────────────────────────────
 *
 * Two consecutive security releases from this monorepo (domain-router 0.1.2
 * brace-expansion/glob, 0.1.3 js-yaml GHSA-5p4m-2wfm-xmqj) raised a DECLARED
 * dependency floor without any CI gate asserting the floor stuck. A revert of
 * that floor stays green everywhere that matters for CI: `npm audit` reads
 * package-lock.json, not the declared range, and the lockfile can (and, when
 * measured, did) keep resolving the patched version even after the declared
 * floor was reverted — so the revert is invisible to every existing check.
 *
 * `collectAdvisoryFloorViolations` closes this the same way the
 * brace-expansion coupling guard above closes its class: a small, hand-
 * curated table (`ADVISORY_FLOOR_TABLE`) of package name -> closed vulnerable
 * range for CVEs this repo has actually shipped a fix for. For every entry in
 * that table, asserts that neither (a) any `packages/*\/package.json`
 * dependency-field range naming that package, nor (b) the root package.json
 * `overrides` entry for that package (if present, including npm's nested
 * per-subtree `overrides` object shape — see `collectOverrideAdvisoryFloor
 * Violations` below), intersects the vulnerable range via `semver.intersects`
 * — a caret/tilde/exact declaration that can still resolve back into the
 * closed CVE window is a violation, independent of what package-lock.json
 * happens to resolve today. Unlike the brace-expansion coupling guard, this
 * guard has no lockfile ground truth to fall back on, so it is fail-CLOSED
 * for anything it cannot cleanly interpret: a declared or override range for
 * a curated name that isn't parseable semver (an npm alias like
 * `"npm:js-yaml@^4.1.0"`, a git URL, the `"latest"` tag, ...) is reported as
 * its own violation rather than skipped, and an override value for a curated
 * name that is neither a string nor a further nested overrides object is
 * likewise reported rather than silently passed through.
 *
 * Deliberately NOT a general "declared floor must equal/exceed the resolved
 * version" rule: measured against this repo's actual manifests, that shape
 * flags 18 of 20 external runtime deps (chalk, commander, ajv, zod, ...) for
 * ordinary, harmless caret-range practice, making the gate too noisy to keep.
 * Only package names explicitly added to `ADVISORY_FLOOR_TABLE` are ever
 * checked; everything else is silently out of scope for this guard. js-yaml
 * is currently the only curated entry not because it is the only advisory
 * this repo has shipped a floor for, but because it is the only one whose
 * vulnerable range is worth hand-typing here at all: the 0.1.2 release's
 * brace-expansion/glob DoS is already closed structurally, by construction,
 * via `collectOverrideCouplingViolations` / `collectBraceExpansionCoupling
 * Violations` above — adding an approximate vulnerable range for it here
 * from memory would risk a wrong range doing more harm than the gap it
 * would close, for a class this file already handles by a sturdier
 * mechanism.
 *
 * Usage: `node scripts/check-pins.js` (wired as the `check:pins` npm script).
 * Exits non-zero and prints one line per offending package + pin on failure.
 * Also exits non-zero (instead of vacuously passing) if zero workspace
 * packages are found at all, e.g. `packages/` was renamed or emptied and the
 * check would otherwise silently stop checking anything.
 */
const fs = require('fs');
const path = require('path');
const semver = require('semver');

const INTERNAL_SCOPE_PREFIX = '@lannguyensi/';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Reads every packages/*\/package.json under `rootDir` and returns an array
 * of `{ name, version, dependencies, devDependencies, peerDependencies,
 * optionalDependencies }` shapes. Skips any workspace directory that has no
 * package.json.
 */
function loadWorkspacePackages(rootDir) {
  const packagesDir = path.join(rootDir, 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    workspaces.push({
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
      engines: pkg.engines || null,
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      peerDependencies: pkg.peerDependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
    });
  }
  return workspaces;
}

/**
 * Reads the root package.json and returns its `overrides` object (or `{}` if
 * absent).
 */
function loadRootOverrides(rootDir) {
  const pkgJsonPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  return pkg.overrides || {};
}

/**
 * Reads the root package-lock.json and returns its `packages` object (keyed
 * by node_modules path, e.g. `"node_modules/minimatch"` or
 * `"node_modules/test-exclude/node_modules/minimatch"` for a nested
 * resolution) — or `{}` if the lockfile has no `packages` field at all
 * (unexpected for the npm lockfileVersion this repo uses, but handled the
 * same defensive way as an empty workspace list below: a missing field here
 * must not silently skip the coupling check).
 */
function loadLockfilePackages(rootDir) {
  const lockPath = path.join(rootDir, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return lock.packages || {};
}

/**
 * Pure checker: given the array of workspace package shapes (as returned by
 * loadWorkspacePackages, or an equivalent in-memory fixture), returns an
 * array of violation objects. Empty array means every internal pin is
 * consistent.
 *
 * Each violation is one of:
 *   { reason: 'unsatisfied', consumer, field, dependency, pin, workspaceVersion }
 *   { reason: 'unknown-workspace', consumer, field, dependency, pin }
 */
function collectPinViolations(workspacePackages) {
  const versionByName = new Map(workspacePackages.map((pkg) => [pkg.name, pkg.version]));
  const violations = [];

  for (const pkg of workspacePackages) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field] || {};
      for (const [dependency, pin] of Object.entries(deps)) {
        if (!dependency.startsWith(INTERNAL_SCOPE_PREFIX)) continue;

        if (!versionByName.has(dependency)) {
          violations.push({
            reason: 'unknown-workspace',
            consumer: pkg.name,
            field,
            dependency,
            pin,
          });
          continue;
        }

        const workspaceVersion = versionByName.get(dependency);
        // No `includePrerelease`: this is a strict internal-consistency
        // check, so a prerelease sibling (e.g. 0.1.1-rc.1) deliberately does
        // NOT satisfy a range pin like "^0.1.0" — a prerelease should not be
        // treated as an interchangeable stand-in for the range it's cut from.
        if (!semver.satisfies(workspaceVersion, pin)) {
          violations.push({
            reason: 'unsatisfied',
            consumer: pkg.name,
            field,
            dependency,
            pin,
            workspaceVersion,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Engines policy guard (decision 2026-07-18, uniform baseline):
 *
 *  1. Presence — every PUBLISHED workspace package (`private` !== true)
 *     must declare `engines.node`. The monorepo releases packages
 *     together; a published package without the baseline silently drops
 *     the supported-Node signal for its consumers.
 *  2. Uniformity — every declared `engines.node` value (published or not)
 *     must be identical. `expected` is the modal (most common) declared
 *     value, so the violation message points at the actual outlier, not
 *     at whichever package happens to sort first. On an even split there
 *     is no true majority; the tie breaks to the first-declared value —
 *     arbitrary, but any split is real drift and fails the gate either way.
 *
 * Violations:
 *   { reason: 'engines-missing', consumer }
 *   { reason: 'engines-drift', consumer, enginesNode, expected }
 */
function collectEnginesViolations(workspacePackages) {
  const violations = [];

  for (const pkg of workspacePackages) {
    if (!pkg.private && !(pkg.engines && pkg.engines.node)) {
      violations.push({ reason: 'engines-missing', consumer: pkg.name });
    }
  }

  const declaring = workspacePackages.filter((pkg) => pkg.engines && pkg.engines.node);
  if (declaring.length === 0) return violations;

  const counts = new Map();
  for (const pkg of declaring) {
    counts.set(pkg.engines.node, (counts.get(pkg.engines.node) || 0) + 1);
  }
  let expected = declaring[0].engines.node;
  for (const [value, count] of counts) {
    if (count > counts.get(expected)) expected = value;
  }

  for (const pkg of declaring) {
    if (pkg.engines.node !== expected) {
      violations.push({
        reason: 'engines-drift',
        consumer: pkg.name,
        enginesNode: pkg.engines.node,
        expected,
      });
    }
  }
  return violations;
}

/**
 * Coupled-override guard: brace-expansion / minimatch / test-exclude (see
 * the "Override coupling" section of the file header for the full
 * rationale). Given the root package.json `overrides` object, asserts that
 * if ANY of the three coupled keys is present, ALL three are present — a
 * partial set (e.g. brace-expansion removed but minimatch/test-exclude left
 * behind) is exactly the silent failure mode this guard exists to catch. An
 * overrides block containing NONE of the three keys is not a violation on
 * its own (nothing here asserts the coupled set must exist at all — that is
 * a product decision, not something a pin-consistency script should force).
 *
 * Violation: { reason: 'override-coupling-broken', present, missing }
 */
const COUPLED_OVERRIDE_KEYS = ['brace-expansion', 'minimatch', 'test-exclude'];

function collectOverrideCouplingViolations(overrides) {
  const present = COUPLED_OVERRIDE_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(overrides || {}, key),
  );
  if (present.length === 0 || present.length === COUPLED_OVERRIDE_KEYS.length) {
    return [];
  }
  const missing = COUPLED_OVERRIDE_KEYS.filter((key) => !present.includes(key));
  return [{ reason: 'override-coupling-broken', present, missing }];
}

/**
 * Coupled-override guard, lockfile half: given package-lock.json's
 * `packages` object, finds every resolved `minimatch` and `test-exclude`
 * entry (at any nesting depth — a nested resolution not reached by the root
 * override would be exactly the kind of drift this exists to catch) and, for
 * each one that itself declares a `brace-expansion` dependency, runs two
 * checks:
 *
 *   1. The declared range is confined to 5.x (i.e. does not intersect
 *      anything outside `>=5.0.0 <6.0.0`). A version whose own declared
 *      range reaches outside 5.x predates the named-export migration and
 *      breaks at runtime against the brace-expansion 5.x this repo forces.
 *   2. Even when (1) passes, the EFFECTIVE (actually-installed) brace-
 *      expansion resolved for that consumer — found by walking the nearest-
 *      ancestor `node_modules` chain the same way `require()` would —
 *      actually satisfies that declared range. `overrides` forces a
 *      resolution regardless of what any dependent declares, so a consumer
 *      can declare a perfectly fine 5.x range and still be handed a
 *      pre-5.x brace-expansion at runtime (e.g. brace-expansion overridden
 *      down to `^2.0.2` while minimatch/test-exclude stay pinned forward —
 *      both individual guards elsewhere in this file stay green, npm audit
 *      stays green, and `require('minimatch')` still throws). Check (1)
 *      alone cannot see this: it only reads what minimatch/test-exclude's
 *      own package.json declares, never what actually got installed.
 *
 * An entry with no `brace-expansion` key in its own `dependencies` at all
 * (e.g. some future minimatch major that drops the dependency, or an
 * unrelated package that happens to share the name) has nothing to
 * couple-check and is deliberately NOT a violation — there is no declared
 * range to conflict with the override.
 *
 * Violations:
 *   { reason: 'brace-expansion-out-of-range', key, name, version, range }
 *   { reason: 'brace-expansion-resolved-mismatch', key, name, version, declaredRange, resolvedVersion }
 */
const BRACE_EXPANSION_COUPLED_CONSUMERS = new Set(['minimatch', 'test-exclude']);
const BRACE_EXPANSION_OUTSIDE_5X_RANGE = '<5.0.0 || >=6.0.0';

function lockfilePackageBaseName(key) {
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx === -1) return null; // the root project entry (key === '') has no node_modules segment
  return key.slice(idx + marker.length);
}

/**
 * Given package-lock.json's `packages` map and the lockfile key of a
 * dependent package (e.g. `"node_modules/test-exclude/node_modules/minimatch"`),
 * resolves the EFFECTIVE version of `depName` that a `require(depName)` call
 * from inside that package would actually receive — walking the nearest-
 * ancestor `node_modules` directory chain the same way Node's own module
 * resolution does (a nested `node_modules/<depName>` sitting alongside the
 * consumer wins over one further up, e.g. the root's). Returns `null` if no
 * matching package entry exists anywhere in the ancestor chain.
 */
function resolveEffectiveDependencyVersion(lockfilePackages, consumerKey, depName) {
  const marker = 'node_modules/';
  let dir = consumerKey;
  for (;;) {
    const idx = dir.lastIndexOf(marker);
    if (idx === -1) return null;
    const base = dir.slice(0, idx);
    const candidate = lockfilePackages[`${base}${marker}${depName}`];
    if (candidate) return candidate.version;
    if (base === '') return null;
    dir = base;
  }
}

function collectBraceExpansionCouplingViolations(lockfilePackages) {
  const violations = [];
  for (const [key, entry] of Object.entries(lockfilePackages || {})) {
    const name = lockfilePackageBaseName(key);
    if (!name || !BRACE_EXPANSION_COUPLED_CONSUMERS.has(name)) continue;

    const range = entry && entry.dependencies && entry.dependencies['brace-expansion'];
    if (!range) continue; // no brace-expansion dependency declared at all — nothing to couple-check

    const confinedTo5x = semver.validRange(range) !== null && !semver.intersects(range, BRACE_EXPANSION_OUTSIDE_5X_RANGE);
    if (!confinedTo5x) {
      violations.push({
        reason: 'brace-expansion-out-of-range',
        key,
        name,
        version: entry.version,
        range,
      });
      // The declared range itself is already broken (or not even valid
      // semver) — nothing more to learn from also checking what actually
      // resolved against it.
      continue;
    }

    const resolvedVersion = resolveEffectiveDependencyVersion(lockfilePackages, key, 'brace-expansion');
    if (resolvedVersion && !semver.satisfies(resolvedVersion, range)) {
      violations.push({
        reason: 'brace-expansion-resolved-mismatch',
        key,
        name,
        version: entry.version,
        declaredRange: range,
        resolvedVersion,
      });
    }
  }
  return violations;
}

/**
 * Curated table of CLOSED vulnerable ranges for externally-published
 * dependencies this monorepo has previously shipped a security release for.
 * See the "Advisory floor guard" section of the file header for the full
 * rationale, and in particular why this table is hand-curated rather than
 * derived from any general "floor == resolved" rule.
 *
 * Frozen (table and every entry) so no consumer — a test fixture, another
 * script requiring this module, a future edit elsewhere in this file — can
 * mutate it at runtime and silently weaken what the guard checks.
 *
 * Table shape: { [dependencyName]: { id, vulnerableRange } }.
 */
const ADVISORY_FLOOR_TABLE = Object.freeze(
  Object.fromEntries(
    Object.entries({
      'js-yaml': { id: 'GHSA-5p4m-2wfm-xmqj', vulnerableRange: '<4.3.1' },
    }).map(([name, entry]) => [name, Object.freeze(entry)]),
  ),
);

/**
 * Looks up `dependency` in `ADVISORY_FLOOR_TABLE` via an explicit
 * `hasOwnProperty` check (never a bare `ADVISORY_FLOOR_TABLE[dependency]`
 * lookup) and, if curated, checks `range` against its vulnerable range.
 * Returns `null` when `dependency` isn't curated (nothing to check) or the
 * range is curated-but-clean (parseable and outside the vulnerable range).
 *
 * The `hasOwnProperty` guard matters because `dependency` and `range` are
 * both attacker/data-controlled strings straight out of a `package.json` or
 * `overrides` block: a dependency literally named `"constructor"` (a
 * syntactically valid npm package name) makes a bare bracket lookup return
 * `Object.prototype.constructor` — a truthy, non-`undefined` value — which
 * would then crash `semver.intersects` on `advisory.vulnerableRange` being
 * `undefined` instead of either skipping cleanly or reporting a violation.
 *
 * Returns one of:
 *   - `null` (not curated, or curated and clean)
 *   - `{ reason: 'advisory-floor-unparseable-range', source, dependency,
 *      range, advisoryId, vulnerableRange, consumer?, field? }` — curated,
 *      but `range` isn't parseable semver at all (fail-CLOSED: reported, not
 *      skipped — see the file header for why this differs from the
 *      brace-expansion guard's skip-on-invalid behavior).
 *   - `{ reason: 'advisory-floor-violated', source, dependency, range,
 *      advisoryId, vulnerableRange, consumer?, field? }` — curated, parses,
 *      and intersects the vulnerable range.
 * (`consumer`/`field` are only ever attached for `source: 'declared'`.)
 */
function checkAdvisoryFloorRange({ dependency, range, source, consumer, field }) {
  if (!Object.prototype.hasOwnProperty.call(ADVISORY_FLOOR_TABLE, dependency)) return null;
  const advisory = ADVISORY_FLOOR_TABLE[dependency];

  const base = { source, dependency };
  if (consumer !== undefined) base.consumer = consumer;
  if (field !== undefined) base.field = field;
  base.range = range;
  base.advisoryId = advisory.id;
  base.vulnerableRange = advisory.vulnerableRange;

  if (semver.validRange(range) === null) {
    return { reason: 'advisory-floor-unparseable-range', ...base };
  }
  if (semver.intersects(range, advisory.vulnerableRange)) {
    return { reason: 'advisory-floor-violated', ...base };
  }
  return null;
}

/**
 * Recursively walks a root `package.json` `overrides` object (or a nested
 * subtree of one) and pushes any advisory-floor violation it finds onto
 * `violations`. Handles npm's nested-override shape: a value that is itself
 * a plain object means "overrides scoped to this dependency's own subtree",
 * where a `"."` key inside it overrides the ENCLOSING key's own version, and
 * any other key overrides a (possibly further-nested) dependency by that
 * name somewhere within the enclosing key's subtree. `parentName` is the
 * enclosing key's name (what a `"."` key at this level refers to), or `null`
 * at the root, where a bare `"."` key is not valid npm syntax and resolves
 * to nothing rather than crashing.
 *
 * Never silently drops a curated dependency name regardless of the shape its
 * override value takes: a string leaf goes through `checkAdvisoryFloorRange`
 * (which itself never skips a curated name — see its own doc comment), a
 * plain-object leaf is recursed into, and any other leaf shape (number,
 * `null`, array, ...) attached to a curated name is reported as its own
 * `'advisory-floor-unhandled-override-shape'` violation instead of being
 * silently passed over.
 *
 * Violation (in addition to the two reasons `checkAdvisoryFloorRange` can
 * produce): { reason: 'advisory-floor-unhandled-override-shape', source:
 *   'override', dependency, advisoryId, vulnerableRange }
 */
function collectOverrideAdvisoryFloorViolations(overridesNode, parentName, violations) {
  for (const [key, value] of Object.entries(overridesNode || {})) {
    const effectiveName = key === '.' ? parentName : key;

    if (typeof value === 'string') {
      if (effectiveName) {
        const violation = checkAdvisoryFloorRange({ dependency: effectiveName, range: value, source: 'override' });
        if (violation) violations.push(violation);
      }
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectOverrideAdvisoryFloorViolations(value, key, violations);
      continue;
    }

    if (effectiveName && Object.prototype.hasOwnProperty.call(ADVISORY_FLOOR_TABLE, effectiveName)) {
      const advisory = ADVISORY_FLOOR_TABLE[effectiveName];
      violations.push({
        reason: 'advisory-floor-unhandled-override-shape',
        source: 'override',
        dependency: effectiveName,
        advisoryId: advisory.id,
        vulnerableRange: advisory.vulnerableRange,
      });
    }
  }
}

/**
 * Given the array of workspace package shapes and the root package.json
 * `overrides` object, returns an array of violation objects: one per curated
 * `ADVISORY_FLOOR_TABLE` entry whose vulnerable range is intersected (or
 * whose declared/override range can't even be parsed as semver — see
 * `checkAdvisoryFloorRange`) by either a `packages/*\/package.json`
 * dependency-field range naming that package, or the root `overrides` entry
 * for that package name (including npm's nested per-subtree `overrides`
 * object shape — see `collectOverrideAdvisoryFloorViolations`). An empty
 * array means every curated floor holds.
 *
 * See `checkAdvisoryFloorRange` and `collectOverrideAdvisoryFloorViolations`
 * for the exact violation shapes this can return; every one always carries
 * `dependency`, `advisoryId`, and `vulnerableRange`, and every one except
 * `'advisory-floor-unhandled-override-shape'` also carries `range`.
 */
function collectAdvisoryFloorViolations(workspacePackages, overrides) {
  const violations = [];

  for (const pkg of workspacePackages) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field] || {};
      for (const [dependency, range] of Object.entries(deps)) {
        const violation = checkAdvisoryFloorRange({ dependency, range, source: 'declared', consumer: pkg.name, field });
        if (violation) violations.push(violation);
      }
    }
  }

  collectOverrideAdvisoryFloorViolations(overrides, null, violations);

  return violations;
}

function formatViolation(violation) {
  if (violation.reason === 'engines-missing') {
    return (
      `  - ${violation.consumer} is published (not private) but declares no engines.node — ` +
      `every published package carries the uniform supported-Node baseline.`
    );
  }
  if (violation.reason === 'engines-drift') {
    return (
      `  - ${violation.consumer} declares engines.node "${violation.enginesNode}", ` +
      `but the workspace baseline is "${violation.expected}" — keep the value uniform.`
    );
  }
  if (violation.reason === 'override-coupling-broken') {
    return (
      `  - root package.json overrides declares ${violation.present.join(', ')} but not ` +
      `${violation.missing.join(', ')} — brace-expansion/minimatch/test-exclude are a coupled set ` +
      `(minimatch@10.2.5 and test-exclude@8.0.0 are the first releases consuming brace-expansion 5.x's ` +
      `named \`expand\` export instead of the pre-5.x callable default; a partial set still resolves ` +
      `brace-expansion 5.x and stays audit-green while an older minimatch/test-exclude throws ` +
      `"TypeError: (0 , brace_expansion_1.default) is not a function" at runtime). Add the missing ` +
      `override(s) back, or remove all three together.`
    );
  }
  if (violation.reason === 'brace-expansion-out-of-range') {
    return (
      `  - package-lock.json "${violation.key}" (${violation.name}@${violation.version}) declares a ` +
      `brace-expansion dependency range "${violation.range}" that is not confined to 5.x — a version this ` +
      `old predates brace-expansion 5.x's named \`expand\` export, and throws ` +
      `"TypeError: (0 , brace_expansion_1.default) is not a function" if anything in the tree hands it a ` +
      `brace-expansion 5.x (e.g. via the coupled override set, when one is present). Regenerate ` +
      `package-lock.json so ${violation.name} resolves to a version whose own brace-expansion range is ` +
      `confined to 5.x (add/restore the coupled overrides, or bump ${violation.name} directly).`
    );
  }
  if (violation.reason === 'brace-expansion-resolved-mismatch') {
    return (
      `  - package-lock.json "${violation.key}" (${violation.name}@${violation.version}) declares a ` +
      `brace-expansion dependency range "${violation.declaredRange}" (confined to 5.x), but the brace-expansion ` +
      `actually resolved for it is ${violation.resolvedVersion} — outside that declared range. An ` +
      `\`overrides\` entry forces a resolved version regardless of what ${violation.name} itself declares, so ` +
      `this can stay audit-green and pass the declared-range check above while still throwing at runtime the ` +
      `moment ${violation.name} touches a brace-expansion API it doesn't have. Regenerate package-lock.json ` +
      `against a consistent override set (or resolve the version conflict directly).`
    );
  }
  if (violation.reason === 'advisory-floor-violated') {
    const location =
      violation.source === 'override'
        ? 'root package.json "overrides"'
        : `${violation.consumer} (${violation.field})`;
    return (
      `  - ${location} declares "${violation.dependency}": "${violation.range}", which intersects the ` +
      `closed vulnerable range "${violation.vulnerableRange}" of advisory ${violation.advisoryId} — a ` +
      `declared range this wide can resolve back into the patched CVE window even when the current ` +
      `lockfile happens to resolve above it today. Raise the floor so "${violation.dependency}" no longer ` +
      `intersects "${violation.vulnerableRange}".`
    );
  }
  if (violation.reason === 'advisory-floor-unparseable-range') {
    const location =
      violation.source === 'override'
        ? 'root package.json "overrides"'
        : `${violation.consumer} (${violation.field})`;
    return (
      `  - ${location} declares "${violation.dependency}": "${violation.range}", which is not a semver range ` +
      `this guard can parse (an npm alias, a git URL, a dist-tag, ...) — "${violation.dependency}" is curated ` +
      `for advisory ${violation.advisoryId} (closed range "${violation.vulnerableRange}"), and an unparseable ` +
      `declaration is reported rather than skipped because it could just as easily resolve the vulnerable ` +
      `version under this name as any ordinary range would. Replace it with an explicit semver range that ` +
      `does not intersect "${violation.vulnerableRange}".`
    );
  }
  if (violation.reason === 'advisory-floor-unhandled-override-shape') {
    return (
      `  - root package.json "overrides" entry for "${violation.dependency}" uses a value this guard could ` +
      `not interpret as either a semver range or a nested npm overrides object — "${violation.dependency}" is ` +
      `curated for advisory ${violation.advisoryId} (closed range "${violation.vulnerableRange}"), so this must ` +
      `be resolved into an explicit range rather than left in an unrecognized shape.`
    );
  }
  const location = `${violation.consumer} (${violation.field})`;
  if (violation.reason === 'unknown-workspace') {
    return (
      `  - ${location} pins "${violation.dependency}": "${violation.pin}", ` +
      `but no workspace package named ${violation.dependency} exists.`
    );
  }
  return (
    `  - ${location} pins "${violation.dependency}": "${violation.pin}", which does not ` +
    `match ${violation.dependency}'s current workspace version ${violation.workspaceVersion}.`
  );
}

function main() {
  const rootDir = path.join(__dirname, '..');
  const workspaces = loadWorkspacePackages(rootDir);

  if (workspaces.length === 0) {
    // Fail loudly instead of vacuously passing. If packages/ were ever
    // renamed, moved, or emptied, silently reporting success here would
    // disable this CI gate without anyone noticing.
    console.error(
      'Pin consistency check failed: found 0 workspace packages under packages/. ' +
        'Expected at least one packages/*/package.json; packages/ exists but contains no ' +
        'subdirectory with a package.json (renamed, emptied, or reorganized?).',
    );
    process.exitCode = 1;
    return;
  }

  const overrides = loadRootOverrides(rootDir);
  const lockfilePackages = loadLockfilePackages(rootDir);

  if (Object.keys(lockfilePackages).length === 0) {
    // Fail loudly instead of vacuously passing — mirrors the 0-workspace
    // guard above. loadLockfilePackages() returns `{}` both when
    // package-lock.json has no `packages` field and when that field is an
    // empty object; either way, silently reporting success here would
    // disable the brace-expansion/minimatch/test-exclude coupling guard
    // (and every other lockfile-based check) without anyone noticing.
    console.error(
      'Pin consistency check failed: package-lock.json has 0 entries under "packages". Expected ' +
        'the lockfile\'s ground-truth package list to be non-empty (missing/empty "packages" field?).',
    );
    process.exitCode = 1;
    return;
  }

  const violations = [
    ...collectPinViolations(workspaces),
    ...collectEnginesViolations(workspaces),
    ...collectOverrideCouplingViolations(overrides),
    ...collectBraceExpansionCouplingViolations(lockfilePackages),
    ...collectAdvisoryFloorViolations(workspaces, overrides),
  ];

  if (violations.length > 0) {
    console.error(`Pin consistency check failed (${violations.length} violation(s)):\n`);
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    console.error(
      '\nSee each violation above for its specific fix (an internal pin bump, an engines.node fix, ' +
        'restoring/regenerating the coupled brace-expansion/minimatch/test-exclude overrides, or raising a ' +
        'declared floor past a curated advisory\'s vulnerable range).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Pin consistency check passed: ${workspaces.length} workspace package(s), all internal ` +
      `${INTERNAL_SCOPE_PREFIX}* pins are satisfied by their workspace's current version, engines.node is ` +
      `uniform, the brace-expansion/minimatch/test-exclude override coupling holds, and no curated advisory ` +
      `floor is violated.`,
  );
}

module.exports = {
  loadWorkspacePackages,
  loadRootOverrides,
  loadLockfilePackages,
  collectPinViolations,
  collectEnginesViolations,
  collectOverrideCouplingViolations,
  collectBraceExpansionCouplingViolations,
  collectAdvisoryFloorViolations,
  ADVISORY_FLOOR_TABLE,
};

if (require.main === module) {
  main();
}
