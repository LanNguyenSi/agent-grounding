/**
 * Unit tests for the pure checkers in check-lockfile-integrity.js.
 *
 * Runs against in-memory fixtures and disposable temp directories (never
 * this repo's actual package-lock.json for the negative-control cases), so
 * these tests can safely include a deliberately-manipulated "missing
 * integrity" fixture without touching the real lockfile. Uses Node's
 * built-in test runner (`node --test`), matching check-pins.test.js /
 * check-deps.test.js in this same scripts/ directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectThirdPartyEntries,
  collectIntegrityViolations,
  countCheckedEntries,
  countSkippedWorkspaceLinks,
  isValidAllowlistEntry,
  run,
} = require('./check-lockfile-integrity');

// ── collectThirdPartyEntries ───────────────────────────────────────────────

test('collectThirdPartyEntries: excludes the root ("") entry', () => {
  const lock = {
    packages: {
      '': { name: 'agent-grounding', version: '0.1.0' },
      'node_modules/chalk': { version: '5.6.2', resolved: 'x', integrity: 'y' },
    },
  };
  const entries = collectThirdPartyEntries(lock);
  assert.deepEqual(entries.map((e) => e.key), ['node_modules/chalk']);
});

test('collectThirdPartyEntries: excludes a workspace package\'s own root entry (no node_modules in key)', () => {
  const lock = {
    packages: {
      '': { name: 'agent-grounding' },
      'packages/claim-gate': { name: '@lannguyensi/claim-gate', version: '0.6.0' },
      'node_modules/chalk': { version: '5.6.2', resolved: 'x', integrity: 'y' },
    },
  };
  const entries = collectThirdPartyEntries(lock);
  assert.deepEqual(entries.map((e) => e.key), ['node_modules/chalk']);
});

test('collectThirdPartyEntries: excludes local workspace symlinks (link: true) with a valid resolved target', () => {
  const lock = {
    packages: {
      '': { name: 'agent-grounding' },
      // The link's resolved target ("packages/claim-gate") must itself be a
      // key in the packages map for the link to validate as genuine — see
      // isValidWorkspaceLinkTarget.
      'packages/claim-gate': { name: '@lannguyensi/claim-gate', version: '0.6.0' },
      'node_modules/@lannguyensi/claim-gate': { resolved: 'packages/claim-gate', link: true },
      'node_modules/chalk': { version: '5.6.2', resolved: 'x', integrity: 'y' },
    },
  };
  const entries = collectThirdPartyEntries(lock);
  assert.deepEqual(entries.map((e) => e.key), ['node_modules/chalk']);
});

test('collectThirdPartyEntries: an invalid link entry (resolved does not name a real packages/* entry) is NOT excluded', () => {
  // Reproduces the link-bypass finding: a forged/manipulated entry with
  // `link: true` but no resolved target that actually names a workspace
  // package must fall through to being checked (and flagged) like any other
  // third-party entry, instead of getting a free unconditional skip.
  const lock = {
    packages: {
      '': { name: 'agent-grounding' },
      'node_modules/forged-link': { link: true },
      'node_modules/chalk': { version: '5.6.2', resolved: 'x', integrity: 'y' },
    },
  };
  const entries = collectThirdPartyEntries(lock);
  assert.deepEqual(entries.map((e) => e.key), ['node_modules/forged-link', 'node_modules/chalk']);
});

test('collectThirdPartyEntries: a malformed (null) entry value is included as a normal entry, not a crash', () => {
  const lock = {
    packages: {
      '': { name: 'agent-grounding' },
      'node_modules/malformed': null,
      'node_modules/chalk': { version: '5.6.2', resolved: 'x', integrity: 'y' },
    },
  };
  const entries = collectThirdPartyEntries(lock);
  assert.deepEqual(entries.map((e) => e.key), ['node_modules/malformed', 'node_modules/chalk']);
});

test('collectThirdPartyEntries: includes nested per-package entries (e.g. packages/x/node_modules/y)', () => {
  const lock = {
    packages: {
      '': { name: 'agent-grounding' },
      'packages/domain-router/node_modules/chalk': { version: '4.1.2', resolved: 'x', integrity: 'y' },
    },
  };
  const entries = collectThirdPartyEntries(lock);
  assert.deepEqual(entries.map((e) => e.key), ['packages/domain-router/node_modules/chalk']);
});

test('collectThirdPartyEntries: an empty packages map yields no entries', () => {
  assert.deepEqual(collectThirdPartyEntries({ packages: {} }), []);
});

test('collectThirdPartyEntries: a lockfile with no packages map at all yields no entries, not a crash', () => {
  assert.deepEqual(collectThirdPartyEntries({}), []);
});

// ── collectIntegrityViolations (main pure core) ────────────────────────────

test('passes when every third-party entry carries resolved + integrity', () => {
  const entries = [
    { key: 'node_modules/chalk', value: { resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz', integrity: 'sha512-abc' } },
  ];
  assert.deepEqual(collectIntegrityViolations(entries), []);
});

test('negative control: flags an entry missing both resolved and integrity', () => {
  // Reproduces the exact bug class from task eefeb6a9: an entry with a
  // version but no resolved/integrity, as found in package-lock.json before
  // the eefeb6a9 regeneration (e.g. the 12
  // packages/*/node_modules/{ansi-styles,chalk,commander} entries).
  const entries = [
    { key: 'packages/domain-router/node_modules/chalk', value: { version: '4.1.2', license: 'MIT' } },
  ];
  const violations = collectIntegrityViolations(entries);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    key: 'packages/domain-router/node_modules/chalk',
    missing: ['resolved', 'integrity'],
  });
});

