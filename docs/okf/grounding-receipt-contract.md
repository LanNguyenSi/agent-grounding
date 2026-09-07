---
type: invariant
title: Grounding receipt codec contract
description: Portable documentary assessment bytes, frozen policy identity, and the boundary between signature verification and issuer or task authority.
tags: [grounding-mcp, receipt, contract, trust-boundary]
timestamp: 2026-09-07T05:36:12Z
sources:
  - packages/grounding-mcp/src/grounding-receipt.ts
  - packages/grounding-mcp/contracts/grounding-receipt-v1/README.md
  - packages/grounding-mcp/contracts/grounding-receipt-v1/policy.json
  - packages/grounding-mcp/contracts/grounding-receipt-v1/schema.json
  - packages/grounding-mcp/tests/grounding-receipt.test.ts
---

# Grounding receipt codec contract

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
requires an asserted fact and an allowed claim. Evaluation of a dossier,
authoritative session state, and receipt issuance are separate work.

## Source anchors

The [repository contract](../../packages/grounding-mcp/contracts/grounding-receipt-v1/README.md)
is authoritative for field bounds, nested schema, canonicalization, signature
input, error codes, corpus interpretation and explicit vendoring. This module
has no npm entrypoint or registered MCP endpoint.

- Codec and explicit-key signature boundary:
  `packages/grounding-mcp/src/grounding-receipt.ts:206#"export function verifyReceipt"`.
- Canonical typed projection and field consistency:
  `packages/grounding-mcp/src/grounding-receipt.ts:124#"export function validatePayload"`.
- Frozen documentary requirements:
  `packages/grounding-mcp/contracts/grounding-receipt-v1/policy.json:287#"minimumPredicates"`.
- The distinction between fixed receipt checks and future dossier evaluation:
  `packages/grounding-mcp/tests/grounding-receipt.test.ts:190#"frozen declarative policy, not a P02 dossier evaluator"`.
