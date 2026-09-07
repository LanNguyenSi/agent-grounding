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
 *   1. `npm pack` the `@lannguyensi/grounding-mcp` workspace package into a
 *      scratch pack directory (`--json` for a reliable filename).
 *   2. Read the tarball's OWN `package.json` `version` field (`tar -xOf`),
 *      not this repo's in-tree `packages/grounding-mcp/package.json` — the
 *      whole point is asserting against what actually shipped in the
 *      artifact, not the source tree it was built from.
 *   3. Install the tarball with `--omit=dev` into a scratch consumer
 *      directory created under `os.tmpdir()` (outside the repo tree, like
 *      the manual verification), so resolution is exercised exactly the
 *      way a real downstream consumer would see it — no repo-relative path
 *      trickery, no workspace symlink.
 *   4. Run the installed `grounding-mcp` bin with `--version` from that
 *      consumer directory and assert its (trimmed) stdout equals the
 *      tarball's own version.
 *
 * One pack, one install, one process spawn — matches the manual check's own
 * footprint, no extra passes.
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

/** Installs `tgzPath` into `consumerDir` (created if needed) with
 * `--omit=dev --no-audit --no-fund`, matching the manual verification's own
 * install shape. */
function installTarball(tgzPath, consumerDir) {
  fs.mkdirSync(consumerDir, { recursive: true });
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', tgzPath], {
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
 * matching the manual verification) and returns its trimmed stdout. */
function runVersionCommand(consumerDir) {
  const binPath = path.join(consumerDir, 'node_modules', '.bin', BIN_NAME);
  const stdout = execFileSync(binPath, ['--version'], { cwd: consumerDir, encoding: 'utf8' });
  return stdout.trim();
}

/** Pure comparison: does the version the binary reported match the
 * tarball's own declared version? Returns `{ ok, message }`; `message`
 * names both values and `consumerDir` on a mismatch, so a CI failure is
 * self-explanatory without re-running anything. */
function evaluateVersionMatch(reportedVersion, expectedVersion, consumerDir) {
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
      `package.json declares "${expectedVersion}" (scratch consumer: ${consumerDir}).`,
  };
}

/** End-to-end run. `options.rootDir` defaults to the repo root;
 * `options.corrupt` (see module docblock) drives the negative-control
 * path. Returns a process exit code (0 clean, 1 on any failure). Scratch
 * directories are always cleaned up. */
function run(options = {}) {
  const rootDir = options.rootDir ?? path.join(__dirname, '..');
  const corrupt = options.corrupt ?? null;
  const packageDir = path.join(rootDir, PACKAGE_RELATIVE_DIR);
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-mcp-pack-check-'));
  const packDir = path.join(tmpBase, 'pack');
  const consumerDir = path.join(tmpBase, 'consumer');
  fs.mkdirSync(packDir, { recursive: true });

  try {
    let tgzPath;
    try {
      tgzPath = packTarball(packageDir, packDir);
    } catch (err) {
      console.error(`grounding-mcp pack check failed: could not pack ${packageDir}: ${err.message}`);
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
      installTarball(tgzPath, consumerDir);
    } catch (err) {
      console.error(`grounding-mcp pack check failed: could not install ${tgzPath} into ${consumerDir}: ${err.message}`);
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
      reportedVersion = runVersionCommand(consumerDir);
    } catch (err) {
      console.error(
        `grounding-mcp pack check failed: could not run "${BIN_NAME} --version" from ${consumerDir}: ${err.message}`,
      );
      return 1;
    }

    const result = evaluateVersionMatch(reportedVersion, expectedVersion, consumerDir);
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
  packTarball,
  readTarballVersion,
  installTarball,
  installedPackageJsonPath,
  corruptInstalledPackage,
  runVersionCommand,
  evaluateVersionMatch,
  run,
};

if (require.main === module) {
  main();
}
