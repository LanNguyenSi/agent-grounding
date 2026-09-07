#!/usr/bin/env node
/**
 * grounding-mcp packed-tarball `--version` check.
 *
 * PR #226 (task ed06b4c8) made `packages/grounding-mcp/src/server.ts` read
 * its served version from the package's own `package.json` at runtime
 * (`new URL('../package.json', import.meta.url)`) instead of a hardcoded
 * `PACKAGE_VERSION` source constant, specifically so a release bump touches
 * no source file. That "works from the published tarball" behavior was
 * verified twice by hand (`npm pack`, extract, `npm install --omit=dev`,
 * `node dist/server.js --version` from a scratch directory outside the
 * repo) but nothing in CI repeated it — a future change to `files`, `bin`,
 * the build layout, or a bundler step could silently break the relative
 * `../package.json` resolution and nothing would notice until a release
 * (task d341afd5).
 *
 * This script repeats that manual verification as an automated check:
 *
 *   1. `npm pack` the `@lannguyensi/grounding-mcp` workspace package, AND
 *      every version-LOCKED (exact-pinned, e.g. `"0.6.0"` not `"^0.6.0"`)
 *      `@lannguyensi/*` sibling dependency it declares, into a scratch pack
 *      directory (`--json` for a reliable filename each). The sibling list
 *      is derived from `packages/grounding-mcp/package.json`'s own
 *      dependencies (`findVersionLockedWorkspaceSiblings`), not hardcoded,
 *      so a newly-added version-locked sibling is picked up automatically.
 *      See that function's own docblock for why this is required, not
 *      optional: without it, a lockstep release PR that re-pins these
 *      siblings to a same-PR, not-yet-published version would fail this
 *      check with an ETARGET resolving them off the public registry.
 *   2. Read the grounding-mcp tarball's OWN `package.json` `version` field
 *      (`tar -xOf`), not this repo's in-tree
 *      `packages/grounding-mcp/package.json` — the whole point is asserting
 *      against what actually shipped in the artifact, not the source tree
 *      it was built from.
 *   3. Install every tarball from step 1 together, in ONE `npm install
 *      --omit=dev` call, into a scratch consumer directory created under
 *      `os.tmpdir()` (outside the repo tree, like the manual verification).
 *      Passing all the tarballs to a single install lets npm satisfy the
 *      exact `@lannguyensi/*` pins from the local files instead of
 *      querying the registry for them (verified by hand: with all five
 *      tarballs installed together, `package-lock.json`'s `resolved` field
 *      for each version-locked sibling starts with `file:`, not a registry
 *      URL; installing the grounding-mcp tarball alone resolves those same
 *      siblings from the registry instead).
 *   4. Run the installed `grounding-mcp` bin with `--version` from that
 *      consumer directory and assert its (trimmed) stdout equals the
 *      grounding-mcp tarball's own version.
 *
 * One pack per package, one combined install, one process spawn for the
 * version check — matches the manual check's own footprint, no extra
 * passes (this whole `run()` still does exactly one pack+install round;
 * see scripts/check-grounding-mcp-pack.test.js's own header, and
 * docs/okf/log.md, for why the CI job as a whole does two such rounds, not
 * three).
 *
 * `run({ corrupt })` accepts an optional corruption mode for the negative
 * control, applied to the INSTALLED tree after step 3 and before step 4, so
 * the failure path can be exercised without a second pack:
 *
 *   - `'remove-package-json'`: deletes the installed package's own
 *     `package.json` (`node_modules/@lannguyensi/grounding-mcp/package.json`).
 *     `server.ts`'s own `readPackageVersion()` catches the resulting ENOENT
 *     and falls back to `'0.0.0'` (see `src/server.ts`), so the served
 *     `--version` output itself does not crash — this check's own
 *     `evaluateVersionMatch` comparison is what discriminates the corrupted
 *     tree from a healthy one, by finding `'0.0.0'` does not equal the
 *     tarball's real version.
 *
 * Scratch directories (`pack/` and `consumer/`, both under one
 * `os.tmpdir()`-rooted run directory) are removed in a `finally`, win or
 * lose.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_RELATIVE_DIR = path.join('packages', 'grounding-mcp');
const SCOPE = '@lannguyensi';
const PACKAGE_NAME = 'grounding-mcp';
const BIN_NAME = 'grounding-mcp';

// Matches an exact semver ("0.6.0", "1.2.3-beta.1", "1.2.3+build.5") and
// rejects any range operator ("^0.6.0", "~0.6.0", ">=0.6.0", "0.6.x", "*", a
// git/tag/alias spec, ...). Deliberately conservative: anything that isn't
// unambiguously an exact pin is treated as a range and excluded from
// co-packing.
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/** Reads `rootDir/package.json`'s own `workspaces` array and returns the
 * list of absolute directories it names. Supports the `<dir>/*` glob form
 * (lists the actual subdirectories under `<dir>` -- npm/Node workspaces'
 * own most common shape) and an explicit path entry (used as-is, no
 * expansion). No glob library: a pattern is treated as the glob form only
 * when it ends in exactly `/*`; anything else is a literal path. A missing
 * or non-array `workspaces` field yields no directories. */
