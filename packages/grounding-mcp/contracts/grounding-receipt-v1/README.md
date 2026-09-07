# Grounding receipt v1 repository contract

This directory is an explicitly vendored repository contract. The package's
npm exports and published file list do not expose the corpus or add a receipt
endpoint. `src/grounding-receipt.ts` is an additive pure codec and explicit-key
signature primitive. It neither evaluates dossiers nor authorizes issuers.

## Wire and signature

Produce exactly six envelope fields in this order: `format`, `alg`, `issuer`,
`kid`, `payload`, `signature`. Decoding accepts harmless outer JSON whitespace
and field reordering. Duplicate decoded keys, unknown fields, malformed UTF-8,
BOMs, unpaired Unicode surrogates, and input other than a UTF-8 string or
`Uint8Array` are invalid. JSON nesting is bounded at depth 32 (root depth 0).

`format` is `grounding-receipt/v1`; `alg` is `Ed25519`. `issuer` and `kid` are
ASCII `[A-Za-z0-9._:-]{1,128}`. `payload` is canonical unpadded base64url of
canonical UTF-8 JSON. `signature` is canonical unpadded base64url of 64 bytes.
Every base64url value must roundtrip identically, including unused pad bits.
The signature input is exactly these UTF-8 bytes, with LF separators and no
trailing newline:

```text
grounding-receipt/v1\nEd25519\n<issuer>\n<kid>\n<payload>
```

The displayed `\n` represents a single byte `0a`. Ed25519 uses the literal
base64url payload text, not its decoded bytes, in that input. Verification
requires a supplied public Ed25519 `KeyObject`; signing requires a supplied
private Ed25519 `KeyObject`. Key identifiers do not select or fetch keys.

Wire size is at most 32768 bytes; decoded payload size at most 16384 bytes.
These limits are inclusive. Field bounds make a valid canonical v1 payload
smaller than the payload ceiling: the boundary corpus uses padded JSON to
distinguish canonical rejection at 16384 from size rejection at 16385.

## Payload schema and consistency

`schema.json` is JSON Schema 2020-12 for the envelope and decoded payload
(`$defs.payload`). Every object is closed and lists its production key order
in `required`. Canonical payload encoding is the fixed typed projection,
`JSON.stringify` with no whitespace, encoded as UTF-8. Decoded bytes must equal
that projection exactly, including nested key order. Thus alternative number
spellings, escaped ASCII/slashes, whitespace, and duplicate fields fail.
Standard JSON Schema cannot enforce all these wire rules: the `x-wire` and
`x-invariants` sections define the additional required checks.

The payload order is `schemaVersion`, `receiptId`, `audience`, `projectId`,
`taskId`, `attemptId`, `nonce`, `contextRevision`, `target`, `subject`, `policy`,
`session`, `assessment`, `evaluatedAt`, `issuedAt`, `expiresAt`, `producer`.

- `receiptId` is a lowercase UUIDv4. Project, task, attempt and non-null
  workflow IDs are lowercase UUIDs of version 1–8 and RFC variant. Nil IDs
  fail. Golden attempts are v4. `target.workflowId` may be null for built-in
  workflows. Other target fields, audience, session ID and producer values
  use the same nonempty ASCII token bound as issuer/key IDs.
- `nonce` contains exactly 32 bytes. Context and session revisions are
  positive safe integers. Fact count is a nonnegative safe integer. Digests
  are exactly 64 lowercase hexadecimal characters. `subject.kind` is
  `task-context/v1`; its digest is opaque here.
- `policy` is exactly the supported ID, revision and pinned byte digest.
  Unknown formats, algorithms, schema variants, subject kinds and profiles
  are `unsupported`; there is no legacy fallback.
- `assessment.evidenceOrigin` is always `agent_asserted`. Pass requires at
  least one declared fact, `claimAllowed=true`, and an empty reasons list.
  Fail requires at least one known reason. Reasons are unique and ordered by
  `policy.reasonCodes`. Zero facts require `fact_missing`; positive facts
  forbid it. A disallowed claim requires `claim_missing` or
  `claim_prerequisites_missing`; an allowed claim forbids both. Session and
  step failure reasons can coexist with positive fact and claim declarations.
- Times are nonnegative safe epoch-second integers satisfying
  `evaluatedAt <= issuedAt < expiresAt` and
  `expiresAt - evaluatedAt <= 900`. No current clock is consulted.

Malformed transport, types, syntax, bounds and inconsistent declarations are
`invalid`. Signature mismatch and wrong supplied key type are `untrusted`.
Errors contain bounded diagnostics, not receipt or key contents. These are
library codes, not HTTP statuses. A valid fail receipt verifies successfully.

## Frozen policy and authority

`policy.json` snapshots wrapper phases, keyword selection, steps, guardrails,
empty-phase skipping, ordered claim detection, every prerequisite and context
derivation. External assessment adds the explicit minimum predicates:
authoritative session binding and revision, confirmed mandatory steps, a
bound nonempty fact, a nonempty allowed claim, and one atomic snapshot.
Optional hypothesis tracking is not a mandatory step; runtime inspection is
selected only by the frozen keyword predicate. Only producer-derived empty
phases can count as skipped. Agent-supplied phase arrays are not authority.

The pinned policy digest is SHA-256 of the entire literal `policy.json`,
including its final LF. It is a constant in the codec and tests; future live
wrapper/claim-gate changes do not alter this revision. Consumers vendor an
explicit manifest and profile digest. A policy change requires an explicit
new profile revision and reviewed corpus, never automatic regeneration.

Policy vectors state expected future evaluator decisions. They include
accepted/rejected dossiers for each minimum predicate, every claim prerequisite,
first-match detection examples, and fabricated yet formally sufficient
`agent_asserted` facts. P01 only checks receipt declarations and these static
specification records; it implements no dossier evaluator, authoritative
session check, producer store, issuer service, or consumer gate. A signature
proves neither diagnostic truth nor test execution or coverage.

## Fixed corpus

`manifest.json` binds schema/profile identity and the lexically ordered list
of every other file's byte size and SHA-256. It excludes itself to avoid
self-reference. Tests read these committed artifacts without rewriting them:

- `golden-pass` and `golden-fail`: exact envelope bytes, canonical payload
  bytes, signature-input bytes, and hexadecimal signature bytes. Payload and
  receipt files have no trailing newline; signature hex has one LF. Fail
  includes every known reason.
- `test-keys.json`: **public, unsafe, TEST ONLY** seed `00..1f`, RFC 8410 DER
  prefix, derived public SPKI and PEM. The seed permits anyone to sign; it
  must never become an issuer key. No private PEM fixture or real key access.
- `negative-vectors.json`: each `wireBase64` is standard padded base64 of
  exact bytes to pass to the decoder/verifier, with expected error code.
  Specimens cover individual signed-field tampering, unsupported variants,
  every field's missing/unknown/type/bound cases, encoding, duplication,
  canonicalization, provenance and outcome consistency. Optional expected
  messages distinguish the size boundary from later canonical rejection.
- `positive-vectors.json`: fixed reason and inclusive-boundary examples.
- `context-vectors.json`: correctly signed receipts that individually differ
  from the golden expected context. P01 verification succeeds; a future
  consumer must compare its stored context. This corpus does not implement
  that comparison, freshness, challenge TTL, issuer trust, or replay checks.
- `policy-vectors.json`: declarative dossier and claim specification cases,
  distinct from executable receipt verification and text-pattern checks.

The codec is never registered with the existing MCP server and does not alter
Solution-Verdict signing, sessions, exports, defaults, or task transitions.
