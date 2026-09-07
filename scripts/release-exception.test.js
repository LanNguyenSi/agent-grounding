/**
 * Unit tests for the pure `classify` release-exception checker in
 * release-exception.js.
 *
 * The two "real PR" fixtures use the exact changed-file lists of PR #190
 * (understanding-gate 0.5.0, pure) and PR #215 (grounding-mcp 0.11.0, NOT
 * pure), captured via `gh pr view <n> --repo LanNguyenSi/agent-grounding
 * --json files` (read-only, no repo state changed). Uses Node's built-in
 * test runner (`node --test`), matching this repo's other root scripts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  classify,
  classifyPullFiles,
  isUnsafePath,
  isAllowedReleasePath,
} = require('./release-exception');

const SCRIPT_PATH = path.join(__dirname, 'release-exception.js');

// PR #190 (understanding-gate-v0.5.0), captured via `gh pr view 190
// --repo LanNguyenSi/agent-grounding --json files`.
const PR_190_FILES = [
  'package-lock.json',
  'packages/understanding-gate/CHANGELOG.md',
  'packages/understanding-gate/package.json',
];

// PR #215 (grounding-mcp-v0.11.0), captured the same way.
const PR_215_FILES = [
  'docs/okf/evidence-ledger-session-key-shapes.md',
  'docs/okf/grounding-stack-overview.md',
  'docs/okf/hypothesis-tracker-persistence-split.md',
  'docs/okf/log.md',
  'docs/okf/solution-acceptance-verdict-contract.md',
  'package-lock.json',
  'packages/grounding-mcp/CHANGELOG.md',
  'packages/grounding-mcp/package.json',
  'packages/grounding-mcp/src/server.ts',
];

test('PR #190 (understanding-gate 0.5.0): pure release', () => {
  const verdict = classify(PR_190_FILES);
  assert.equal(verdict.pure_release, true);
  assert.deepEqual(verdict.allowed.sort(), [...PR_190_FILES].sort());
  assert.deepEqual(verdict.rejected, []);
});

test('PR #215 (grounding-mcp 0.11.0): NOT pure, source + docs rejected by name', () => {
  const verdict = classify(PR_215_FILES);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.allowed.sort(), [
    'package-lock.json',
    'packages/grounding-mcp/CHANGELOG.md',
    'packages/grounding-mcp/package.json',
  ]);
  assert.deepEqual(
    verdict.rejected.sort(),
    [
      'docs/okf/evidence-ledger-session-key-shapes.md',
      'docs/okf/grounding-stack-overview.md',
      'docs/okf/hypothesis-tracker-persistence-split.md',
      'docs/okf/log.md',
      'docs/okf/solution-acceptance-verdict-contract.md',
      'packages/grounding-mcp/src/server.ts',
    ].sort(),
  );
});

test('negative control: an otherwise-pure list plus one .ts file is NOT pure', () => {
  const files = [
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'packages/grounding-mcp/src/server.ts',
  ];
  const verdict = classify(files);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['packages/grounding-mcp/src/server.ts']);
  assert.deepEqual(verdict.allowed.sort(), [
    'CHANGELOG.md',
    'package-lock.json',
    'package.json',
  ]);
});

test('nested package path (two segments) is rejected, not pure', () => {
  const verdict = classify(['packages/a/b/package.json']);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['packages/a/b/package.json']);
});

test('the workflow file alone is rejected, not pure', () => {
  const verdict = classify(['.github/workflows/merge-approval.yml']);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['.github/workflows/merge-approval.yml']);
});

test('empty file list is NOT pure', () => {
  const verdict = classify([]);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.allowed, []);
  assert.deepEqual(verdict.rejected, []);
});

test('a path with a ".." traversal segment is rejected, not pure', () => {
  const verdict = classify(['packages/../package.json']);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['packages/../package.json']);
});

test('a leading-slash (absolute) path is rejected, not pure', () => {
  const verdict = classify(['/package.json']);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['/package.json']);
});

test('classify() throws TypeError on a non-array input (caller bug, not a verdict)', () => {
  assert.throws(() => classify('package.json'), TypeError);
  assert.throws(() => classify(null), TypeError);
  assert.throws(() => classify(undefined), TypeError);
});

test('isUnsafePath / isAllowedReleasePath: exported helpers agree with classify()', () => {
  assert.equal(isUnsafePath('/etc/passwd'), true);
  assert.equal(isUnsafePath('a/../b'), true);
  assert.equal(isUnsafePath('package.json'), false);
  assert.equal(isAllowedReleasePath('package.json'), true);
  assert.equal(isAllowedReleasePath('packages/foo/package.json'), true);
  assert.equal(isAllowedReleasePath('packages/foo/bar/package.json'), false);
  assert.equal(isAllowedReleasePath('README.md'), false);
});

test('classify(): allowlist matching is case-sensitive (an uppercased shape is rejected)', () => {
  assert.equal(isAllowedReleasePath('PACKAGE.JSON'), false);
  assert.equal(isAllowedReleasePath('Package.json'), false);
  assert.equal(classify(['PACKAGE.JSON']).pure_release, false);
  assert.equal(classify(['Package.json']).pure_release, false);
  // Nested-package case, so a `PACKAGE_ALLOWLIST_PATTERN` regex mutated
  // with an `/i` flag (case-insensitive) is caught here even though the
  // root-level cases above are checked by strict `Array.includes`
  // equality, not the regex, and would not be affected by that mutation.
  assert.equal(isAllowedReleasePath('packages/foo/PACKAGE.JSON'), false);
  assert.equal(classify(['packages/foo/Package.json']).pure_release, false);
});

test('classify(): a leading "./" form of an otherwise-allowed path is rejected', () => {
  const verdict = classify(['./package.json']);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['./package.json']);
});

test('classify(): any number of packages in one pure list is still pure (not capped at one)', () => {
  const files = [
    'package.json',
    'packages/a/package.json',
    'packages/a/CHANGELOG.md',
    'packages/b/package.json',
    'packages/b/CHANGELOG.md',
    'packages/c/CHANGELOG.md',
  ];
  const verdict = classify(files);
  assert.equal(verdict.pure_release, true);
  assert.deepEqual(verdict.rejected, []);
});

// ── classifyPullFiles(): status + content-aware classification ─────────
//
// PR #190's real package.json / package-lock.json patches, captured via
// `gh api repos/LanNguyenSi/agent-grounding/pulls/190/files
// --jq '.[] | {filename, status, patch}'` (read-only, no repo state
// changed): a real version-bump diff touches nothing but a `"version":`
// value line in each file.

const PR_190_PACKAGE_LOCK_PATCH =
  '@@ -8947,7 +8947,7 @@\n' +
  '     },\n' +
  '     "packages/understanding-gate": {\n' +
  '       "name": "@lannguyensi/understanding-gate",\n' +
  '-      "version": "0.4.11",\n' +
  '+      "version": "0.5.0",\n' +
  '       "license": "MIT",\n' +
  '       "dependencies": {\n' +
  '         "@lannguyensi/hypothesis-tracker": "0.6.0",';

const PR_190_PACKAGE_JSON_PATCH =
  '@@ -1,6 +1,6 @@\n' +
  ' {\n' +
  '   "name": "@lannguyensi/understanding-gate",\n' +
  '-  "version": "0.4.11",\n' +
  '+  "version": "0.5.0",\n' +
  '   "description": "Pre-execution gate that asks AI agents to produce an Understanding Report before acting",\n' +
  '   "license": "MIT",\n' +
  '   "engines": {';

test('classifyPullFiles(): PR #190 real package-lock.json version-bump patch is pure', () => {
  const verdict = classifyPullFiles([
    { filename: 'package-lock.json', status: 'modified', patch: PR_190_PACKAGE_LOCK_PATCH },
  ]);
  assert.equal(verdict.pure_release, true);
  assert.deepEqual(verdict.allowed, ['package-lock.json']);
});

test('classifyPullFiles(): PR #190 real package.json version-bump patch is pure', () => {
  const verdict = classifyPullFiles([
    {
      filename: 'packages/understanding-gate/package.json',
      status: 'modified',
      patch: PR_190_PACKAGE_JSON_PATCH,
    },
  ]);
  assert.equal(verdict.pure_release, true);
  assert.deepEqual(verdict.allowed, ['packages/understanding-gate/package.json']);
});

test('classifyPullFiles(): a package.json patch that also adds a postinstall script is NOT pure', () => {
  const patch =
    '@@ -1,6 +1,7 @@\n' +
    ' {\n' +
    '   "name": "@lannguyensi/foo",\n' +
    '-  "version": "0.11.0",\n' +
    '+  "version": "0.11.1",\n' +
    '+  "postinstall": "node scripts/setup.js",\n' +
    '   "license": "MIT",';
  const verdict = classifyPullFiles([
    { filename: 'package.json', status: 'modified', patch },
  ]);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['package.json']);
});

test('classifyPullFiles(): a package-lock.json patch that changes "resolved" is NOT pure', () => {
  const patch =
    '@@ -100,8 +100,8 @@\n' +
    '     "packages/foo": {\n' +
    '       "name": "@lannguyensi/foo",\n' +
    '-      "version": "0.11.0",\n' +
    '-      "resolved": "file:packages/foo",\n' +
    '+      "version": "0.11.1",\n' +
    '+      "resolved": "file:packages/foo-new",\n' +
    '       "license": "MIT",';
  const verdict = classifyPullFiles([
    { filename: 'package-lock.json', status: 'modified', patch },
  ]);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['package-lock.json']);
});

test('classifyPullFiles(): a package.json entry with no patch field at all is NOT pure (fail-closed)', () => {
  const verdict = classifyPullFiles([
    { filename: 'package.json', status: 'modified' },
  ]);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['package.json']);
});

test('classifyPullFiles(): a version line with a trailing comma is pure', () => {
  const patch = '@@ -1,3 +1,3 @@\n {\n-  "version": "0.1.0",\n+  "version": "0.1.1",';
  const verdict = classifyPullFiles([
    { filename: 'package.json', status: 'modified', patch },
  ]);
  assert.equal(verdict.pure_release, true);
});

test('classifyPullFiles(): a version line with no trailing comma (last key) is pure', () => {
  const patch = '@@ -1,3 +1,3 @@\n {\n-  "version": "0.1.0"\n+  "version": "0.1.1"\n }';
  const verdict = classifyPullFiles([
    { filename: 'package.json', status: 'modified', patch },
  ]);
  assert.equal(verdict.pure_release, true);
});

test('classifyPullFiles(): a "version" key nested somewhere unexpected is still fine (it is a version value)', () => {
  const patch =
    '@@ -1,6 +1,6 @@\n' +
    '     "some-nested-dep": {\n' +
    '       "name": "some-nested-dep",\n' +
    '-      "version": "1.2.2",\n' +
    '+      "version": "1.2.3",\n' +
    '       "license": "MIT",';
  const verdict = classifyPullFiles([
    { filename: 'package-lock.json', status: 'modified', patch },
  ]);
  assert.equal(verdict.pure_release, true);
});

test('classifyPullFiles(): a CHANGELOG.md entry has no content constraint (prose changes freely)', () => {
  const verdict = classifyPullFiles([
    {
      filename: 'CHANGELOG.md',
      status: 'modified',
      patch: '@@ -1,3 +1,5 @@\n # Changelog\n+\n+## 0.5.0\n+- did a thing\n',
    },
  ]);
  assert.equal(verdict.pure_release, true);
});

test('classifyPullFiles(): a rename into an allowlisted CHANGELOG.md path is NOT pure', () => {
  const verdict = classifyPullFiles([
    {
      filename: 'packages/x/CHANGELOG.md',
      status: 'renamed',
      previous_filename: 'packages/x/HISTORY.md',
      patch: '@@ -1,1 +1,1 @@\n-old\n+old\n',
    },
  ]);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['packages/x/CHANGELOG.md']);
});

test('classifyPullFiles(): a removed package.json is NOT pure', () => {
  const verdict = classifyPullFiles([
    { filename: 'package.json', status: 'removed', patch: '@@ -1,3 +0,0 @@\n-{}\n' },
  ]);
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.rejected, ['package.json']);
});

test('classifyPullFiles(): a multi-package pure list (added + modified) stays pure', () => {
  const verdict = classifyPullFiles([
    { filename: 'package.json', status: 'modified', patch: PR_190_PACKAGE_JSON_PATCH },
    { filename: 'package-lock.json', status: 'modified', patch: PR_190_PACKAGE_LOCK_PATCH },
    {
      filename: 'packages/a/CHANGELOG.md',
      status: 'modified',
      patch: '@@ -1,1 +1,3 @@\n # Changelog\n+\n+## 1.0.0\n',
    },
    {
      filename: 'packages/b/CHANGELOG.md',
      status: 'added',
      patch: '@@ -0,0 +1,1 @@\n+# Changelog\n',
    },
  ]);
  assert.equal(verdict.pure_release, true);
  assert.equal(verdict.rejected.length, 0);
});

test('classifyPullFiles(): empty file list is NOT pure', () => {
  const verdict = classifyPullFiles([]);
  assert.equal(verdict.pure_release, false);
});

test('classifyPullFiles(): throws TypeError on a non-array input (caller bug, not a verdict)', () => {
  assert.throws(() => classifyPullFiles('package.json'), TypeError);
  assert.throws(() => classifyPullFiles(null), TypeError);
});

// ── CLI ────────────────────────────────────────────────────────────────

test('CLI: argv file list, pure release, exit 0', () => {
  const out = execFileSync(process.execPath, [SCRIPT_PATH, ...PR_190_FILES], {
    encoding: 'utf8',
  });
  const verdict = JSON.parse(out.trim());
  assert.equal(verdict.pure_release, true);
});

test('CLI: stdin JSON array, not pure, exit 0 (verdict, not a failure)', () => {
  const out = execFileSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify(PR_215_FILES),
    encoding: 'utf8',
  });
  const verdict = JSON.parse(out.trim());
  assert.equal(verdict.pure_release, false);
});

test('CLI: empty stdin (no argv, no piped data) is the empty list, exit 0', () => {
  const out = execFileSync(process.execPath, [SCRIPT_PATH], {
    input: '',
    encoding: 'utf8',
  });
  const verdict = JSON.parse(out.trim());
  assert.equal(verdict.pure_release, false);
  assert.deepEqual(verdict.allowed, []);
  assert.deepEqual(verdict.rejected, []);
});

test('CLI: malformed JSON on stdin exits non-zero', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [SCRIPT_PATH], {
      input: '{not valid json',
      encoding: 'utf8',
    });
  }, /Command failed/);
});

test('CLI: valid JSON on stdin that is not an array of strings exits non-zero', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [SCRIPT_PATH], {
      input: JSON.stringify({ not: 'an array' }),
      encoding: 'utf8',
    });
  }, /Command failed/);
});