function resolveWorkspaceDirs(rootDir) {
  const rootPkgPath = path.join(rootDir, 'package.json');
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  const dirs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue;
    if (pattern.endsWith('/*')) {
      const baseDir = path.join(rootDir, pattern.slice(0, -'/*'.length));
      if (!fs.existsSync(baseDir)) continue;
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.push(path.join(baseDir, entry.name));
      }
    } else {
      dirs.push(path.join(rootDir, pattern));
    }
  }
  return dirs;
}

/** Reads every workspace package directory named by `rootDir/package.json`'s
 * `workspaces` entries (see `resolveWorkspaceDirs`) and returns a Map from
 * package `name` to its absolute workspace directory. Skips any workspace
 * directory that has no package.json or no string `name`. */
function loadWorkspacePackageDirsByName(rootDir) {
  const byName = new Map();
  for (const dir of resolveWorkspaceDirs(rootDir)) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      byName.set(pkg.name, dir);
    }
  }
  return byName;
}

/** Returns the version-LOCKED `@lannguyensi/*` dependencies of `packageDir`
 * and, recursively, of every such sibling it finds -- a breadth-first walk
 * seeded with `packageDir` itself (excluded from the result) -- that are
 * themselves workspace packages resolvable via `loadWorkspacePackageDirsByName`
 * (i.e. an exact pin such as `"0.6.0"`, not a range like `"^0.3.0"`, scanning
 * both `dependencies` and `optionalDependencies`). Sorted by name for a
 * deterministic pack order; a package reachable by more than one path is
 * only visited, and returned, once.
 *
 * Derived from each package's own manifest, never hardcoded: this repo's
 * lockstep release PRs re-pin grounding-mcp's `claim-gate`/
 * `evidence-ledger`/`grounding-wrapper`/`hypothesis-tracker` dependencies to
 * the SAME PR's new version in the SAME commit that bumps those four
 * packages themselves (see e.g. commits 97dfa51, 20cf37f, 1433173) — so on
 * exactly those PRs, that new version does not exist on the public
 * registry yet. A scratch install of the grounding-mcp tarball ALONE would
 * resolve those pins from the registry (the only place it can look) and
 * fail with ETARGET on exactly the PRs this check most needs to pass
 * (reproduced by hand with the siblings bumped to an unpublished 0.7.0).
 * Packing every version-locked sibling too and installing all of them
 * together as local tarballs (see `run()`) makes npm satisfy those exact
 * pins from disk instead, independent of registry state — and because the
 * walk is BFS over each package's own dependency map (not copied out or
 * limited to one hop), a future version-locked sibling -- including one
 * pinned by another sibling rather than directly by grounding-mcp -- is
 * picked up automatically, with no edit to this file. Today, none of
 * grounding-mcp's four direct siblings themselves exact-pin a further
 * `@lannguyensi/*` package, so the walk currently terminates at depth 1 in
 * practice; see `check-grounding-mcp-pack.test.js`'s fixture-workspace
 * tests for the depth-2 (sibling-of-a-sibling) and optionalDependencies
 * cases this function actually implements.
 *
 * `runtime-reality-checker` (`"^0.3.0"` — a RANGE, not an exact pin) is
 * correctly excluded by the exact-pin check: its version is not re-pinned
 * in lockstep with grounding-mcp's own release. That assumption -- the
 * registry always has a version satisfying the range -- does not hold in
 * general (this repo has, at least once, held a sibling back from the
 * registry; see `docs/okf/log.md`); a range-pinned dependency is still
 * excluded here because installing a range spec against a co-packed local
 * tarball is not what npm reliably resolves, not because the assumption is
 * guaranteed.
 */
