/**
 * Unit tests for check-grounding-mcp-pack.js.
 *
 * `evaluateVersionMatch` and `corruptInstalledPackage`'s unknown-mode branch
 * are pure/in-memory and run against synthetic values only (including the
 * required negative control: a stub wrong-version pair, proving the
 * comparison actually discriminates rather than always passing).
 * `readTarballVersion` is exercised against small disposable fixture
 * tarballs built with `tar` in a temp dir (a real tarball shape, not this
 * repo's own package). `findVersionLockedWorkspaceSiblings` is exercised
 * both against a synthetic fixture workspace (proving the sibling list is
 * genuinely DERIVED from a package's declared dependencies, not a
 * hardcoded name list, and that a range-pinned or non-workspace dep is
 * correctly excluded) and against this repo's real
 * `packages/grounding-mcp` (proving today's actual sibling set). The
 * `installTarballs`/`runVersionCommand` argv tests use an injected `execFn`
 * to assert the exact command shape (which tarballs, `--omit=dev`, cwd)
 * without a real npm install or process spawn -- a regression guard for
 * review finding F3 (task d341afd5 round 2): a mutant that drops
 * `--omit=dev`, or drops a sibling tarball, from the real install call
 * previously survived because no test pinned the argv.
 *
 * `run()`'s own end-to-end test packs and installs the REAL
 * `packages/grounding-mcp` workspace package plus its real version-locked
 * siblings (requires `dist/` already built, same precondition the CI
 * "Build" step guarantees before this check's own step runs) and exercises
 * the negative-control corruption path failing red with a named message --
 * that IS the real coverage for the manual verification this check
 * replaces. A second, separate `run()` test also packs for real but fakes
 * the install/version-check exec calls (see `installTarballs`/
 * `runVersionCommand` above) to assert `run()`'s own internal argv/cwd
 * wiring (F3) without paying for a real install or process spawn. A prior
 * round of this check also had a THIRD `run()` test duplicating the
 * negative-control test's own happy path; review finding F7 (task
 * d341afd5 round 2) dropped it as redundant with the argv-level coverage
 * above -- the CI job now does two real pack+install rounds for this
 * checker (one in the "check" step itself, one in the kept end-to-end
 * test here), not three.
 *
 * Uses Node's built-in test runner (`node --test`), matching this repo's
 * other scripts/*.test.js files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  loadWorkspacePackageDirsByName,
  findVersionLockedWorkspaceSiblings,
  readTarballVersion,
  installTarballs,
  installedPackageJsonPath,
  corruptInstalledPackage,
  runVersionCommand,
  evaluateVersionMatch,
  run,
} = require('./check-grounding-mcp-pack');

const REPO_ROOT = path.join(__dirname, '..');
const GROUNDING_MCP_DIR = path.join(REPO_ROOT, 'packages', 'grounding-mcp');
const DIST_ENTRY = path.join(GROUNDING_MCP_DIR, 'dist', 'server.js');
const REQUIRE_DIST = process.env.GROUNDING_MCP_PACK_REQUIRE_DIST === '1';

// ── evaluateVersionMatch (pure) ─────────────────────────────────────────────

test('evaluateVersionMatch: matching versions is ok', () => {
  const result = evaluateVersionMatch('0.11.0', '0.11.0');
  assert.equal(result.ok, true);
  assert.match(result.message, /0\.11\.0/);
});

test('evaluateVersionMatch: negative control -- a wrong-version stub is NOT ok (the comparison discriminates)', () => {
  // Regression guard for "always passes" / "compares against the repo's
  // version instead of the tarball's" mutants: feeding a reported version
  // that does not match the expected (tarball) version must fail, and the
  // message must name BOTH values.
  const result = evaluateVersionMatch('0.10.0', '0.11.0');
  assert.equal(result.ok, false);
  assert.match(result.message, /0\.10\.0/);
  assert.match(result.message, /0\.11\.0/);
});

test('evaluateVersionMatch: the reported value alone (e.g. the server.ts ENOENT fallback "0.0.0") never reads as ok', () => {
  const result = evaluateVersionMatch('0.0.0', '0.11.0');
  assert.equal(result.ok, false);
});

// ── corruptInstalledPackage ──────────────────────────────────────────────

test('corruptInstalledPackage: null/undefined mode is a no-op', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-noop-'));
  try {
    assert.doesNotThrow(() => corruptInstalledPackage(tmpRoot, null));
    assert.doesNotThrow(() => corruptInstalledPackage(tmpRoot, undefined));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('corruptInstalledPackage: "remove-package-json" deletes the installed package.json', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-remove-'));
  try {
    const pkgJsonPath = installedPackageJsonPath(tmpRoot);
    fs.mkdirSync(path.dirname(pkgJsonPath), { recursive: true });
    fs.writeFileSync(pkgJsonPath, '{"version":"0.11.0"}\n');
    assert.equal(fs.existsSync(pkgJsonPath), true);
    corruptInstalledPackage(tmpRoot, 'remove-package-json');
    assert.equal(fs.existsSync(pkgJsonPath), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('corruptInstalledPackage: "remove-package-json" on an already-missing file is a no-op, not a throw', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-remove-missing-'));
  try {
    assert.doesNotThrow(() => corruptInstalledPackage(tmpRoot, 'remove-package-json'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('corruptInstalledPackage: negative control -- an unknown mode throws rather than silently doing nothing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-unknown-'));
  try {
    assert.throws(() => corruptInstalledPackage(tmpRoot, 'not-a-real-mode'), /unknown corrupt mode/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── readTarballVersion (fixture tarballs, no real npm pack) ─────────────────

function makeFixtureTarball(tmpRoot, pkgJsonContent) {
  const stageDir = path.join(tmpRoot, 'stage', 'package');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'package.json'), pkgJsonContent);
  const tgzPath = path.join(tmpRoot, 'fixture.tgz');
  execFileSync('tar', ['-czf', tgzPath, '-C', path.join(tmpRoot, 'stage'), 'package']);
  return tgzPath;
}

test('readTarballVersion: reads the version out of a real fixture tarball', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-tarball-version-'));
  try {
    const tgzPath = makeFixtureTarball(tmpRoot, JSON.stringify({ name: 'fixture-pkg', version: '9.9.9' }));
    assert.equal(readTarballVersion(tgzPath), '9.9.9');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readTarballVersion: negative control -- a tarball whose package.json has no version field throws', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-tarball-noversion-'));
  try {
    const tgzPath = makeFixtureTarball(tmpRoot, JSON.stringify({ name: 'fixture-pkg' }));
    assert.throws(() => readTarballVersion(tgzPath), /no non-empty string "version"/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readTarballVersion: negative control -- an unparseable package.json entry throws', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-tarball-badjson-'));
  try {
    const tgzPath = makeFixtureTarball(tmpRoot, 'not valid json {{{');
    assert.throws(() => readTarballVersion(tgzPath), /unparseable/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── findVersionLockedWorkspaceSiblings (synthetic fixture workspace) ───────
// Proves the sibling list is DERIVED from a package's own dependencies
// (review finding F1, task d341afd5 round 2), not a hardcoded name list: a
// fresh fixture workspace here has NEVER been named by check-grounding-mcp
// -pack.js, so a hardcoded-list implementation would return an empty (or
// wrong) set against it.

function makeFixtureWorkspace(tmpRoot) {
  const packagesDir = path.join(tmpRoot, 'packages');
  const write = (name, version, dependencies) => {
    const dir = path.join(packagesDir, name.replace('@lannguyensi/', ''));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, dependencies }, null, 2));
    return dir;
  };
  // The package under test: one exact-pinned workspace sibling (must be
  // picked up), one range-pinned workspace sibling (must be excluded, it
  // can float and the registry always has a satisfying version), one
  // exact-pinned name that names NO workspace package (must be excluded --
  // not this monorepo's own package, nothing to co-pack), and one ordinary
  // external dependency (must be ignored entirely).
  const mainDir = write('@lannguyensi/fixture-main', '1.0.0', {
    '@lannguyensi/fixture-locked-sibling': '2.3.4',
    '@lannguyensi/fixture-ranged-sibling': '^2.0.0',
    '@lannguyensi/fixture-external-only': '5.0.0',
    chalk: '^5.3.0',
  });
  write('@lannguyensi/fixture-locked-sibling', '2.3.4', {});
  write('@lannguyensi/fixture-ranged-sibling', '2.5.0', {});
  return mainDir;
}

test('findVersionLockedWorkspaceSiblings: derives the exact-pinned @lannguyensi workspace siblings from the package.json dependency map (fixture, not hardcoded)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-siblings-fixture-'));
  try {
    const mainDir = makeFixtureWorkspace(tmpRoot);
    const siblings = findVersionLockedWorkspaceSiblings(tmpRoot, mainDir);
    assert.deepEqual(
      siblings.map((s) => s.name),
      ['@lannguyensi/fixture-locked-sibling'],
    );
    assert.equal(siblings[0].dir, path.join(tmpRoot, 'packages', 'fixture-locked-sibling'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findVersionLockedWorkspaceSiblings: a newly-added version-locked dependency is picked up with no code change (adds a second fixture sibling)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-siblings-fixture-new-'));
  try {
    const mainDir = makeFixtureWorkspace(tmpRoot);
    const pkgJsonPath = path.join(mainDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    pkg.dependencies['@lannguyensi/fixture-second-locked'] = '9.0.0';
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'fixture-second-locked'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'fixture-second-locked', 'package.json'),
      JSON.stringify({ name: '@lannguyensi/fixture-second-locked', version: '9.0.0' }),
    );

    const siblings = findVersionLockedWorkspaceSiblings(tmpRoot, mainDir);
    assert.deepEqual(
      siblings.map((s) => s.name).sort(),
      ['@lannguyensi/fixture-locked-sibling', '@lannguyensi/fixture-second-locked'],
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── findVersionLockedWorkspaceSiblings (this repo's real workspace) ────────

test('findVersionLockedWorkspaceSiblings: today\'s real grounding-mcp version-locked siblings (claim-gate, evidence-ledger, grounding-wrapper, hypothesis-tracker; NOT runtime-reality-checker, a range pin)', () => {
  const siblings = findVersionLockedWorkspaceSiblings(REPO_ROOT, GROUNDING_MCP_DIR);
  assert.deepEqual(
    siblings.map((s) => s.name),
    [
      '@lannguyensi/claim-gate',
      '@lannguyensi/evidence-ledger',
      '@lannguyensi/grounding-wrapper',
      '@lannguyensi/hypothesis-tracker',
    ],
  );
  for (const sibling of siblings) {
    assert.equal(fs.existsSync(path.join(sibling.dir, 'package.json')), true);
  }
});

test('loadWorkspacePackageDirsByName: maps every real packages/*/package.json "name" to its directory', () => {
  const byName = loadWorkspacePackageDirsByName(REPO_ROOT);
  assert.equal(byName.get('@lannguyensi/grounding-mcp'), GROUNDING_MCP_DIR);
  assert.ok(byName.size >= 5, `expected at least 5 workspace packages, got ${byName.size}`);
});

