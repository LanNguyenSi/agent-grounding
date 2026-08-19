// Producer-side mirror of harness' HMAC marker signing (harness/f9485cc7,
// harness/c7c3f606) for the solution-acceptance verdict marker.
//
// grounding-mcp is the PRODUCER of that marker (`writeVerdict` in
// solution-verdict.ts); harness is the CONSUMER
// (src/policy-packs/builtin/solution-acceptance-runtime.ts,
// verifyVerdictSignature). This module signs with the SAME key file, the
// SAME HMAC scheme, and the SAME canonical payload the consumer verifies
// with, so a marker this package writes satisfies the consumer's signature
// check without either side depending on the other's package (D-001, task
// 9b6c4beb / grounding-mcp CHANGELOG 0.8.0: independent mirror chosen over a
// shared package because it is consistent with the shipped consumer's own
// design and avoids a new cross-repo architecture decision) — the same
// independent-mirroring convention `verdictDir()` / `sanitizeVerdictId()`
// in solution-verdict.ts already use.
//
// Contract mirrored, field-for-field and byte-for-byte, from harness
// (origin/batch19/sign-verdict-marker):
//   - src/runtime/approval-signing.ts: SIGNING_ALG, SIGNING_KEY_BASENAME,
//     signingKeyPathFor, getOrCreateSigningKey, canonicalPayload, signMarker.
//   - src/policy-packs/builtin/solution-acceptance-runtime.ts:
//     VERDICT_MARKER_ID_PREFIX, verdictMarkerId, verdictContentHash,
//     signVerdict.
//   - src/io/generated-dir.ts: resolveGeneratedDir (homeDir + "harness.generated").
//   - src/runtime/home-dir.ts: resolveHomeDir precedence (minus the
//     explicit `--home` CLI-flag tier, which grounding-mcp has no
//     equivalent of).
//
// Any drift from the consumer's implementation here produces a marker that
// LOOKS signed but never verifies — a silent universal deny on the harness
// side. Keep this file's constants and payload shapes textually identical
// to the harness source above; a change there must be mirrored here.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Versioned algorithm tag (mirrors harness `SIGNING_ALG`). */
export const SIGNING_ALG = 'hmac-sha256-v1';

/** Basename of the signing-key file, a sibling of `.approvals/` under `generatedDir` (mirrors harness `SIGNING_KEY_BASENAME`). */
export const SIGNING_KEY_BASENAME = '.approval-signing.key';

/** `harness.generated/` dirname (mirrors harness `GENERATED_DIRNAME`). */
export const GENERATED_DIRNAME = 'harness.generated';

/** New (v0.24.0+) harness home-dir basename (mirrors harness `HARNESS_HOME_DIRNAME`). */
export const HARNESS_HOME_DIRNAME = '.harness';

/** Legacy harness home-dir basename (mirrors harness `LEGACY_HARNESS_HOME_DIRNAME`). */
export const LEGACY_HARNESS_HOME_DIRNAME = '.claude';

/** Env var pinning the harness home dir (mirrors harness `HARNESS_HOME_ENV`). */
export const HARNESS_HOME_ENV = 'HARNESS_HOME';

const KEY_BYTES = 32;

/**
 * Marker-id namespace the verdict's HMAC signature is bound to (mirrors
 * harness `VERDICT_MARKER_ID_PREFIX`): keeps a signed verdict's id space
 * disjoint from the understanding-gate / branch-protection marker id
 * spaces, so a validly-signed marker from one space can never be replayed
 * as a validly-signed marker in another.
 */
export const VERDICT_MARKER_ID_PREFIX = 'solution-verdict-';

/** The HMAC markerId for verdict `id` (mirrors harness `verdictMarkerId`). */
export function verdictMarkerId(id: string): string {
  return `${VERDICT_MARKER_ID_PREFIX}${id}`;
}