function findVersionLockedWorkspaceSiblings(rootDir, packageDir) {
  const byName = loadWorkspacePackageDirsByName(rootDir);
  const visitedDirs = new Set([packageDir]);
  const resultByName = new Map();
  const queue = [packageDir];
  while (queue.length > 0) {
    const currentDir = queue.shift();
    const pkg = JSON.parse(fs.readFileSync(path.join(currentDir, 'package.json'), 'utf8'));
    const depMaps = [pkg.dependencies || {}, pkg.optionalDependencies || {}];
    for (const deps of depMaps) {
      for (const [depName, depRange] of Object.entries(deps)) {
        if (!depName.startsWith(`${SCOPE}/`)) continue;
        if (typeof depRange !== 'string' || !EXACT_VERSION_RE.test(depRange)) continue;
        const dir = byName.get(depName);
        if (!dir) continue;
        if (visitedDirs.has(dir)) continue;
        visitedDirs.add(dir);
        resultByName.set(depName, dir);
        queue.push(dir);
      }
    }
  }
  const siblings = Array.from(resultByName, ([name, dir]) => ({ name, dir }));
  siblings.sort((a, b) => a.name.localeCompare(b.name));
  return siblings;
}

/** Runs `npm pack --pack-destination <destDir> --json` from `packageDir`
 * and returns the absolute path to the produced tarball. Throws if the
 * command fails, or if its `--json` output isn't the single-tarball array
 * shape `npm pack` documents. */
function packTarball(packageDir, destDir) {
  const output = execFileSync('npm', ['pack', '--pack-destination', destDir, '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    throw new Error(`"npm pack --json" produced unparseable output: ${err.message}\n${output}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== 'string') {
    throw new Error(`"npm pack --json" returned an unexpected shape: ${output}`);
  }
  return path.join(destDir, parsed[0].filename);
}

/** Reads the `version` field out of the tarball's OWN `package/package.json`
 * entry (not this repo's in-tree manifest). Throws if the entry is missing,
 * unparseable, or has no non-empty string `version`. */
function readTarballVersion(tgzPath) {
  const content = execFileSync('tar', ['-xOf', tgzPath, 'package/package.json'], { encoding: 'utf8' });
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch (err) {
    throw new Error(`tarball's package/package.json at ${tgzPath} is unparseable: ${err.message}`);
  }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`tarball's package/package.json at ${tgzPath} has no non-empty string "version" field`);
  }
  return pkg.version;
}

// Ceiling on the install call: a black-holed registry (unreachable, hanging
// TCP) previously hung this step well past the ci job's own
// `timeout-minutes: 10`, which then kills the whole job with a generic
// timeout instead of this check's own named failure. 5 minutes leaves room
// for a real (slow but working) install while still failing loudly, in this
// step, before the job-level ceiling would.
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Given an install error's message, names the `name@spec` npm's own stderr
 * says it could not resolve -- an ETARGET ("No matching version found for
 * X") or E404 ("requested resource 'X' could not be found") failure --  so
 * a range-pin (or a mis-co-packed sibling) failure is diagnosable from the
 * top-line message alone instead of npm's full multi-line stderr. Returns
 * `null` when the message matches neither shape. */
function extractUnresolvedDependency(message) {
  const targetMatch = message.match(/No matching version found for (\S+?)\.?(?:\n|$)/);
  if (targetMatch) return targetMatch[1];
  const notFoundMatch = message.match(/requested resource '([^']+)' could not be found/);
  if (notFoundMatch) return notFoundMatch[1];
  return null;
}

