// TEST-ONLY vendored mirror of harness' CONSUMER-side verdict-signature
// verification + gate decision. NEVER import this from production code
// (packages/grounding-mcp/src/**) — it exists solely so
// verdict-signing-interop.test.ts can prove, in THIS repo's CI, that a
// marker `writeVerdict` (src/solution-verdict.ts) produces is accepted by
// harness' real verification logic, and that tampering/relabeling is
// rejected with the exact reasons harness gives.
//
// Deliberately transcribed from the CONSUMER (harness) source, not derived
// from this package's own `src/verdict-signing.ts` (the PRODUCER mirror) —
// copying the producer module here would make this suite test the
// producer's mirror against itself ("the mirror testing the mirror"),
// which cannot catch a drift between the two independently-mirrored
// implementations. Per D-001/D-003
// (.ai/runs/2026-08-19-verdict-signing-producer/03-decisions.md) that drift
// is exactly the risk this interop suite exists to catch.
//
// SOURCE STAMP — transcribed verbatim (constants, control flow, literal
// reason strings) from:
//   repo:   github.com/LanNguyenSi/harness
//   branch: origin/batch19/sign-verdict-marker
//   commit: 444908cd7aeab894e23c4600ff55518300dff06f (2026-08-19T08:37:27+02:00)
//   files:
//     - src/runtime/approval-signing.ts
//         :98-101   SIGNING_ALG, SIGNING_KEY_BASENAME
//         :103      KEY_BYTES
//         :106-124  signingKeyPathFor
//         :125-179  getOrCreateSigningKey
//         :190-193  sha256Hex
//         :194-206  canonicalPayload
//         :246-273  SignatureVerification (type)
//         :274-327  verifyMarkerSignature
//     - src/policy-packs/builtin/solution-acceptance-runtime.ts
//         :158-179  Verdict (interface)
//         :182-187  VERDICT_MARKER_ID_PREFIX, verdictMarkerId
//         :200-206  verdictContentHash
//         :262-286  verifyVerdictSignature
//         :408-438  GateResult (interface)
//         :458-459  MISSING_APPROVED_AT_REASON, MISSING_APPROVED_BY_REASON
//         :496-598  evaluateGate
//     - src/io/generated-dir.ts
//         :10       GENERATED_DIRNAME (doc reference only; the interop test
//                    locates generatedDir via the PRODUCER's own
//                    `resolveGeneratedDir()`, since that is the directory
//                    the marker under test was actually signed into)
//
// If harness changes any of the above, this file drifts silently until the
// interop suite is re-run against a fresh checkout of that branch/commit and
// this stamp is updated. There is no automated staleness check; the stamp
// is what makes a manual re-check possible.
//
// Copied date: 2026-08-19.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Mirrors harness `SIGNING_ALG` (approval-signing.ts:98). */
export const SIGNING_ALG = 'hmac-sha256-v1';

/** Mirrors harness `SIGNING_KEY_BASENAME` (approval-signing.ts:101). */
export const SIGNING_KEY_BASENAME = '.approval-signing.key';

const KEY_BYTES = 32;

/** Mirrors harness `signingKeyPathFor` (approval-signing.ts:106-124). */
export function signingKeyPathFor(generatedDir: string): string {
  return path.join(generatedDir, SIGNING_KEY_BASENAME);
}

export interface SigningKeyHandle {
  key: Buffer;
  filePath: string;
  created: boolean;
}

/**
 * Mirrors harness `getOrCreateSigningKey` (approval-signing.ts:125-179)
 * exactly, including the truncated-key repair path (`w`, not `wx`, when a
 * short existing file is found) and the exclusive-create race fallback
 * (`wx` EEXIST -> read back the winner's key instead of throwing). The
 * verifier calls this itself (not just the producer) — a marker only
 * verifies when both sides land on the SAME key file.
 */
export function getOrCreateSigningKey(generatedDir: string): SigningKeyHandle {
  const filePath = signingKeyPathFor(generatedDir);
  fs.mkdirSync(generatedDir, { recursive: true });
  let fileExisted = false;
  try {
    const existing = fs.readFileSync(filePath);
    fileExisted = true;
    if (existing.length >= KEY_BYTES) {
      return { key: existing, filePath, created: false };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const fresh = crypto.randomBytes(KEY_BYTES);
  if (fileExisted) {
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
      return { key: fs.readFileSync(filePath), filePath, created: false };
    }
    throw err;
  }
}

/** Mirrors harness `sha256Hex` (approval-signing.ts:190-193). */
export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Mirrors harness `canonicalPayload` (approval-signing.ts:194-206). Fixed
 * key order is load-bearing: this must byte-match what the producer signed
 * over.
 */
function canonicalPayload(
  markerId: string,
  approvedAt: string,
  approvedBy: string,
  reportContentHash: string | null,
): string {
  return JSON.stringify({ markerId, approvedAt, approvedBy, reportContentHash });
}

/** Mirrors harness `SignatureVerification` (approval-signing.ts:246-273). */
export type SignatureVerification =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      kind?: 'key-unavailable';
    };