test('negative control: flags an entry missing only integrity', () => {
  const entries = [
    { key: 'node_modules/some-pkg', value: { version: '1.0.0', resolved: 'https://registry.npmjs.org/some-pkg/-/some-pkg-1.0.0.tgz' } },
  ];
  const violations = collectIntegrityViolations(entries);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { key: 'node_modules/some-pkg', missing: ['integrity'] });
});

test('negative control: flags an entry missing only resolved', () => {
  const entries = [
    { key: 'node_modules/some-pkg', value: { version: '1.0.0', integrity: 'sha512-abc' } },
  ];
  const violations = collectIntegrityViolations(entries);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { key: 'node_modules/some-pkg', missing: ['resolved'] });
});

test('reports one violation per broken entry across a mixed tree', () => {
  const entries = [
    { key: 'node_modules/a', value: { version: '1.0.0' } },
    { key: 'node_modules/b', value: { version: '1.0.0', resolved: 'x', integrity: 'y' } },
    { key: 'node_modules/c', value: { version: '1.0.0', resolved: 'x' } },
  ];
  const violations = collectIntegrityViolations(entries);
  assert.deepEqual(
    violations.map((v) => v.key),
    ['node_modules/a', 'node_modules/c'],
  );
});

test('allowlist: an explicitly allowlisted key is not flagged', () => {
  const entries = [{ key: 'node_modules/legacy-pkg', value: { version: '1.0.0' } }];
  const allowlist = [{ key: 'node_modules/legacy-pkg', reason: 'git dependency, no registry tarball' }];
  assert.deepEqual(collectIntegrityViolations(entries, allowlist), []);
});

test('allowlist: only exempts the exact key, not every entry', () => {
  const entries = [
    { key: 'node_modules/legacy-pkg', value: { version: '1.0.0' } },
    { key: 'node_modules/other-pkg', value: { version: '1.0.0' } },
  ];
  const allowlist = [{ key: 'node_modules/legacy-pkg', reason: 'git dependency, no registry tarball' }];
  const violations = collectIntegrityViolations(entries, allowlist);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, 'node_modules/other-pkg');
});

// ── countCheckedEntries / vacuous-green guard ──────────────────────────────

test('countCheckedEntries: counts entries, excludes allowlisted ones', () => {
  const entries = [
    { key: 'node_modules/a', value: {} },
    { key: 'node_modules/b', value: {} },
  ];
  const allowlist = [{ key: 'node_modules/b', reason: 'x' }];
  assert.equal(countCheckedEntries(entries, allowlist), 1);
});

test('countCheckedEntries: zero when the allowlist covers every entry', () => {
  const entries = [{ key: 'node_modules/a', value: {} }];
  const allowlist = [{ key: 'node_modules/a', reason: 'x' }];
  // This is exactly the input that must make run() (the CLI entrypoint)
  // exit non-zero via the zero-checked guard instead of vacuously reporting
  // success — see the corresponding run() test below.
  assert.equal(countCheckedEntries(entries, allowlist), 0);
});

