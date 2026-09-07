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