// ── installTarballs / runVersionCommand (injected execFn, no real npm) ─────
// Regression guard for review finding F3 (task d341afd5 round 2): a mutant
// dropping '--omit=dev', or a sibling tarball, from the real install argv
// previously survived every existing test.

test('installTarballs: argv contains --omit=dev and every given tarball path, cwd is the consumer dir', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-install-argv-'));
  try {
    const consumerDir = path.join(tmpRoot, 'consumer');
    const tgzPaths = [
      path.join(tmpRoot, 'pack', 'lannguyensi-claim-gate-0.6.0.tgz'),
      path.join(tmpRoot, 'pack', 'lannguyensi-evidence-ledger-0.6.0.tgz'),
      path.join(tmpRoot, 'pack', 'lannguyensi-grounding-wrapper-0.6.0.tgz'),
      path.join(tmpRoot, 'pack', 'lannguyensi-hypothesis-tracker-0.6.0.tgz'),
      path.join(tmpRoot, 'pack', 'lannguyensi-grounding-mcp-0.11.0.tgz'),
    ];
    let captured = null;
    const fakeExec = (cmd, args, opts) => {
      captured = { cmd, args, opts };
      return '';
    };

    installTarballs(tgzPaths, consumerDir, fakeExec);

    assert.equal(captured.cmd, 'npm');
    assert.equal(captured.args[0], 'install');
    assert.ok(captured.args.includes('--omit=dev'), `expected --omit=dev in argv: ${captured.args.join(' ')}`);
    for (const tgzPath of tgzPaths) {
      assert.ok(captured.args.includes(tgzPath), `expected ${tgzPath} in argv: ${captured.args.join(' ')}`);
    }
    assert.equal(captured.opts.cwd, consumerDir);
    // installTarballs itself creates the consumer dir even though the
    // (faked) install call never touches the filesystem.
    assert.equal(fs.existsSync(consumerDir), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runVersionCommand: invokes <consumerDir>/node_modules/.bin/grounding-mcp --version with cwd = consumerDir', () => {
  const consumerDir = path.join(os.tmpdir(), 'pack-check-run-version-fixture');
  let captured = null;
  const fakeExec = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return '1.2.3\n';
  };

  const reported = runVersionCommand(consumerDir, fakeExec);

  assert.equal(captured.cmd, path.join(consumerDir, 'node_modules', '.bin', 'grounding-mcp'));
  assert.deepEqual(captured.args, ['--version']);
  assert.equal(captured.opts.cwd, consumerDir);
  assert.equal(reported, '1.2.3');
});

