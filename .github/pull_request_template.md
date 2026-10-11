## Summary

<!-- One or two sentences. What changed? -->

## Motivation

<!-- Why this change? Link the issue if applicable. -->

## Test plan

- [ ] `npm run build` (or `npm run build -w packages/<name>` for single package)
- [ ] `npm test -w packages/<name>` for affected package(s)
- [ ] Manual smoke check: <!-- command or scenario -->

## Evidence ledger

<!--
The merge-approval check reads evidence under the PR head branch name.
Either commit .agent-grounding/evidence/<branch-name>.jsonl, written by
`review-claim-gate export --task-id <branch-name> --out .agent-grounding/evidence/<branch-name>.jsonl`
(add `--from-session <id>` when the entries were logged under another
session), or have the reviewer apply the review:evidence-logged label.
See docs/testing/merge-approval-rollout.md.
-->

## Notes for reviewer

<!-- Anything non-obvious: tradeoffs, follow-ups, open questions. -->