/** Installs every path in `tgzPaths` into `consumerDir` (created if needed)
 * in ONE `npm install --omit=dev --no-audit --no-fund --fetch-retries=2`
 * call, matching the manual verification's own install shape (plus a
 * bounded retry count and an overall timeout, see `INSTALL_TIMEOUT_MS`).
 * Installing every version-locked tarball together (rather than one call
 * per tarball), IN THE GIVEN ORDER, is required, not cosmetic: it is what
 * lets npm resolve the `@lannguyensi/*` pins among them from the local
 * files instead of the registry (see this module's own docblock and
 * `findVersionLockedWorkspaceSiblings`'s).
 *
 * `execFn` defaults to `execFileSync` and is injectable so tests can assert
 * on the exact argv (which tarballs, in which order, `--omit=dev`, cwd,
 * timeout) without a real npm install. A timeout-shaped `execFn` error
 * (Node's own child_process convention: `.killed === true` when the
 * process was killed for exceeding `timeout`) is re-thrown as a new error
 * naming the timeout explicitly, rather than the raw "Command failed"
 * message a hung process leaves; any other error (e.g. npm's own
 * ETARGET/E404 stderr) is re-thrown as-is so the caller still sees the
 * dependency `extractUnresolvedDependency` can name. */
function installTarballs(tgzPaths, consumerDir, execFn = execFileSync) {
  fs.mkdirSync(consumerDir, { recursive: true });
  try {
    execFn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--fetch-retries=2', ...tgzPaths], {
      cwd: consumerDir,
      stdio: 'pipe',
      timeout: INSTALL_TIMEOUT_MS,
    });
  } catch (err) {
    if (err && err.killed) {
      throw new Error(`install timed out after ${INSTALL_TIMEOUT_MS} ms; registry unreachable? (original error: ${err.message})`);
    }
    throw err;
  }
}

/** Path to the installed package's own package.json inside `consumerDir`'s
 * `node_modules`. */
function installedPackageJsonPath(consumerDir) {
  return path.join(consumerDir, 'node_modules', SCOPE, PACKAGE_NAME, 'package.json');
}

/** Applies an optional post-install corruption mode to the tree under
 * `consumerDir`, for the negative-control path. `mode` of `null`/`undefined`
 * is a no-op. Throws on an unknown mode rather than silently doing nothing. */
function corruptInstalledPackage(consumerDir, mode) {
  if (mode == null) return;
  if (mode === 'remove-package-json') {
    fs.rmSync(installedPackageJsonPath(consumerDir), { force: true });
    return;
  }
  throw new Error(`unknown corrupt mode: ${mode}`);
}

/** Runs the installed bin's `--version` from `consumerDir` (cwd set there,
 * matching the manual verification) and returns its trimmed stdout.
 *
 * `execFn` defaults to `execFileSync` and is injectable so tests can assert
 * on the exact bin path and cwd without a real process spawn. */
function runVersionCommand(consumerDir, execFn = execFileSync) {
  const binPath = path.join(consumerDir, 'node_modules', '.bin', BIN_NAME);
  const stdout = execFn(binPath, ['--version'], { cwd: consumerDir, encoding: 'utf8' });
  return stdout.trim();
}

/** Pure comparison: does the version the binary reported match the
 * tarball's own declared version? Returns `{ ok, message }`; `message`
 * names both values, but deliberately not the scratch consumer directory —
 * by the time anything reads this message the caller's `finally` has
 * already removed that tree (see `run()`), so a path in the message would
 * be a dead pointer, not a live one. */
function evaluateVersionMatch(reportedVersion, expectedVersion) {
  if (reportedVersion === expectedVersion) {
    return {
      ok: true,
      message: `"${BIN_NAME} --version" reported "${reportedVersion}", matching the packed tarball's own package.json version.`,
    };
  }
  return {
    ok: false,
    message:
      `"${BIN_NAME} --version" reported "${reportedVersion}" but the packed tarball's own ` +
      `package.json declares "${expectedVersion}" (the scratch consumer directory has already been removed).`,
  };
}

/** End-to-end run. `options.rootDir` defaults to the repo root;
 * `options.corrupt` (see module docblock) drives the negative-control
 * path; `options.execFn` (default `execFileSync`) is forwarded to
 * `installTarballs`/`runVersionCommand` only; `options.readVersionFn`
 * (default `readTarballVersion`) is forwarded ONLY to the expected-version
 * read -- packing itself always runs for real, since it needs to exist as
 * a real file for the rest of the run to make sense. Injecting `execFn`
 * lets a test exercise `run()`'s own real pack + sibling-discovery + argv-
 * construction wiring while skipping the real install and process spawn;
 * injecting `readVersionFn` lets a test assert it is called with the
 * packed grounding-mcp TARBALL path specifically, never this repo's
 * in-tree `packages/grounding-mcp/package.json` (the whole point of this
 * check -- see the module docblock) (see
 * check-grounding-mcp-pack.test.js). Returns a process exit code (0
 * clean, 1 on any failure). Scratch directories are always cleaned up. */