// ── run() (real packages, real npm pack; install/version-check exec is
//    injected so the following test stays fast and does not need dist/
//    built or a real `node_modules/.bin` bin) ────────────────────────────

test('run(): the install call gets every real version-locked sibling tarball plus grounding-mcp itself, and the version-check bin call is scoped to the same consumer dir under os.tmpdir() (F3 argv/cwd/tmpdir assertions)', () => {
  const calls = [];
  const fakeExec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return 'fake-version-not-asserted\n';
  };

  run({ rootDir: REPO_ROOT, execFn: fakeExec });

  const installCall = calls.find((c) => c.cmd === 'npm' && c.args[0] === 'install');
  assert.ok(installCall, `expected an "npm install" call among: ${JSON.stringify(calls.map((c) => c.cmd))}`);
  assert.ok(installCall.args.includes('--omit=dev'));

  const expectedSiblingNames = findVersionLockedWorkspaceSiblings(REPO_ROOT, GROUNDING_MCP_DIR).map((s) => s.name);
  assert.ok(expectedSiblingNames.length > 0, 'expected at least one real version-locked sibling in this repo');
  const tgzArgs = installCall.args.filter((a) => a.endsWith('.tgz'));
  assert.equal(tgzArgs.length, expectedSiblingNames.length + 1, 'expected one tarball per sibling plus grounding-mcp');
  for (const name of expectedSiblingNames) {
    const flattenedName = name.replace('@', '').replace('/', '-'); // e.g. lannguyensi-claim-gate
    assert.ok(
      tgzArgs.some((a) => path.basename(a).startsWith(flattenedName)),
      `expected the install argv to include a tarball for ${name}, got: ${tgzArgs.join(' ')}`,
    );
  }
  assert.ok(
    tgzArgs.some((a) => path.basename(a).startsWith('lannguyensi-grounding-mcp')),
    `expected the install argv to include the grounding-mcp tarball itself, got: ${tgzArgs.join(' ')}`,
  );

  const consumerDir = installCall.opts.cwd;
  assert.ok(consumerDir.startsWith(os.tmpdir()), `expected the consumer dir to be rooted under os.tmpdir(): ${consumerDir}`);

  const binCall = calls.find((c) => c.cmd !== 'npm');
  assert.ok(binCall, 'expected a bin --version call');
  assert.equal(binCall.cmd, path.join(consumerDir, 'node_modules', '.bin', 'grounding-mcp'));
  assert.deepEqual(binCall.args, ['--version']);
  assert.equal(binCall.opts.cwd, consumerDir);
});

