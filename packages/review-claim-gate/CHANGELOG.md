# Changelog

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
