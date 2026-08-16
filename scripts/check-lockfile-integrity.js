#!/usr/bin/env node
/**
 * Lockfile integrity check.
 *
 * Task eefeb6a9: on 2026-07-27, 304 of 603 third-party entries in
 * package-lock.json carried no `resolved` and/or no `integrity` field
 * (the lockfile had apparently been generated at some point offline or
 * against a mirror). `npm ci` cannot verify the checksum of an entry that
 * has no `integrity`, and cannot even fetch one that has no `resolved` URL
 * — for roughly half the dependency tree, `npm ci` was silently trusting
 * whatever tarball a registry handed back instead of verifying it against a
 * pinned hash. By the time this script was written (2026-08-16), a series
 * of unrelated lockfile-touching commits (npm audit fixes, dependency
 * bumps — see git log on package-lock.json) had already narrowed this down
 * to 12 entries: `ansi-styles@4.3.0`, `chalk@4.1.2`, and `commander@11.1.0`,
 * each nested under 4 packages' own `node_modules/` (debug-playbook-engine,
 * domain-router, grounding-wrapper, readme-first-resolver — the four
 * packages pinned to the pre-ESM `chalk`/`commander` majors). Those 12 were
 * repaired by removing their lockfile entries and running `npm install
 * --package-lock-only`, which forces npm to re-fetch full registry metadata
 * for exactly the removed keys while leaving every other resolution alone
 * (verified: the resolved name@version set across the whole lockfile is
 * byte-for-byte identical before and after — no dependency version moved).
 *
 * This script is the CI guard that keeps that fixed state from drifting
 * back: it walks every third-party entry in package-lock.json's `packages`
 * map and asserts each one carries both `resolved` and `integrity`. Without
 * it, nothing stops a future hand-edit, an offline install, or a mirror-
 * backed `npm install` from silently reintroducing unverifiable entries the
 * way the original 304 got there in the first place.
 *
 * ── Scope: what counts as a "third-party entry" ───────────────────────────
 *
 * Every key in `packages` except:
 *   - `""` (the root package.json entry — this repo itself, not a
 *     third-party install).
 *   - Any key that does not contain `node_modules` (a workspace package's
 *     own root entry, e.g. `packages/claim-gate` — this repo's own code,
 *     not a third-party install).
 *   - Any entry with `link: true` (a local workspace symlink, e.g.
 *     `node_modules/@lannguyensi/claim-gate` pointing at
 *     `packages/claim-gate`). npm never assigns `resolved`/`integrity` to a
 *     local symlink by design — there is nothing to fetch or hash — so
 *     flagging these would be a permanent false positive, not a real gap.
 *
 * This matches both hoisted entries (`node_modules/chalk`) and per-package
 * nested entries (`packages/domain-router/node_modules/chalk`) — a
 * dependency nested under one package because a sibling needs a different
 * major version is exactly as much a real third-party install as a hoisted
 * one, and needs the same verification.
 *
 * ── ALLOWLIST ───────────────────────────────────────────────────────────
 *
 * Deliberate escape hatch for a third-party entry that genuinely cannot
 * carry `resolved`/`integrity` for a documented reason (e.g. a package
 * pulled from a source that does not publish either field, such as a git
 * dependency pinned by commit rather than a tarball). Empty today — every
 * third-party entry in this repo's package-lock.json carries both fields as
 * of the eefeb6a9 regeneration. Every entry here needs an explicit `reason`
 * — this is meant to stay small and auditable, not become a blanket
 * suppression list that quietly re-legitimizes the exact drift this script
 * exists to catch.
 *
 * Shape: { key: 'node_modules/some-legacy-pkg', reason: '...' }
 */
const fs = require('fs');
const path = require('path');

const ALLOWLIST = [];

/**
 * Given a parsed package-lock.json object, returns every third-party entry
 * from its `packages` map as `{ key, value }` pairs — see the "Scope"
 * section in the file header for exactly what is included/excluded. Pure
 * function of the parsed lockfile object, so it is safe to unit test with
 * in-memory fixtures.
 */
function collectThirdPartyEntries(lock) {
  const pkgs = (lock && lock.packages) || {};
  const entries = [];
  for (const [key, value] of Object.entries(pkgs)) {
    if (key === '') continue;
    if (!key.includes('node_modules')) continue;
    if (value.link) continue;
    entries.push({ key, value });
  }
  return entries;
}