// ── run(rootDir) (CLI core, exit code, against real temp fixture lockfiles) ─
// Exercises the CLI entrypoint's pure exit-code core end to end against
// real (but temporary, disposable) package-lock.json files on disk — the
// actual thing main() calls and turns into process.exitCode.

function writeFixtureLock(tmpRoot, packages) {
  fs.writeFileSync(
    path.join(tmpRoot, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }, null, 2),
  );
}

test('run(): a lockfile where every third-party entry carries resolved + integrity exits 0', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-clean-'));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    assert.equal(run(tmpRoot), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control — a manipulated entry missing integrity turns the check red (exit 1)', () => {
  // Directly reproduces the task's required negative control: take an
  // otherwise-clean fixture, strip `integrity` from one third-party entry,
  // and confirm run() now exits 1. This never touches the real repo
  // package-lock.json — the manipulation lives entirely in a disposable
  // temp directory.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-negctrl-'));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        // integrity deliberately omitted — the manipulated entry.
      },
    });
    const originalError = console.error;
    const errorMessages = [];
    console.error = (...args) => errorMessages.push(args.join(' '));
    try {
      const exitCode = run(tmpRoot);
      assert.equal(exitCode, 1);
      assert.ok(
        errorMessages.some((m) => m.includes('node_modules/chalk') && m.includes('integrity')),
        `expected the violation message to name the manipulated entry, got: ${JSON.stringify(errorMessages)}`,
      );
    } finally {
      console.error = originalError;
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a link:true workspace entry with a valid resolved target does NOT turn the check red', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-link-'));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'packages/claim-gate': { name: '@lannguyensi/claim-gate', version: '0.6.0' },
      'node_modules/@lannguyensi/claim-gate': { resolved: 'packages/claim-gate', link: true },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    assert.equal(run(tmpRoot), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): the pass message reports the checked count and the workspace-link skip count', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-skip-msg-'));
  const originalLog = console.log;
  const logMessages = [];
  console.log = (...args) => logMessages.push(args.join(' '));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'packages/claim-gate': { name: '@lannguyensi/claim-gate', version: '0.6.0' },
      'node_modules/@lannguyensi/claim-gate': { resolved: 'packages/claim-gate', link: true },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    assert.equal(run(tmpRoot), 0);
    assert.ok(
      logMessages.some((m) => m.includes('1 checked') && m.includes('1 workspace link(s) skipped')),
      `expected the pass message to report the checked and skipped-link counts, got: ${JSON.stringify(logMessages)}`,
    );
  } finally {
    console.log = originalLog;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a link:true entry whose resolved target is not a real workspace package IS flagged (link-bypass guard)', () => {
  // Reproduces the finding: a manipulated entry with resolved/integrity
  // stripped and link:true added must NOT silently pass — the whole point
  // of link:true being a free skip is that a genuine npm workspace symlink
  // has nothing to fetch or hash; a forged entry claiming the same shape
  // without a real workspace target is exactly the drift this check exists
  // to catch.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-link-bypass-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'node_modules/forged-link': { link: true },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    const exitCode = run(tmpRoot);
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('node_modules/forged-link') && m.includes('workspace link target')),
      `expected the forged link entry to be flagged by key, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a malformed (null) package entry is flagged as a normal violation naming the key, not an uncaught crash', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-malformed-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'node_modules/malformed': null,
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    const exitCode = run(tmpRoot);
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('node_modules/malformed') && m.includes('resolved') && m.includes('integrity')),
      `expected the malformed entry to be flagged by key, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): zero third-party entries exits 1 via the zero-entries guard specifically', () => {
  // Exit-code-alone is not enough here: with 0 entries, countCheckedEntries()
  // is always 0 too, so the SECOND (zero-checked) guard would independently
  // return 1 for this exact input even if the FIRST (zero-entries) guard
  // were disabled. Capturing console.error and pinning the zero-entries
  // guard's specific message distinguishes the two, matching the pattern in
  // check-deps.test.js's equivalent guard test.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-empty-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    writeFixtureLock(tmpRoot, { '': { name: 'fixture' } });
    const exitCode = run(tmpRoot);
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('found 0 third-party entries')),
      `expected the zero-entries guard's message, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): an allowlist covering every entry exits 1 via the zero-checked guard (vacuous-green)', () => {
  // run() now accepts an injectable allowlist (second argument), so this
  // exercises the zero-checked guard directly against a real run() call
  // instead of only documenting its intent: a one-entry fixture lockfile
  // whose single third-party entry is fully covered by the injected
  // allowlist must make run() exit 1 via the zero-checked guard specifically
  // (not vacuously report success because "everything allowlisted" looks
  // green from collectIntegrityViolations' point of view).
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-allowlist-vacuous-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    const allowlist = [{ key: 'node_modules/chalk', reason: 'test: exercises the zero-checked guard' }];
    const exitCode = run(tmpRoot, allowlist);
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('third-party entries left to check')),
      `expected the zero-checked guard's message, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── ALLOWLIST entry shape validation (key + reason required) ──────────────