/**
 * Mirrors harness `verifyMarkerSignature` (approval-signing.ts:274-327)
 * field-for-field, including:
 *   - the exact literal reason strings (a caller test asserts against
 *     these, so wording drift here would silently defeat the pin);
 *   - the check ORDER (approvedAt, then approvedBy, then signature, then
 *     alg) — this determines WHICH reason a given malformed payload gets,
 *     which is itself part of the contract `evaluateGate`'s carve-out
 *     logic below depends on;
 *   - `Buffer.from(signature, 'hex')` with no try/catch (hex decoding never
 *     throws, it silently truncates on the first invalid pair — the
 *     length-mismatch check below is what actually rejects that case);
 *   - the length precheck BEFORE `timingSafeEqual` (`timingSafeEqual`
 *     throws on mismatched buffer lengths rather than returning false, so
 *     skipping this check would crash instead of reject on a
 *     wrong-length/garbled signature).
 */
export function verifyMarkerSignature(
  generatedDir: string,
  markerId: string,
  payload: Record<string, unknown>,
): SignatureVerification {
  const approvedAt = payload['approvedAt'];
  const approvedBy = payload['approvedBy'];
  const signature = payload['signature'];
  const alg = payload['alg'];
  if (typeof approvedAt !== 'string' || approvedAt.length === 0) {
    return { ok: false, reason: 'missing approvedAt' };
  }
  if (typeof approvedBy !== 'string' || approvedBy.length === 0) {
    return { ok: false, reason: 'missing approvedBy' };
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return {
      ok: false,
      reason: 'missing signature (legacy pre-signing marker, or forged file)',
    };
  }
  if (alg !== SIGNING_ALG) {
    return { ok: false, reason: `unrecognized or missing alg (got ${JSON.stringify(alg)})` };
  }
  const reportContentHash =
    typeof payload['reportContentHash'] === 'string' ? (payload['reportContentHash'] as string) : null;
  let key: Buffer;
  try {
    ({ key } = getOrCreateSigningKey(generatedDir));
  } catch (err) {
    return {
      ok: false,
      reason: `signing key unavailable (${err instanceof Error ? err.message : String(err)})`,
      kind: 'key-unavailable',
    };
  }
  const expected = crypto
    .createHmac('sha256', key)
    .update(canonicalPayload(markerId, approvedAt, approvedBy, reportContentHash))
    .digest();
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'signature verification failed (tampered or forged)' };
  }
  return { ok: true };
}

/**
 * Mirrors harness `Verdict` (solution-acceptance-runtime.ts:158-179).
 * Deliberately its OWN structural type, not imported from this package's
 * `src/solution-verdict.ts` — the point of this file is to check the
 * producer's OUTPUT (plain JSON parsed off disk) against an independent
 * expectation of its shape, not to share a type with the code being tested.
 */
export interface Verdict {
  id: string;
  head: string;
  ready: boolean;
  confidence: number;
  blockers: string[];
  timestamp: string;
  source: string;
  alg?: string;
  signature?: string;
}

/** Mirrors harness `VERDICT_MARKER_ID_PREFIX` (solution-acceptance-runtime.ts:182). */
export const VERDICT_MARKER_ID_PREFIX = 'solution-verdict-';

/** Mirrors harness `verdictMarkerId` (solution-acceptance-runtime.ts:185-187). */
export function verdictMarkerId(id: string): string {
  return `${VERDICT_MARKER_ID_PREFIX}${id}`;
}

/**
 * Mirrors harness `verdictContentHash` (solution-acceptance-runtime.ts:200-206).
 * Binds `head`/`ready`/`confidence`/`blockers` into the signature via the
 * `reportContentHash` slot `signMarker`'s fixed payload shape has no
 * dedicated field for.
 */
function verdictContentHash(v: Pick<Verdict, 'head' | 'ready' | 'confidence' | 'blockers'>): string {
  return sha256Hex(JSON.stringify({ head: v.head, ready: v.ready, confidence: v.confidence, blockers: v.blockers }));
}

/**
 * Mirrors harness `verifyVerdictSignature` (solution-acceptance-runtime.ts:262-286).
 * Load-bearing: called with `id` — the CALLER's lookup id — never
 * `verdict.id` (a field read back out of the marker BODY, which is exactly
 * the bytes an attacker controls when copying a validly-signed marker onto
 * a different id's path). This is the mechanism that makes a cross-id
 * replay fail signature verification, independent of the belt-and-braces
 * `verdict.id !== id` check `evaluateGate` also does below.
 */
export function verifyVerdictSignature(generatedDir: string, id: string, verdict: Verdict): SignatureVerification {
  return verifyMarkerSignature(generatedDir, verdictMarkerId(id), {
    approvedAt: verdict.timestamp,
    approvedBy: verdict.source,
    reportContentHash: verdictContentHash(verdict),
    alg: verdict.alg,
    signature: verdict.signature,
  });
}

/** Mirrors harness `GateResult` (solution-acceptance-runtime.ts:408-438). */
export interface GateResult {
  allowed: boolean;
  reason: string;
  verdict: Verdict | null;
  forged: boolean;
}