/**
 * Resolve the harness state-root directory. Mirrors `resolveHomeDir` in
 * harness `src/runtime/home-dir.ts`:
 *   1. `$HARNESS_HOME` env var (pin without flag; also the test-isolation
 *      knob — tests must set this to a tempdir and never touch the real
 *      home directory).
 *   2. `~/.harness/` if it exists on disk.
 *   3. `~/.claude/` if it carries harness state (`harness.yaml` or
 *      `harness.generated/`) — legacy fallback.
 *   4. `~/.harness/` as the create-on-first-use default.
 *
 * Grounding-mcp has no `--home` CLI flag, so the explicit-override tier
 * harness's own resolver has ahead of its env tier has no equivalent here.
 *
 * `userHome` mirrors harness `resolveHomeDir`'s own `opts.userHome` test
 * seam (`src/runtime/home-dir.ts`): an injectable override for the
 * OPERATOR's `$HOME` the tiers below the env var anchor on, defaulting to
 * `os.homedir()`. Signature-compatible with every existing zero-arg call
 * site. Added (D-005, task 9b6c4beb / grounding-mcp CHANGELOG 0.8.0: review
 * found the deeper home-resolution tiers were only exercised transitively)
 * because `vi.spyOn(os, 'homedir')` was tried and confirmed NOT to redirect the
 * call inside this module under this package's ESM/vitest setup — an
 * explicit parameter is the only reliable test-injection point for the
 * `~/.harness`-exists / `~/.claude`-legacy / create-default tiers, which
 * previously could only be exercised transitively via the real host home
 * directory (a risk this override removes).
 */