function run(options = {}) {
  const rootDir = options.rootDir ?? path.join(__dirname, '..');
  const corrupt = options.corrupt ?? null;
  const execFn = options.execFn ?? execFileSync;
  const readVersionFn = options.readVersionFn ?? readTarballVersion;
  const packageDir = path.join(rootDir, PACKAGE_RELATIVE_DIR);
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-mcp-pack-check-'));
  const packDir = path.join(tmpBase, 'pack');
  const consumerDir = path.join(tmpBase, 'consumer');

  try {
    fs.mkdirSync(packDir, { recursive: true });

    let siblings;
    try {
      siblings = findVersionLockedWorkspaceSiblings(rootDir, packageDir);
    } catch (err) {
      console.error(
        `grounding-mcp pack check failed: could not determine version-locked workspace siblings of ${packageDir}: ${err.message}`,
      );
      return 1;
    }

    let tgzPath;
    const siblingTgzPaths = [];
    try {
      tgzPath = packTarball(packageDir, packDir);
      for (const sibling of siblings) {
        siblingTgzPaths.push(packTarball(sibling.dir, packDir));
      }
    } catch (err) {
      console.error(
        `grounding-mcp pack check failed: could not pack ${packageDir} or one of its version-locked siblings: ${err.message}`,
      );
      return 1;
    }

    let expectedVersion;
    try {
      expectedVersion = readVersionFn(tgzPath);
    } catch (err) {
      console.error(`grounding-mcp pack check failed: ${err.message}`);
      return 1;
    }

    try {
      installTarballs([...siblingTgzPaths, tgzPath], consumerDir, execFn);
    } catch (err) {
      const unresolved = extractUnresolvedDependency(err.message || '');
      const unresolvedNote = unresolved ? ` (unresolved dependency: ${unresolved})` : '';
      console.error(
        `grounding-mcp pack check failed: could not install ${tgzPath} (with ${siblingTgzPaths.length} version-locked sibling tarball(s)): ${err.message}${unresolvedNote} (the scratch consumer directory has already been removed).`,
      );
      return 1;
    }

    try {
      corruptInstalledPackage(consumerDir, corrupt);
    } catch (err) {
      console.error(`grounding-mcp pack check failed: ${err.message}`);
      return 1;
    }

    let reportedVersion;
    try {
      reportedVersion = runVersionCommand(consumerDir, execFn);
    } catch (err) {
      console.error(
        `grounding-mcp pack check failed: could not run "${BIN_NAME} --version": ${err.message} (the scratch consumer directory has already been removed).`,
      );
      return 1;
    }

    const result = evaluateVersionMatch(reportedVersion, expectedVersion);
    if (!result.ok) {
      console.error(`grounding-mcp pack check failed: ${result.message}`);
      return 1;
    }
    console.log(`grounding-mcp pack check passed: ${result.message}`);
    return 0;
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

/** Parses `--corrupt=<mode>` out of an argv-shaped array (`process.argv` or
 * a fixture). Returns the mode string as-is, or `null` when no such
 * argument is present -- does NOT validate the mode itself;
 * `corruptInstalledPackage` rejects an unrecognized one downstream. */
function parseCorruptArg(argv) {
  const corruptArg = argv.find((a) => a.startsWith('--corrupt='));
  return corruptArg ? corruptArg.slice('--corrupt='.length) : null;
}

function main() {
  const corrupt = parseCorruptArg(process.argv);
  process.exitCode = run({ corrupt });
}

module.exports = {
  PACKAGE_RELATIVE_DIR,
  SCOPE,
  PACKAGE_NAME,
  BIN_NAME,
  INSTALL_TIMEOUT_MS,
  loadWorkspacePackageDirsByName,
  findVersionLockedWorkspaceSiblings,
  packTarball,
  readTarballVersion,
  installTarballs,
  extractUnresolvedDependency,
  installedPackageJsonPath,
  corruptInstalledPackage,
  runVersionCommand,
  evaluateVersionMatch,
  parseCorruptArg,
  run,
};

if (require.main === module) {
  main();
}