// ── run() end-to-end (real packages/grounding-mcp workspace package,
//    real siblings, real install, real bin spawn) ──────────────────────────
// Requires packages/grounding-mcp/dist to already be built (the CI step
// this check runs as places it after "Build"; a local run needs `npm run
// build` first, same as any other test here that reads dist/ output). A
// missing dist means the very layout this check exists to guard is
// already broken (review finding F2, task d341afd5 round 2): in CI,
// GROUNDING_MCP_PACK_REQUIRE_DIST=1 turns that into a hard failure instead
// of the ordinary local skip, so a build regression cannot silently pass
// this suite via "0 run, 0 fail, 2 skipped" the way it did before this
// round (reproduced: renaming dist/server.js away skipped both e2e tests
// and exited 0).
test('run(): negative control -- removing the installed package.json fails red with a named message', (t) => {
  if (!fs.existsSync(DIST_ENTRY)) {
    if (REQUIRE_DIST) {
      assert.fail(
        `packages/grounding-mcp/dist is missing (${DIST_ENTRY}) -- GROUNDING_MCP_PACK_REQUIRE_DIST=1 requires it built; run "npm run build" first`,
      );
    }
    t.skip('packages/grounding-mcp/dist not built -- run `npm run build` first');
    return;
  }
  // Captures the checker's own stderr so the test can assert on the named
  // failure message (both the "0.0.0" fallback value and the real
  // tarball version must appear), not just the exit code.
  const originalError = console.error;
  const lines = [];
  console.error = (...args) => {
    lines.push(args.join(' '));
  };
  let code;
  try {
    code = run({ rootDir: REPO_ROOT, corrupt: 'remove-package-json' });
  } finally {
    console.error = originalError;
  }
  assert.equal(code, 1);
  const combined = lines.join('\n');
  assert.match(combined, /"0\.0\.0"/);
  assert.match(combined, /grounding-mcp pack check failed/);
});
