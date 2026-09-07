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
 *      check with an ETARGET resolving them off the public registry
 *      (review finding F1, task d341afd5 round 2).
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
 * see scripts/check-grounding-mcp-pack.test.js's own header for why the
 * CI job as a whole now does two such rounds, not three).
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

// Matches an exact semver ("0.6.0", "1.2.3-beta.1") and rejects any range
// operator ("^0.6.0", "~0.6.0", ">=0.6.0", "0.6.x", "*", a git/tag/alias
// spec, ...). Deliberately conservative: anything that isn't unambiguously
// an exact pin is treated as a range and excluded from co-packing.
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

/** Reads every `packages/*\/package.json` under `rootDir` and returns a Map
 * from package `name` to its absolute workspace directory. Skips any
 * workspace directory that has no package.json or no string `name`. */
function loadWorkspacePackageDirsByName(rootDir) {
  const packagesDir = path.join(rootDir, 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const byName = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      byName.set(pkg.name, path.join(packagesDir, entry.name));
    }
  }
  return byName;
}

/** Returns the version-LOCKED `@lannguyensi/*` dependencies `packageDir`'s
 * own package.json declares that are themselves workspace packages under
 * `rootDir/packages` — i.e. an exact pin (`"0.6.0"`), not a range
 * (`"^0.3.0"`). Sorted by name for a deterministic pack order.
 *
 * Derived from the manifest, never hardcoded: this repo's lockstep release
 * PRs re-pin grounding-mcp's `claim-gate`/`evidence-ledger`/
 * `grounding-wrapper`/`hypothesis-tracker` dependencies to the SAME PR's
 * new version in the SAME commit that bumps those four packages themselves
 * (see e.g. commits 97dfa51, 20cf37f, 1433173) — so on exactly those PRs,
 * that new version does not exist on the public registry yet. A scratch
 * install of the grounding-mcp tarball ALONE would resolve those pins from
 * the registry (the only place it can look) and fail with ETARGET on
 * exactly the PRs this check most needs to pass (review finding F1, task
 * d341afd5 round 2; reproduced by hand with the siblings bumped to an
 * unpublished 0.7.0). Packing every version-locked sibling too and
 * installing all of them together as local tarballs (see `run()`) makes
 * npm satisfy those exact pins from disk instead, independent of registry
 * state — and because the list here is derived from the dependency map
 * rather than copied out, a fifth future version-locked sibling is picked
 * up automatically, with no edit to this file.
 *
 * `runtime-reality-checker` (`"^0.3.0"` — a RANGE, not an exact pin) is
 * correctly excluded by the exact-pin check: its version is not re-pinned
 * in lockstep with grounding-mcp's own release, so the registry always has
 * a version satisfying the range.
 */
function findVersionLockedWorkspaceSiblings(rootDir, packageDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const deps = pkg.dependencies || {};
  const byName = loadWorkspacePackageDirsByName(rootDir);
  const siblings = [];
  for (const [depName, depRange] of Object.entries(deps)) {
    if (!depName.startsWith(`${SCOPE}/`)) continue;
    if (typeof depRange !== 'string' || !EXACT_VERSION_RE.test(depRange)) continue;
    const dir = byName.get(depName);
    if (!dir) continue;
    siblings.push({ name: depName, dir });
  }
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

/** Installs every path in `tgzPaths` into `consumerDir` (created if needed)
 * in ONE `npm install --omit=dev --no-audit --no-fund` call, matching the
 * manual verification's own install shape. Installing every version-locked
 * tarball together (rather than one call per tarball) is required, not
 * cosmetic: it is what lets npm resolve the `@lannguyensi/*` pins among
 * them from the local files instead of the registry (see this module's own
 * docblock and `findVersionLockedWorkspaceSiblings`'s).
 *
 * `execFn` defaults to `execFileSync` and is injectable so tests can assert
 * on the exact argv (which tarballs, `--omit=dev`, cwd) without a real npm
 * install. */
function installTarballs(tgzPaths, consumerDir, execFn = execFileSync) {
  fs.mkdirSync(consumerDir, { recursive: true });
  execFn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', ...tgzPaths], {
    cwd: consumerDir,
    stdio: 'pipe',
  });
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
 * `installTarballs`/`runVersionCommand` only -- packing and reading the
 * tarball version always run for real, since those need to exist as real
 * files for the rest of the run to make sense. Injecting `execFn` lets a
 * test exercise `run()`'s own real pack + sibling-discovery + argv-
 * construction wiring while skipping the real install and process spawn
 * (see check-grounding-mcp-pack.test.js). Returns a process exit code (0
 * clean, 1 on any failure). Scratch directories are always cleaned up. */
function run(options = {}) {
  const rootDir = options.rootDir ?? path.join(__dirname, '..');
  const corrupt = options.corrupt ?? null;
  const execFn = options.execFn ?? execFileSync;
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
      expectedVersion = readTarballVersion(tgzPath);
    } catch (err) {
      console.error(`grounding-mcp pack check failed: ${err.message}`);
      return 1;
    }

    try {
      installTarballs([...siblingTgzPaths, tgzPath], consumerDir, execFn);
    } catch (err) {
      console.error(
        `grounding-mcp pack check failed: could not install ${tgzPath} (with ${siblingTgzPaths.length} version-locked sibling tarball(s)) into ${consumerDir}: ${err.message}`,
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
        `grounding-mcp pack check failed: could not run "${BIN_NAME} --version" from ${consumerDir}: ${err.message}`,
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

function main() {
  const corruptArg = process.argv.find((a) => a.startsWith('--corrupt='));
  const corrupt = corruptArg ? corruptArg.slice('--corrupt='.length) : null;
  process.exitCode = run({ corrupt });
}

module.exports = {
  PACKAGE_RELATIVE_DIR,
  SCOPE,
  PACKAGE_NAME,
  BIN_NAME,
  loadWorkspacePackageDirsByName,
  findVersionLockedWorkspaceSiblings,
  packTarball,
  readTarballVersion,
  installTarballs,
  installedPackageJsonPath,
  corruptInstalledPackage,
  runVersionCommand,
  evaluateVersionMatch,
  run,
};

if (require.main === module) {
  main();
}
