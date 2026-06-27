# Changelog

## [Unreleased]

### Security

- `defaultEvidenceFilePath` now contains its caller-controlled `taskId` to the evidence directory: empty, absolute, and `..`-segment ids are rejected with a clear error, backstopped by a resolved-path containment check (mirrors `runtime-reality-checker`'s `verify-reference` guard). Previously `path.join` did not neutralize `..`, so a `taskId` wired from an untrusted source (the Action sets it from the PR branch name; consumers may wire it elsewhere) could resolve the auto-detect read outside the evidence dir. Nested-slash branch ids (`feat/foo`) remain supported. Addresses audit finding H1.

  Known residual limitations (out of H1's `..`-traversal scope): containment is lexical (`resolve`, not `realpath`), so a symlink committed under `.agent-grounding/evidence/` is not followed-through; and `isAbsolute` does not flag Windows drive-relative ids (`C:foo`) — immaterial on the Linux CI deployment target. Both are tracked as a follow-up.

## 0.1.2, 2026-06-16

### Changed

- Re-pinned the exact lockstep dependencies (`claim-gate`, `evidence-ledger`) from `0.3.0` to `0.4.0` to track the coordinated 0.4.0 release. No public API change.

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `review-claim-gate`
(unscoped, `private: true`) inside the agent-grounding monorepo. PR #66
renamed it to `@lannguyensi/review-claim-gate`, dropped the private flag,
and wired up the tag-driven `publish-libs.yml` workflow.

### What ships

A claim-gate-shaped evaluator specialised for PR review / merge decisions.
Encodes the reviewer checklist as a typed `merge_approval` policy with
five prerequisites: `tests_pass`, `review_checklist_complete`,
`no_unresolved_review_comments`, `scope_matches_task`, `evidence_logged`.
All five must be true for `allowed: true`. Missing prereqs surface in
`next_steps` so the reviewer sees exactly what's left.

- `evaluateMergeApproval(claim, ctx)`, `isMergeAllowed(...)`, type
  `ReviewContext`: programmatic API.
- Bin: `review-claim-gate` for CLI invocation with `--json` output, used
  by the composite GitHub Action under
  `packages/review-claim-gate/action/`.

### Install

```bash
npm install -g @lannguyensi/review-claim-gate    # exposes the bin
npm install @lannguyensi/review-claim-gate       # for programmatic API
```

### Runtime dependencies

`@lannguyensi/claim-gate@0.2.0`, `@lannguyensi/evidence-ledger@0.2.0`
(both already on npm), `commander`. No internal cross-deps on
unpublished packages.

### Note on the GitHub Action

The composite action under `packages/review-claim-gate/action/` keeps
building from monorepo source via `npm ci && build:deps && build -w
@lannguyensi/review-claim-gate`. It does not consume the published
package. Switching the action to consume the npm release is a possible
follow-up but not part of this release.
