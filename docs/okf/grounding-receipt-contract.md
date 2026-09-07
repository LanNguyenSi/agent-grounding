---
type: invariant
title: Grounding receipt and assessment contract
description: Portable documentary assessments, authoritative producer snapshots, immutable attempts, and the boundary between signature verification and issuer or task authority.
tags: [grounding-mcp, receipt, contract, trust-boundary]
timestamp: 2026-09-07T09:06:37Z
sources:
  - packages/grounding-mcp/src/grounding-receipt.ts
  - packages/grounding-mcp/contracts/grounding-receipt-v1/README.md
  - packages/grounding-mcp/contracts/grounding-receipt-v1/policy.json
  - packages/grounding-mcp/contracts/grounding-receipt-v1/schema.json
  - packages/grounding-mcp/tests/grounding-receipt.test.ts
  - packages/grounding-mcp/src/grounding-assessment-policy.ts
  - packages/grounding-mcp/src/grounding-assessment-store.ts
  - packages/grounding-mcp/tests/grounding-assessment-policy.test.ts
  - packages/grounding-mcp/tests/grounding-assessment-store.test.ts
  - packages/grounding-mcp/src/assessment-index.ts
  - packages/grounding-mcp/src/assessment-server.ts
  - packages/grounding-mcp/src/grounding-issuer.ts
---

# Grounding receipt and assessment contract

## Invariant

`grounding-receipt/v1` is a compact, signed documentary assessment format. It
binds the declared format, algorithm, issuer, key identifier, and canonical
payload bytes with Ed25519. Its `debug-evidence-assessment/v1` profile records
that facts are `agent_asserted`; it does not attest to diagnosis truth, test
execution, test coverage, task completion, issuer authorization, or permission
to change a task state.

The codec accepts only explicit Ed25519 key objects. It neither discovers keys
nor reads environment, files, network resources, sessions, or tasks. A caller
that verifies a receipt therefore establishes only its schema and signature
under the public key it supplied. Issuer admission, key rotation, context
binding, freshness, replay prevention, and any task or claim decision remain
consumer responsibilities.

The versioned corpus under `packages/grounding-mcp/contracts/grounding-receipt-v1/`
is the interoperable source for schema order, static policy bytes, public
test-only keys, signed golden examples, and negative vectors. Its manifest
hashes the ordered files; consumers vendor and pin that corpus explicitly.
The policy digest is the SHA-256 of the literal `policy.json` bytes, including
its final newline. Updating a policy requires a new explicit profile revision;
live wrapper or claim-gate behavior never silently changes the pinned digest.

The producer codec is intentionally not an assessment evaluator. It checks the
internal consistency of declared assessment fields, including a `pass` that
requires an asserted fact and an allowed claim. The separate assessment store
owns sessions bound at creation to audience, project, task, and subject. It
computes phases, claim type, prerequisites, and a digest covering the complete
documentary snapshot plus computed claim evaluation from frozen policy rules.
Caller metadata, phase arrays, imported sessions, and free allowed/type/origin
overrides cannot replace those records.

Every mutation uses revision CAS within the same cross-process lock as reads
and export. Session state, terminal snapshot, and exact signed receipt bytes
share one atomic JSON commit. A terminal attempt's canonical fingerprint
covers session ID, expected revision, and every challenge field. An exact
retry returns stored bytes before checking the live clock or reevaluating the
session, including after later mutations or restart. A changed request on an
existing attempt conflicts. A fresh attempt requires the bound subject and
current session revision; the consumer authenticates its workflow target and
context against its own attempt record.

The stable lock has no time-based takeover. Unclean exit recovery requires
operator-confirmed quiescence of all writers before removing the lock. File
fsync, atomic rename, and directory fsync define the commit boundary; an error
after rename requires retry/read reconciliation. Corrupt state and exhausted
capacity fail explicitly. The [package documentation](../../packages/grounding-mcp/README.md#authoritative-assessment-store)
specifies configuration, limits, retry behavior, and recovery. Filesystem and
OS isolation qualification, production key lifecycle, and consumer enforcement
remain separate responsibilities. The restricted transport is described below.

## Restricted producer transport

The separate `grounding-assessment-mcp` stdio entrypoint wires the assessment
store to exactly seven operations: start, status, advance, dossier add/read,
claim set, and export. Startup accepts only an operator-selected absolute
configuration file containing an issuer, key id, absolute Ed25519 private-key
path, absolute state directory, and the frozen policy identity. It has no
default key/state path, key generation, discovery, or trust registration.
Tool inputs cannot provide those fields. Export transmits the store's signed
receipt as exact UTF-8 text; failed requests return no previous receipt. The
transport does not establish consumer admission, production key lifecycle,
rollout, or OS isolation.

## Source anchors

The [repository contract](../../packages/grounding-mcp/contracts/grounding-receipt-v1/README.md)
is authoritative for field bounds, nested schema, canonicalization, signature
input, error codes, corpus interpretation and explicit vendoring. This module
has no free-signing MCP endpoint; the restricted transport signs only through
the assessment store.

- Codec and explicit-key signature boundary:
  `packages/grounding-mcp/src/grounding-receipt.ts:206#"export function verifyReceipt"`.
- Canonical typed projection and field consistency:
  `packages/grounding-mcp/src/grounding-receipt.ts:124#"export function validatePayload"`.
- Frozen documentary requirements:
  `packages/grounding-mcp/contracts/grounding-receipt-v1/policy.json:287#"minimumPredicates"`.
- The distinction between byte-format checks and documentary meaning:
  `packages/grounding-mcp/contracts/grounding-receipt-v1/README.md:100-103#"proves neither diagnostic truth"`.
- Authoritative creation and immutable binding:
  `packages/grounding-mcp/src/grounding-assessment-store.ts:209#"async createSession"`.
- Serialized atomic persistence and lock ownership:
  `packages/grounding-mcp/src/grounding-assessment-store.ts:166#"async #transaction"`.
- Terminal retry fingerprint and stored receipt bytes:
  `packages/grounding-mcp/src/grounding-assessment-store.ts:262#"async exportReceipt"`.
- Fixed snapshot assessment and documentary provenance:
  `packages/grounding-mcp/src/grounding-assessment-policy.ts:115#"export function assessSnapshot"`.
- Explicit dossier hash projection:
  `packages/grounding-mcp/src/grounding-assessment-policy.ts:103#"export function dossierProjection"`.
- Process concurrency around one consistent snapshot:
  `packages/grounding-mcp/tests/grounding-assessment-store.test.ts:248-266#"await stop(child.child);"`.
- Independent frozen claim detector vector tests:
  `packages/grounding-mcp/tests/grounding-assessment-policy.test.ts:45-47#"expect(detectClaimType(claim)).toBe(expectedType);"`.
- Restricted stdio composition root and sanitized startup failure:
  `packages/grounding-mcp/src/assessment-index.ts:9-17#"main().catch"`.
- Explicit issuer configuration and Ed25519 key validation:
  `packages/grounding-mcp/src/grounding-issuer.ts:49-58#"key.asymmetricKeyType"`.
- Capped single-handle reads and fatal UTF-8 decoding:
  `packages/grounding-mcp/src/grounding-issuer.ts:31-44#"fatal: true"`.
- Strict seven-tool registration and exact receipt transport:
  `packages/grounding-mcp/src/assessment-server.ts:37-58#"catch (cause)"`.
