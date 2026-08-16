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
 * exists to catch. `run()` validates at startup that every entry actually
 * carries a non-empty string `key` and `reason` — an entry missing either is
 * itself a failure, not a silent no-op.
 *
 * Shape: { key: 'node_modules/some-legacy-pkg', reason: '...' }
 */
const fs = require('fs');
const path = require('path');

const ALLOWLIST = [];

/**
 * A `link: true` entry is only a genuine npm workspace symlink (see the
 * "Scope" section above) if its `resolved` field is a relative workspace
 * path that itself exists as a key in the same lockfile's `packages` map
 * (e.g. `node_modules/@lannguyensi/claim-gate`'s `resolved: "packages/claim-
 * gate"` names `packages/claim-gate`, which is itself a packages map key —
 * that package's own root entry). Without this check, `link: true` was a
 * free unconditional skip: an entry with `resolved`/`integrity` stripped and
 * `link: true` added bypassed the check entirely regardless of what (if
 * anything) `resolved` pointed at, silently re-legitimizing the exact
 * unverifiable-entry drift this script exists to catch (empirically
 * confirmed against this repo's real lockfile — a one-key edit like that
 * still reported an all-green pass, just for one fewer entry).
 */
function isValidWorkspaceLinkTarget(resolved, pkgs) {
  if (typeof resolved !== 'string' || resolved.length === 0) return false;
  if (resolved.startsWith('/') || resolved.startsWith('.')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resolved)) return false; // not a URL
  return Object.prototype.hasOwnProperty.call(pkgs || {}, resolved);
}

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
    if (!value || typeof value !== 'object') {
      // Malformed entry (null, array, primitive) — cannot carry
      // resolved/integrity by definition, and dereferencing `.link` on it
      // below would throw. Push it through as an ordinary entry with an
      // empty value so it surfaces downstream as a normal "missing resolved
      // and integrity" violation naming this key, instead of an uncaught
      // TypeError with no indication which key caused it.
      entries.push({ key, value: {} });
      continue;
    }
    if (value.link) {
      // A genuine npm workspace symlink is skipped — see the "Scope"
      // section in the file header and isValidWorkspaceLinkTarget's doc
      // comment. Anything claiming `link: true` without a resolved target
      // that actually names a workspace package falls through and is
      // checked (and will fail) like any other third-party entry.
      if (isValidWorkspaceLinkTarget(value.resolved, pkgs)) continue;
    }
    entries.push({ key, value });
  }
  return entries;
}

/**
 * Pure helper: counts how many entries in `lock`'s `packages` map are
 * `link: true` entries that validate as genuine npm workspace symlinks (see
 * isValidWorkspaceLinkTarget) — i.e. entries collectThirdPartyEntries
 * legitimately excludes rather than including as a checkable/violatable
 * third-party entry. Used only for the pass-message skip count in run(); has
 * no effect on the violation/exit-code logic itself.
 */
function countSkippedWorkspaceLinks(lock) {
  const pkgs = (lock && lock.packages) || {};
  let count = 0;
  for (const [key, value] of Object.entries(pkgs)) {
    if (key === '') continue;
    if (!key.includes('node_modules')) continue;
    if (value && typeof value === 'object' && value.link && isValidWorkspaceLinkTarget(value.resolved, pkgs)) {
      count++;
    }
  }
  return count;
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
    if (value && value.link) {
      // Only reaches this loop when collectThirdPartyEntries could not
      // validate this link entry's target as a real workspace package (a
      // genuine symlink is filtered out upstream) — e.g. `resolved` is
      // missing, isn't a relative path, or doesn't name an actual entry in
      // packages. Flag it as its own violation rather than falling through
      // to the resolved/integrity check below, which a forged entry could
      // otherwise satisfy with fabricated values.
      violations.push({
        key,
        missing: ['a valid workspace link target (resolved must reference an existing packages/* entry)'],
      });
      continue;
    }
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
 * Pure guard: returns true iff `entry` is a well-formed ALLOWLIST entry — a
 * non-empty string `key` and a non-empty string `reason`. The ALLOWLIST's
 * doc comment documents `reason` as mandatory; this is what actually
 * enforces that instead of leaving it a convention nobody checks.
 */
function isValidAllowlistEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof entry.key === 'string' &&
      entry.key.trim().length > 0 &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0,
  );
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
 * `allowlist` defaults to the module-level ALLOWLIST, matching `main()`'s
 * behavior when called with no argument; tests inject a fixture allowlist so
 * the zero-checked guard and the allowlist-shape guard below are actually
 * reachable without editing the module-level ALLOWLIST.
 */
function run(rootDir = path.join(__dirname, '..'), allowlist = ALLOWLIST) {
  const invalidAllowlistEntries = allowlist.filter((entry) => !isValidAllowlistEntry(entry));
  if (invalidAllowlistEntries.length > 0) {
    console.error(
      `Lockfile integrity check failed: ${invalidAllowlistEntries.length} ALLOWLIST entr${invalidAllowlistEntries.length === 1 ? 'y' : 'ies'} ` +
        'in scripts/check-lockfile-integrity.js missing a non-empty string `key` and/or `reason`:\n',
    );
    for (const entry of invalidAllowlistEntries) {
      console.error(`  - ${JSON.stringify(entry)}`);
    }
    console.error(
      '\nEvery ALLOWLIST entry needs an explicit { key: <non-empty string>, reason: <non-empty string> } — ' +
        'see the ALLOWLIST section in this file\'s header comment.',
    );
    return 1;
  }

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

  const checkedCount = countCheckedEntries(entries, allowlist);
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

  const violations = collectIntegrityViolations(entries, allowlist);

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

  const skippedLinkCount = countSkippedWorkspaceLinks(lock);
  console.log(
    `Lockfile integrity check passed: ${checkedCount} checked, ${skippedLinkCount} workspace link(s) ` +
      `skipped — all ${checkedCount} checked third-party entry(ies) in package-lock.json carry resolved + ` +
      'integrity.',
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
  countSkippedWorkspaceLinks,
  isValidAllowlistEntry,
  run,
  ALLOWLIST,
};

if (require.main === module) {
  main();
}