// Mirrors harness MISSING_APPROVED_AT_REASON / MISSING_APPROVED_BY_REASON
// (solution-acceptance-runtime.ts:458-459). `verifyMarkerSignature` returns
// these EXACT strings when `verdict.timestamp` / `verdict.source` map onto
// a blank `approvedAt` / `approvedBy` — and that check runs FIRST, before
// `signature` is even looked at, so it fires identically whether the
// verdict carries no signature at all OR a well-formed alg/signature pair
// that no longer matches (a forger blanking `timestamp` post-signing to
// dodge classification). `evaluateGate`'s carve-out below is scoped
// tightly to the FORMER case only (see the comment there) — this is a
// narrower condition than "signature and alg both absent" on its own; a
// verdict with valid timestamp/source but no signature/alg (the realistic
// "legacy unsigned producer" shape) does NOT hit this reason at all (it
// hits "missing signature" instead) and is therefore classified
// forged:true by the generic branch, matching harness' own golden-fixture
// tests (tests/policy-packs/solution-acceptance-runtime.test.ts, "the real
// UNSIGNED 0.3.2 marker is rejected as forged/unsigned, even at its own
// HEAD").
const MISSING_APPROVED_AT_REASON = 'missing approvedAt';
const MISSING_APPROVED_BY_REASON = 'missing approvedBy';

/**
 * Mirrors harness `evaluateGate` (solution-acceptance-runtime.ts:496-598).
 * Verifies the signature FIRST (fail-closed, before `ready`/`head` are ever
 * trusted), then independently rejects `verdict.id !== id`
 * (cross-id-replay belt-and-braces, since `verdict.id` is not itself part
 * of the signed payload), then falls through to the pre-existing
 * ready/HEAD-match decision.
 */
export function evaluateGate(
  verdict: Verdict | null,
  currentHead: string | null,
  id: string,
  generatedDir: string | undefined,
): GateResult {
  if (!verdict) {
    return {
      allowed: false,
      reason: `no solution-acceptance verdict recorded for "${id}" (run mcp__grounding-mcp__solution_evaluate first)`,
      verdict: null,
      forged: false,
    };
  }
  if (generatedDir === undefined) {
    return {
      allowed: false,
      reason: `cannot resolve harness.generated/ to verify the solution-acceptance verdict signature for "${id}"; treating as unapproved`,
      verdict,
      forged: false,
    };
  }
  const verification = verifyVerdictSignature(generatedDir, id, verdict);
  if (!verification.ok) {
    if (verification.kind === 'key-unavailable') {
      return {
        allowed: false,
        reason: `solution-acceptance verdict for "${id}" could not be verified: ${verification.reason}; treating as unapproved`,
        verdict,
        forged: false,
      };
    }
    if (
      (verification.reason === MISSING_APPROVED_AT_REASON || verification.reason === MISSING_APPROVED_BY_REASON) &&
      verdict.signature === undefined &&
      verdict.alg === undefined
    ) {
      return {
        allowed: false,
        reason:
          `solution-acceptance verdict for "${id}" is missing a required field (${verification.reason}); ` +
          `treating as unsigned, not forged (a legitimately malformed marker, re-run solution_evaluate)`,
        verdict,
        forged: false,
      };
    }
    return {
      allowed: false,
      reason:
        `forged/unsigned solution-acceptance verdict rejected for "${id}": ${verification.reason} ` +
        `(a producer that does not yet sign verdicts, or a marker written through an unguarded path)`,
      verdict,
      forged: true,
    };
  }
  if (verdict.id !== id) {
    return {
      allowed: false,
      reason:
        `forged/unsigned solution-acceptance verdict rejected for "${id}": verdict body identifies itself ` +
        `as "${verdict.id}" (cross-id replay of a validly-signed verdict, or a corrupted marker)`,
      verdict,
      forged: true,
    };
  }
  if (!verdict.ready) {
    const why = verdict.blockers.length > 0 ? `: ${verdict.blockers.join('; ')}` : '';
    return {
      allowed: false,
      reason: `solution-acceptance verdict for "${id}" is not ready${why} (fix, then re-run solution_evaluate)`,
      verdict,
      forged: false,
    };
  }
  if (!currentHead) {
    return {
      allowed: false,
      reason: `cannot resolve the current git HEAD to confirm the verdict for "${id}" is at HEAD`,
      verdict,
      forged: false,
    };
  }
  if (verdict.head !== currentHead) {
    return {
      allowed: false,
      reason: `stale solution-acceptance verdict for "${id}": recorded at ${verdict.head.slice(0, 7)}, current HEAD ${currentHead.slice(0, 7)} (re-run solution_evaluate after the rework)`,
      verdict,
      forged: false,
    };
  }
  return {
    allowed: true,
    reason: `solution-acceptance verdict for "${id}" is ready at HEAD ${currentHead.slice(0, 7)} (confidence ${Math.round(verdict.confidence * 100)}%)`,
    verdict,
    forged: false,
  };
}
