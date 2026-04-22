// review-claim-gate — a claim-gate-shaped evaluator specialised for PR
// review/merge decisions. Parallel to claim-gate's generic diagnostic
// claims: instead of readme_read / process_checked / has_evidence, the
// prerequisites are the things a human-in-the-loop actually checks
// before hitting "merge".
//
// Kept as a sibling package rather than a 10th built-in ClaimType in
// claim-gate so the CLI, evidence-ledger integration, and policy can
// evolve without churning the core claim-gate policies. The verdict
// shape intentionally mirrors claim-gate's ClaimResult (allowed/score/
// reasons/next_steps) so consumers that already parse claim-gate output
// do not need a new parser.

export type MergeApprovalType = "merge_approval";

export interface ReviewContext {
  /** Test suite passed (CI green or local `npm test` exit 0). */
  tests_pass?: boolean;
  /** Every rubric item in the review checklist is ticked off. */
  review_checklist_complete?: boolean;
  /** Every review comment has been resolved or replied to. */
  no_unresolved_review_comments?: boolean;
  /** The PR diff stays inside the task's stated scope — no drive-by refactors. */
  scope_matches_task?: boolean;
  /** ≥1 evidence-ledger entry exists for this PR's task id. */
  evidence_logged?: boolean;
}

export type ReviewContextKey = keyof ReviewContext;

export interface MergeApprovalResult {
  claim: string;
  type: MergeApprovalType;
  allowed: boolean;
  reasons: string[];
  next_steps: string[];
  score: number;
  /** Per-prereq pass/fail, included so reviewer output can show the
   *  exact dimension that blocked the merge. */
  prerequisites: Record<ReviewContextKey, boolean>;
}

export const MERGE_APPROVAL_PREREQS: readonly ReviewContextKey[] = [
  "tests_pass",
  "review_checklist_complete",
  "no_unresolved_review_comments",
  "scope_matches_task",
  "evidence_logged",
] as const;

const STEP_DESCRIPTIONS: Record<ReviewContextKey, string> = {
  tests_pass: "Run the test suite — CI green or local `npm test` exit 0",
  review_checklist_complete:
    "Tick every rubric item in the review checklist (correctness, security/scope, tests, docs)",
  no_unresolved_review_comments:
    "Resolve or reply to every review comment before merging",
  scope_matches_task:
    "Confirm the PR diff stays inside the task scope — no drive-by refactors",
  evidence_logged:
    "Log ≥1 evidence-ledger entry tagged with this PR's task id (session = task id)",
};

export function describePrereq(key: ReviewContextKey): string {
  return STEP_DESCRIPTIONS[key];
}

/**
 * Evaluate the merge_approval claim against a structured review context.
 * Semantics mirror claim-gate's evaluateClaim: all prereqs must be true
 * for `allowed: true`; missing prereqs become human-readable `reasons`
 * and actionable `next_steps`.
 */
export function evaluateMergeApproval(
  claim: string,
  context: ReviewContext,
): MergeApprovalResult {
  const missing = MERGE_APPROVAL_PREREQS.filter((req) => !context[req]);
  const satisfied = MERGE_APPROVAL_PREREQS.length - missing.length;
  const score = Math.round(
    (satisfied / MERGE_APPROVAL_PREREQS.length) * 100,
  );
  const allowed = missing.length === 0;

  const prerequisites = Object.fromEntries(
    MERGE_APPROVAL_PREREQS.map((k) => [k, Boolean(context[k])]),
  ) as Record<ReviewContextKey, boolean>;

  return {
    claim,
    type: "merge_approval",
    allowed,
    reasons: missing.map(
      (req) => `prerequisite not met: ${STEP_DESCRIPTIONS[req]}`,
    ),
    next_steps: missing.map((req) => STEP_DESCRIPTIONS[req]),
    score,
    prerequisites,
  };
}

/** Quick boolean form for callers who just want a gate. */
export function isMergeAllowed(
  claim: string,
  context: ReviewContext,
): boolean {
  return evaluateMergeApproval(claim, context).allowed;
}