test('isValidAllowlistEntry: accepts a well-formed entry, rejects missing/empty key or reason', () => {
  assert.equal(isValidAllowlistEntry({ key: 'node_modules/x', reason: 'documented reason' }), true);
  assert.equal(isValidAllowlistEntry({ key: '', reason: 'documented reason' }), false);
  assert.equal(isValidAllowlistEntry({ key: '   ', reason: 'documented reason' }), false);
  assert.equal(isValidAllowlistEntry({ key: 'node_modules/x', reason: '' }), false);
  assert.equal(isValidAllowlistEntry({ key: 'node_modules/x' }), false);
  assert.equal(isValidAllowlistEntry({ reason: 'documented reason' }), false);
  assert.equal(isValidAllowlistEntry(null), false);
});

test('run(): an ALLOWLIST entry with an empty reason is rejected (exit 1) before checking the lockfile', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-allowlist-reason-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    const allowlist = [{ key: 'node_modules/chalk', reason: '' }];
    const exitCode = run(tmpRoot, allowlist);
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('ALLOWLIST') && m.includes('key') && m.includes('reason')),
      `expected the invalid-allowlist-entry guard to fire, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): an ALLOWLIST entry with a missing key is rejected (exit 1) before checking the lockfile', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-lockfile-integrity-allowlist-key-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    writeFixtureLock(tmpRoot, {
      '': { name: 'fixture' },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        integrity: 'sha512-abc',
      },
    });
    const allowlist = [{ reason: 'no key on this entry' }];
    const exitCode = run(tmpRoot, allowlist);
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('ALLOWLIST') && m.includes('key') && m.includes('reason')),
      `expected the invalid-allowlist-entry guard to fire, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── countSkippedWorkspaceLinks ─────────────────────────────────────────────

test('countSkippedWorkspaceLinks: counts only link entries whose resolved target is a real packages/* key', () => {
  const lock = {
    packages: {
      '': { name: 'agent-grounding' },
      'packages/claim-gate': { name: '@lannguyensi/claim-gate', version: '0.6.0' },
      'node_modules/@lannguyensi/claim-gate': { resolved: 'packages/claim-gate', link: true },
      'node_modules/forged-link': { link: true },
      'node_modules/chalk': { version: '5.6.2', resolved: 'x', integrity: 'y' },
    },
  };
  assert.equal(countSkippedWorkspaceLinks(lock), 1);
});

// ── Sanity check against the real repo ─────────────────────────────────────
// Not a substitute for running `npm run check:lockfile-integrity` in CI
// (that's the real gate), but confirms the checker runs cleanly end-to-end
// against this repo's actual package-lock.json and finds the expected
// number of third-party entries, none of them broken.

test('run(): the real repo package-lock.json passes with a plausible number of checked entries', () => {
  const rootDir = path.join(__dirname, '..');
  const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
  const entries = collectThirdPartyEntries(lock);
  // Sanity floor, not an exact pin: this repo had 603 third-party entries
  // at the time this test was written (task eefeb6a9). A loader bug that
  // silently returned near-nothing (e.g. 1 entry) would pass a bare `> 0`
  // check but still be broken — this floor catches that without hardcoding
  // an exact count that would need updating on every dependency change.
  assert.ok(
    entries.length > 100,
    `expected a substantial number of third-party lockfile entries, got ${entries.length}`,
  );
  assert.equal(run(rootDir), 0);
});