/**
 * Pure checker: given the array of third-party entries (as returned by
 * collectThirdPartyEntries, or an equivalent in-memory fixture) and an
 * allowlist array, returns an array of violation objects. Empty array means
 * every checked entry carries both `resolved` and `integrity`.
 *
 * Each violation: { key, missing: ['resolved'] | ['integrity'] |
 * ['resolved', 'integrity'] }
 */
function collectIntegrityViolations(entries, allowlist = ALLOWLIST) {
  const allowedKeys = new Set(allowlist.map((entry) => entry.key));
  const violations = [];
  for (const { key, value } of entries) {
    if (allowedKeys.has(key)) continue;
    const missing = [];
    if (!value.resolved) missing.push('resolved');
    if (!value.integrity) missing.push('integrity');
    if (missing.length > 0) violations.push({ key, missing });
  }
  return violations;
}

/**
 * Pure helper: returns how many third-party entries would actually be
 * evaluated by collectIntegrityViolations for the given entries and
 * allowlist — i.e. excluding allowlisted keys. Used by run() to guard
 * against a vacuously-green run (see file header's ALLOWLIST section and
 * run()'s zero-checked guard below).
 */
function countCheckedEntries(entries, allowlist = ALLOWLIST) {
  const allowedKeys = new Set(allowlist.map((entry) => entry.key));
  return entries.filter((entry) => !allowedKeys.has(entry.key)).length;
}

function formatViolation(violation) {
  return `  - ${violation.key}: missing ${violation.missing.join(' and ')}`;
}

/**
 * CLI core: runs the full check against `rootDir` (a repo root containing a
 * `package-lock.json`, in the same shape as this repo — or a disposable
 * fixture root in tests) and returns the process exit code it should
 * produce (`0` pass, `1` fail), printing the same pass/fail messages
 * `main()` always has. Pulled out of `main()` so tests can assert on the
 * exit code directly, matching the check-pins.js / check-deps.js pattern in
 * this same scripts/ directory.
 *
 * `rootDir` defaults to this script's own repo root (`path.join(__dirname,
 * '..')`), matching `main()`'s behavior when called with no argument.
 */
function run(rootDir = path.join(__dirname, '..')) {
  const lockPath = path.join(rootDir, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entries = collectThirdPartyEntries(lock);

  if (entries.length === 0) {
    // Fail loudly instead of vacuously passing — mirrors check-pins.js's and
    // check-deps.js's zero-workspace/zero-dependency guards. If the lockfile
    // format or layout ever changed enough that collectThirdPartyEntries
    // found nothing, silently reporting success here would disable this CI
    // gate without anyone noticing.
    console.error(
      'Lockfile integrity check failed: found 0 third-party entries in package-lock.json\'s ' +
        '"packages" map. Expected at least one node_modules entry — has the lockfile format ' +
        'changed, or is package-lock.json empty/malformed?',
    );
    return 1;
  }

  const checkedCount = countCheckedEntries(entries);
  if (checkedCount === 0) {
    // Same fail-loud principle applied to the checked count: if the
    // ALLOWLIST ever grew to cover every third-party entry, this check
    // would otherwise vacuously pass without checking anything at all.
    console.error(
      `Lockfile integrity check failed: 0 third-party entries left to check across ${entries.length} ` +
        'found (after excluding the ALLOWLIST in scripts/check-lockfile-integrity.js). Expected at ' +
        'least one unallowlisted third-party entry.',
    );
    return 1;
  }

  const violations = collectIntegrityViolations(entries);

  if (violations.length > 0) {
    console.error(
      `Lockfile integrity check failed (${violations.length} entr${violations.length === 1 ? 'y' : 'ies'} ` +
        'missing resolved/integrity):\n',
    );
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    console.error(
      '\nFix: remove the affected key(s) from package-lock.json\'s "packages" map and run ' +
        '`npm install --package-lock-only` to force npm to re-fetch full registry metadata for ' +
        'exactly those entries (see task eefeb6a9). Before/after, diff the resolved name@version set ' +
        'across the whole lockfile to confirm no dependency version moved. If an entry genuinely ' +
        'cannot carry resolved/integrity, add it to the ALLOWLIST in scripts/check-lockfile-integrity.js ' +
        'with a documented reason instead of leaving it unexplained.',
    );
    return 1;
  }

  console.log(
    `Lockfile integrity check passed: ${checkedCount} third-party entry(ies) in package-lock.json ` +
      'all carry resolved + integrity.',
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  collectThirdPartyEntries,
  collectIntegrityViolations,
  countCheckedEntries,
  run,
  ALLOWLIST,
};

if (require.main === module) {
  main();
}
