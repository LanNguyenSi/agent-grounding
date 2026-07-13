/**
 * Dist-artifact regression test for the CLI --version flag.
 *
 * The --version test in index.test.ts exercises buildProgram() from src/,
 * which resolves package.json via __dirname relative to the TS source file
 * under ts-jest. That proves the wiring is correct today, but it can't
 * catch a rootDir/outDir change that makes the *built* dist/index.js
 * resolve a different relative path (e.g. dist landing at dist/src/index.js
 * would resolve one level too high, printing 0.0.0). This test runs the
 * actual built CLI as a subprocess and asserts its printed version matches
 * package.json, so a broken build layout fails here even if the src-level
 * test stays green.
 *
 * Requires `npm run build` to have produced dist/index.js first. CI always
 * builds before testing (see .github/workflows/ci.yml); this test
 * intentionally fails loudly with a clear message instead of silently
 * skipping when dist/ has not been built.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DIST_ENTRY = join(__dirname, '../../dist/index.js');
const PKG_JSON = join(__dirname, '../../package.json');

describe('--version (built dist CLI)', () => {
  it('prints the version from package.json when run as a built subprocess', () => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(
        `${DIST_ENTRY} is missing. Run \`npm run build\` in packages/domain-router before testing ` +
          '(CI always builds before test in .github/workflows/ci.yml; this test intentionally fails ' +
          'loudly instead of silently skipping when dist/ has not been built).',
      );
    }
    const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8')) as { version: string };
    const output = execFileSync(process.execPath, [DIST_ENTRY, '--version']).toString().trim();
    expect(output).toBe(pkg.version);
  });
});
