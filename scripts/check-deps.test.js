/**
 * Unit tests for the pure checkers in check-deps.js.
 *
 * Runs entirely against in-memory fixtures and disposable temp directories
 * (never this repo's actual packages/), so these tests can safely include a
 * "negative control" fixture with a deliberately declared-but-unused
 * dependency without touching any real package.json. Uses Node's built-in
 * test runner (`node --test`), matching check-pins.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  stripComments,
  extractImportedPackageNames,
  extractPackageNameFromSpecifier,
  loadWorkspacePackagesWithImports,
  collectDependencyViolations,
  countCheckedDependencies,
  run,
} = require('./check-deps');

// ── extractPackageNameFromSpecifier ────────────────────────────────────────

test('extractPackageNameFromSpecifier: unscoped bare specifier', () => {
  assert.equal(extractPackageNameFromSpecifier('chalk'), 'chalk');
});

test('extractPackageNameFromSpecifier: unscoped specifier with subpath', () => {
  assert.equal(extractPackageNameFromSpecifier('some-lib/dist/thing.js'), 'some-lib');
});

test('extractPackageNameFromSpecifier: scoped specifier with subpath', () => {
  assert.equal(
    extractPackageNameFromSpecifier('@modelcontextprotocol/sdk/server/mcp.js'),
    '@modelcontextprotocol/sdk',
  );
});

test('extractPackageNameFromSpecifier: bare scoped specifier', () => {
  assert.equal(extractPackageNameFromSpecifier('@lannguyensi/claim-gate'), '@lannguyensi/claim-gate');
});

test('extractPackageNameFromSpecifier: relative specifier is not a dependency', () => {
  assert.equal(extractPackageNameFromSpecifier('./lib.js'), null);
  assert.equal(extractPackageNameFromSpecifier('../index'), null);
});

test('extractPackageNameFromSpecifier: absolute specifier is not a dependency', () => {
  assert.equal(extractPackageNameFromSpecifier('/abs/path'), null);
});

test('extractPackageNameFromSpecifier: node: builtin is not a dependency', () => {
  assert.equal(extractPackageNameFromSpecifier('node:fs'), null);
});

// ── extractImportedPackageNames ────────────────────────────────────────────

test('extractImportedPackageNames: default import', () => {
  const names = extractImportedPackageNames(`import chalk from 'chalk';`);
  assert.deepEqual([...names], ['chalk']);
});

test('extractImportedPackageNames: named import', () => {
  const names = extractImportedPackageNames(`import { Command } from 'commander';`);
  assert.deepEqual([...names], ['commander']);
});

test('extractImportedPackageNames: multi-line named import', () => {
  const source = `import {\n  Foo,\n  Bar,\n} from 'some-lib';\n`;
  const names = extractImportedPackageNames(source);
  assert.deepEqual([...names], ['some-lib']);
});

test('extractImportedPackageNames: import type', () => {
  const names = extractImportedPackageNames(`import type { Foo } from 'types-only-lib';`);
  assert.deepEqual([...names], ['types-only-lib']);
});

test('extractImportedPackageNames: side-effect import (no from)', () => {
  const names = extractImportedPackageNames(`import 'side-effect-lib';`);
  assert.deepEqual([...names], ['side-effect-lib']);
});

test('extractImportedPackageNames: export ... from', () => {
  const names = extractImportedPackageNames(`export { thing } from 'reexport-lib';`);
  assert.deepEqual([...names], ['reexport-lib']);
});

test('extractImportedPackageNames: export * from', () => {
  const names = extractImportedPackageNames(`export * from 'star-reexport-lib';`);
  assert.deepEqual([...names], ['star-reexport-lib']);
});

test('extractImportedPackageNames: CommonJS require', () => {
  const names = extractImportedPackageNames(`const chalk = require('chalk');`);
  assert.deepEqual([...names], ['chalk']);
});

test('extractImportedPackageNames: dynamic import()', () => {
  const names = extractImportedPackageNames(`const mod = await import('dynamic-lib');`);
  assert.deepEqual([...names], ['dynamic-lib']);
});

test('extractImportedPackageNames: scoped subpath import resolves to the scope/name pair', () => {
  const names = extractImportedPackageNames(`import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`);
  assert.deepEqual([...names], ['@modelcontextprotocol/sdk']);
});

test('extractImportedPackageNames: relative and node: specifiers are excluded, external ones kept', () => {
  const source = `
    import { readFileSync } from 'node:fs';
    import { helper } from './lib.js';
    import chalk from 'chalk';
  `;
  const names = extractImportedPackageNames(source);
  assert.deepEqual([...names].sort(), ['chalk']);
});

test('extractImportedPackageNames: multiple distinct specifiers across a realistic file', () => {
  const source = `
    import { readFileSync } from 'node:fs';
    import { join } from 'path';
    import { Command } from 'commander';
    import chalk from 'chalk';
    import { getPlaybook } from './lib.js';

    if (require.main === module) {
      run();
    }
  `;
  const names = extractImportedPackageNames(source);
  assert.deepEqual([...names].sort(), ['chalk', 'commander', 'path']);
});

test('extractImportedPackageNames: no matches in a file with no imports', () => {
  const names = extractImportedPackageNames(`export function add(a, b) { return a + b; }`);
  assert.deepEqual([...names], []);
});

// ── Comment stripping (extractImportedPackageNames hardening) ─────────────
// Regression coverage for the review finding: an apostrophe or semicolon
// inside a comment used to break IMPORT_EXPORT_FROM_RE's `[^'";]*?` gap
// between `import`/`export` and `from`, silently turning a genuinely-used
// dependency into a phantom. Comments are now stripped before the specifier
// patterns run.

test('extractImportedPackageNames: multi-line import survives inline comments with an apostrophe and a semicolon', () => {
  // Without comment-stripping, this exact shape used to return an EMPTY
  // set — the apostrophe in "don't" and the semicolon in "trailing;"
  // both fall inside IMPORT_EXPORT_FROM_RE's `[^'";]*?` gap and block the
  // match entirely, so `some-lib` would be reported as an unused phantom
  // even though it plainly is used.
  const source = `import {
  Foo, // don't use bar
  Bar, // trailing; comment
} from 'some-lib';
`;
  const names = extractImportedPackageNames(source);
  assert.deepEqual([...names], ['some-lib']);
});

test('extractImportedPackageNames: require.resolve(...) is found', () => {
  const names = extractImportedPackageNames(`const p = require.resolve('pkg');`);
  assert.deepEqual([...names], ['pkg']);
});

test('extractImportedPackageNames: a commented-out import is NOT counted as evidence', () => {
  const names = extractImportedPackageNames(`// import x from 'pkg-m';`);
  assert.deepEqual([...names], []);
});

test('stripComments: strips a line comment', () => {
  assert.equal(stripComments(`const x = 1; // a comment\n`), `const x = 1; \n`);
});

test('stripComments: strips a block comment, including multi-line', () => {
  assert.equal(stripComments(`const x = /* inline */ 1;`), `const x =  1;`);
  assert.equal(stripComments(`const x = 1;\n/*\n * multi-line\n */\nconst y = 2;\n`), `const x = 1;\n\nconst y = 2;\n`);
});

test('stripComments: a scheme-prefixed URL string on its own line survives untouched', () => {
  // The negative lookbehind spares any "//" immediately preceded by ":" —
  // covers http://, https://, ws://, git://, etc. This only needs to hold
  // when nothing else meaningful shares the line, which is the case this
  // test pins; see stripComments' doc comment for the same-line argument
  // that makes this safe in this repo even when the lookbehind does not
  // apply (e.g. a bare protocol-relative URL).
  const source = `const banner = 'https://example.com/foo';\n`;
  assert.equal(stripComments(source), source);
});

// ── collectDependencyViolations (main pure core) ───────────────────────────

test('passes when every declared external dependency is imported', () => {
  const workspaces = [
    {
      name: '@lannguyensi/a',
      dependencies: { chalk: '^5.3.0', commander: '^12.0.0' },
      importedPackageNames: new Set(['chalk', 'commander']),
    },
  ];
  assert.deepEqual(collectDependencyViolations(workspaces), []);
});

test('negative control: flags a declared dependency that is never imported (phantom dep)', () => {
  // Reproduces the exact bug class from task ca2aceff: js-yaml declared in
  // dependencies but never imported anywhere under src/.
  const workspaces = [
    {
      name: '@lannguyensi/debug-playbook-engine',
      dependencies: { chalk: '^4.1.2', commander: '^11.1.0', 'js-yaml': '^4.1.0' },
      importedPackageNames: new Set(['chalk', 'commander']),
    },
  ];
  const violations = collectDependencyViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    reason: 'phantom-dependency',
    consumer: '@lannguyensi/debug-playbook-engine',
    dependency: 'js-yaml',
  });
});

test('reports one violation per phantom dependency across multiple packages', () => {
  const workspaces = [
    {
      name: '@lannguyensi/a',
      dependencies: { glob: '^11.0.0' },
      importedPackageNames: new Set(),
    },
    {
      name: '@lannguyensi/b',
      dependencies: { 'js-yaml': '^4.1.0' },
      importedPackageNames: new Set(),
    },
  ];
  const violations = collectDependencyViolations(workspaces);
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => [v.consumer, v.dependency]),
    [
      ['@lannguyensi/a', 'glob'],
      ['@lannguyensi/b', 'js-yaml'],
    ],
  );
});

test('ignores internal @lannguyensi/* dependencies entirely (check-pins.js territory)', () => {
  const workspaces = [
    {
      name: '@lannguyensi/grounding-sdk',
      dependencies: {
        '@lannguyensi/claim-gate': '0.6.0',
        '@lannguyensi/evidence-ledger': '0.6.0',
      },
      importedPackageNames: new Set(), // deliberately empty: still no violation
    },
  ];
  assert.deepEqual(collectDependencyViolations(workspaces), []);
});

test('a package with no dependencies at all produces no violations', () => {
  const workspaces = [
    { name: '@lannguyensi/hypothesis-tracker', dependencies: {}, importedPackageNames: new Set() },
  ];
  assert.deepEqual(collectDependencyViolations(workspaces), []);
});

test('allowlist: an explicitly allowlisted (package, dependency) pair is not flagged', () => {
  const workspaces = [
    {
      name: '@lannguyensi/some-pkg',
      dependencies: { 'plugin-lib': '^1.0.0' },
      importedPackageNames: new Set(), // never statically imported — loaded dynamically
    },
  ];
  const allowlist = [
    { package: '@lannguyensi/some-pkg', dependency: 'plugin-lib', reason: 'dynamic-import' },
  ];
  assert.deepEqual(collectDependencyViolations(workspaces, allowlist), []);
});

test('allowlist: only exempts the exact (package, dependency) pair, not the dependency name repo-wide', () => {
  const workspaces = [
    {
      name: '@lannguyensi/a',
      dependencies: { 'plugin-lib': '^1.0.0' },
      importedPackageNames: new Set(), // allowlisted for @lannguyensi/a
    },
    {
      name: '@lannguyensi/b',
      dependencies: { 'plugin-lib': '^1.0.0' },
      importedPackageNames: new Set(), // NOT allowlisted for @lannguyensi/b — must still be flagged
    },
  ];
  const allowlist = [{ package: '@lannguyensi/a', dependency: 'plugin-lib', reason: 'dynamic-import' }];
  const violations = collectDependencyViolations(workspaces, allowlist);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].consumer, '@lannguyensi/b');
});

// ── countCheckedDependencies / vacuous-green guard ─────────────────────────

test('countCheckedDependencies: counts external deps, excludes internal and allowlisted ones', () => {
  const workspaces = [
    {
      name: '@lannguyensi/a',
      dependencies: { chalk: '^5.3.0', '@lannguyensi/b': '0.1.0' },
      importedPackageNames: new Set(['chalk']),
    },
    {
      name: '@lannguyensi/c',
      dependencies: { 'plugin-lib': '^1.0.0' },
      importedPackageNames: new Set(),
    },
  ];
  const allowlist = [{ package: '@lannguyensi/c', dependency: 'plugin-lib', reason: 'dynamic-import' }];
  assert.equal(countCheckedDependencies(workspaces, allowlist), 1); // only chalk
});

test('countCheckedDependencies: zero when every package has zero external dependencies', () => {
  const workspaces = [
    { name: '@lannguyensi/a', dependencies: {}, importedPackageNames: new Set() },
    {
      name: '@lannguyensi/b',
      dependencies: { '@lannguyensi/a': '0.1.0' },
      importedPackageNames: new Set(),
    },
  ];
  // This is exactly the input that must make main() (the CLI entrypoint)
  // exit non-zero instead of vacuously reporting success;
  // collectDependencyViolations() itself would (correctly, in isolation)
  // return no violations for this input, which is why the guard has to live
  // in main() before collectDependencyViolations() is ever called.
  assert.equal(countCheckedDependencies(workspaces), 0);
  assert.deepEqual(collectDependencyViolations(workspaces), []);
});

// ── loadWorkspacePackagesWithImports (filesystem loader) ───────────────────
// Exercises the loader against real (but temporary, disposable) directory
// layouts; never touches this repo's actual packages/.

test('loadWorkspacePackagesWithImports: finds a phantom dependency in a real temp fixture', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-phantom-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'phantom-pkg');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@lannguyensi/phantom-pkg',
        version: '1.0.0',
        dependencies: { chalk: '^5.3.0', 'js-yaml': '^4.1.0' },
      }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'src', 'index.ts'),
      `import chalk from 'chalk';\nconsole.log(chalk.red('hi'));\n`,
    );

    const workspaces = loadWorkspacePackagesWithImports(tmpRoot);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, '@lannguyensi/phantom-pkg');

    const violations = collectDependencyViolations(workspaces);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].dependency, 'js-yaml');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadWorkspacePackagesWithImports: clean fixture (every dependency imported) produces no violations', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-clean-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'clean-pkg');
    fs.mkdirSync(path.join(pkgDir, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@lannguyensi/clean-pkg',
        version: '1.0.0',
        dependencies: { chalk: '^5.3.0', commander: '^12.0.0' },
      }),
    );
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.ts'), `import chalk from 'chalk';\n`);
    // Import found in a NESTED src/ subdirectory must still count.
    fs.writeFileSync(
      path.join(pkgDir, 'src', 'nested', 'cli.ts'),
      `import { Command } from 'commander';\n`,
    );

    const workspaces = loadWorkspacePackagesWithImports(tmpRoot);
    assert.deepEqual(collectDependencyViolations(workspaces), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadWorkspacePackagesWithImports: a package with no src/ directory has zero imports, not a crash', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-nosrc-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'no-src-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@lannguyensi/no-src-pkg', version: '1.0.0', dependencies: {} }),
    );

    const workspaces = loadWorkspacePackagesWithImports(tmpRoot);
    assert.equal(workspaces.length, 1);
    assert.deepEqual([...workspaces[0].importedPackageNames], []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Zero-workspace guard ────────────────────────────────────────────────
// main() (in check-deps.js) must not vacuously pass when
// loadWorkspacePackagesWithImports() finds zero packages (e.g. packages/
// renamed/emptied) — mirrors check-pins.test.js's equivalent guard test.

test('loadWorkspacePackagesWithImports returns [] for a packages/ dir with no package.json subdirs', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-empty-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages'));
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'not-a-package'));

    const workspaces = loadWorkspacePackagesWithImports(tmpRoot);
    assert.deepEqual(workspaces, []);
    assert.deepEqual(collectDependencyViolations(workspaces), []);
    assert.equal(countCheckedDependencies(workspaces), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run(rootDir) (CLI core, exit code) ─────────────────────────────────────
// Exercises the CLI entrypoint's pure exit-code core end to end against real
// (but temporary, disposable) directory layouts — the actual thing `main()`
// calls and turns into `process.exitCode`. Reproduces the two vacuous-green
// guards and the two pass/fail paths as exit codes, not just as violation
// arrays from the pure checkers above.

test('run(): a packages/ dir with zero package.json subdirs exits 1 via the zero-workspace guard specifically', () => {
  // Exit-code-alone is not enough here: with 0 workspaces,
  // countCheckedDependencies() is always 0 too, so the SECOND
  // (zero-checked-deps) guard independently returns 1 for this exact input
  // even if the FIRST (zero-workspace) guard is disabled. Asserting only
  // `run(tmpRoot) === 1` cannot tell those two guards apart and would stay
  // green if the zero-workspace guard were deleted or short-circuited — so
  // this test captures console.error and pins the zero-workspace guard's
  // specific message, which only that guard (not the zero-checked-deps one)
  // ever prints.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-run-empty-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => {
    errorMessages.push(args.join(' '));
  };
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages'));
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'not-a-package'));

    const exitCode = run(tmpRoot);
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((message) => message.includes('found 0 workspace packages under packages/')),
      `expected the zero-workspace guard's message, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): packages present but zero checked external dependencies exits 1 (vacuous-green guard)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-run-zero-checked-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'internal-only-pkg');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@lannguyensi/internal-only-pkg',
        version: '1.0.0',
        // Only an internal @lannguyensi/* dep declared — countCheckedDependencies
        // excludes it, so 0 pairs end up checked even though a package exists.
        dependencies: { '@lannguyensi/sibling': '1.0.0' },
      }),
    );
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.ts'), `export const noop = () => {};\n`);

    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a phantom dependency exits 1', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-run-phantom-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'phantom-pkg');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@lannguyensi/phantom-pkg',
        version: '1.0.0',
        dependencies: { chalk: '^5.3.0', 'js-yaml': '^4.1.0' },
      }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'src', 'index.ts'),
      `import chalk from 'chalk';\nconsole.log(chalk.red('hi'));\n`,
    );

    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a clean tree (every dependency imported) exits 0', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-run-clean-'));
  try {
    const pkgDir = path.join(tmpRoot, 'packages', 'clean-pkg');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@lannguyensi/clean-pkg',
        version: '1.0.0',
        dependencies: { chalk: '^5.3.0' },
      }),
    );
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.ts'), `import chalk from 'chalk';\n`);

    assert.equal(run(tmpRoot), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Sanity check against the real repo ─────────────────────────────────────
// Not a substitute for running `npm run check:deps` in CI (that's the real
// gate), but confirms the loader + checker run cleanly end-to-end against
// this repo's actual packages/ without throwing.

test('loadWorkspacePackagesWithImports runs against the real repo without throwing', () => {
  const rootDir = path.join(__dirname, '..');
  const workspaces = loadWorkspacePackagesWithImports(rootDir);
  assert.ok(workspaces.length > 0);
  for (const pkg of workspaces) {
    assert.ok(pkg.importedPackageNames instanceof Set);
  }
});