export function resolveHarnessHome(userHome: string = os.homedir()): string {
  const envValue = process.env[HARNESS_HOME_ENV];
  if (typeof envValue === 'string' && envValue.length > 0) return envValue;

  const newPath = path.join(userHome, HARNESS_HOME_DIRNAME);
  const legacyPath = path.join(userHome, LEGACY_HARNESS_HOME_DIRNAME);

  if (existsDir(newPath)) return newPath;
  if (legacyHasHarnessState(legacyPath)) return legacyPath;
  return newPath;
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function legacyHasHarnessState(legacyPath: string): boolean {
  try {
    if (fs.existsSync(path.join(legacyPath, 'harness.yaml'))) return true;
    if (fs.existsSync(path.join(legacyPath, 'harness.generated'))) return true;
  } catch {
    /* fall through to false */
  }
  return false;
}

/** `<home>/harness.generated` (mirrors harness `resolveGeneratedDir({ homeDir })`). */
export function resolveGeneratedDir(): string {
  return path.join(resolveHarnessHome(), GENERATED_DIRNAME);
}

/** Filesystem path of the signing key for a given `generatedDir` (mirrors harness `signingKeyPathFor`). */
export function signingKeyPathFor(generatedDir: string): string {
  return path.join(generatedDir, SIGNING_KEY_BASENAME);
}

export interface SigningKeyHandle {
  key: Buffer;
  filePath: string;
  /** True when this call generated a fresh key (first use, post-rotation, or repair of a truncated key file). */
  created: boolean;
}

/**
 * Read the signing key at `resolveSigningKeyPath(generatedDir)` (env first,
 * see EOF), creating one (0600, 32B) on first use. Mirrors harness incl. its
 * race-tolerant exclusive (`wx`) create and its truncated-key-file repair
 * path: a key file shorter than `KEY_BYTES` is treated as corrupt and
 * unconditionally regenerated (a short key would only ever weaken future
 * signatures), while a concurrent creator that wins the `wx` race is read
 * back rather than clobbered.
 */
export function getOrCreateSigningKey(generatedDir: string): SigningKeyHandle {
  const filePath = resolveSigningKeyPath(generatedDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let fileExisted = false;
  try {
    const existing = fs.readFileSync(filePath);
    fileExisted = true;
    if (existing.length >= KEY_BYTES) {
      return { key: existing, filePath, created: false };
    }
    // Falls through: truncated/corrupt key file, regenerate below.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const fresh = crypto.randomBytes(KEY_BYTES);
  if (fileExisted) {
    // Known-corrupt/truncated file: overwrite unconditionally (`w`, not
    // `wx` — an exclusive create would collide with the file that is
    // already known bad and re-read the same short bytes back).
    fs.writeFileSync(filePath, fresh, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort */
    }
    return { key: fresh, filePath, created: true };
  }
  try {
    fs.writeFileSync(filePath, fresh, { mode: 0o600, flag: 'wx' });
    return { key: fresh, filePath, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the create race to a concurrent caller; use what they wrote.
      return { key: fs.readFileSync(filePath), filePath, created: false };
    }
    throw err;
  }
}

/** sha256 hex digest of a string (mirrors harness `sha256Hex`). */
export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Canonical JSON the HMAC is computed over. Fixed key order makes this
 * injective (no two distinct tuples encode to the same string) and, more
 * importantly, must byte-match harness `canonicalPayload` — the consumer
 * recomputes this exact string to verify. Field order here is
 * load-bearing: reordering it changes every future signature's bytes and
 * makes them unverifiable against the harness consumer.
 */
export function canonicalPayload(
  markerId: string,
  approvedAt: string,
  approvedBy: string,
  reportContentHash: string | null,
): string {
  return JSON.stringify({ markerId, approvedAt, approvedBy, reportContentHash });
}

export interface SignedMarkerFields {
  approvedAt: string;
  approvedBy: string;
  reportContentHash: string | null;
  alg: string;
  signature: string;
}

/**
 * Sign a marker's fields for `markerId` (mirrors harness `signMarker`).
 * Binding `markerId` into the signed payload is what stops a validly-signed
 * marker from being copied/renamed onto a different id and still verifying.
 */
export function signMarker(
  generatedDir: string,
  markerId: string,
  marker: { approvedAt: string; approvedBy: string; reportContentHash?: string | null },
): SignedMarkerFields {
  const { key } = getOrCreateSigningKey(generatedDir);
  const reportContentHash = marker.reportContentHash ?? null;
  const signature = crypto
    .createHmac('sha256', key)
    .update(canonicalPayload(markerId, marker.approvedAt, marker.approvedBy, reportContentHash))
    .digest('hex');
  return {
    approvedAt: marker.approvedAt,
    approvedBy: marker.approvedBy,
    reportContentHash,
    alg: SIGNING_ALG,
    signature,
  };
}

/**
 * The verdict fields the signature must bind BEYOND `(markerId, approvedAt,
 * approvedBy)` — i.e. the fields `signMarker`'s fixed
 * `{approvedAt, approvedBy, reportContentHash}` shape has no dedicated slot
 * for. Reusing that slot for this hash means `head` / `ready` /
 * `confidence` / `blockers` are ALL covered by the signature: mutating any
 * one of them after signing changes this hash and invalidates the
 * signature. Mirrors harness `verdictContentHash`; fixed key order is
 * load-bearing for the same reason as `canonicalPayload`.
 */
function verdictContentHash(v: {
  head: string;
  ready: boolean;
  confidence: number;
  blockers: string[];
}): string {
  return sha256Hex(
    JSON.stringify({ head: v.head, ready: v.ready, confidence: v.confidence, blockers: v.blockers }),
  );
}

/**
 * Sign `verdict`, mapping its fields onto `signMarker`'s fixed shape the
 * SAME way the harness consumer does when it recomputes and checks a
 * signature (mirrors harness `signVerdict`):
 *   - `approvedAt` <- `verdict.timestamp`
 *   - `approvedBy` <- `verdict.source`
 *   - `reportContentHash` <- `verdictContentHash(verdict)`
 *
 * Returns a NEW object with `alg` / `signature` added; does not mutate the
 * input. Generic over `V` (rather than importing `Verdict` from
 * solution-verdict.ts) to avoid a circular module dependency — the caller
 * in solution-verdict.ts already has the concrete `Verdict` type.
 */
export function signVerdict<
  V extends {
    id: string;
    head: string;
    ready: boolean;
    confidence: number;
    blockers: string[];
    timestamp: string;
    source: string;
  },
>(generatedDir: string, verdict: V): V & { alg: string; signature: string } {
  const signed = signMarker(generatedDir, verdictMarkerId(verdict.id), {
    approvedAt: verdict.timestamp,
    approvedBy: verdict.source,
    reportContentHash: verdictContentHash(verdict),
  });
  return { ...verdict, alg: signed.alg, signature: signed.signature };
}

/**
 * Env var carrying the ABSOLUTE path of the signing-key FILE, projected by
 * harness at apply time onto this MCP server's env (slice H1 of the
 * operator-decided Option 2 design, task 9b6c4beb: harness resolves its
 * own `<generatedDir>/.approval-signing.key` and writes the resolved path
 * here, following its `EVIDENCE_LEDGER_DB` projection pattern). When set,
 * it is authoritative and removes the one ambiguity the mirrored home
 * resolution cannot close (a harness run under `--config` / a non-default
 * home). Expected to be an already-resolved absolute path (no `~`).
 */
export const SIGNING_KEY_ENV = 'SOLUTION_VERDICT_SIGNING_KEY';

/**
 * Resolve the signing-key FILE path: `SOLUTION_VERDICT_SIGNING_KEY` env
 * projection first, else the harness-mirrored `<generatedDir>` resolution
 * (the documented fallback for non-harness-managed setups). `getOrCreate`
 * semantics apply at the resolved path either way, so whichever side runs
 * first (producer or consumer) creates the shared key race-tolerantly.
 */
export function resolveSigningKeyPath(generatedDir: string = resolveGeneratedDir()): string {
  const envValue = process.env[SIGNING_KEY_ENV];
  if (typeof envValue === 'string' && envValue.length > 0) return envValue;
  return signingKeyPathFor(generatedDir);
}
