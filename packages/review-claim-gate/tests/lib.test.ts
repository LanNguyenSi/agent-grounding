import { describe, expect, it } from "vitest";
import {
  evaluateMergeApproval,
  isMergeAllowed,
  MERGE_APPROVAL_PREREQS,
  describePrereq,
  type ReviewContext,
} from "../src/index.js";

const ALL_SATISFIED: ReviewContext = {
  tests_pass: true,
  review_checklist_complete: true,
  no_unresolved_review_comments: true,
  scope_matches_task: true,
  evidence_logged: true,
};

describe("evaluateMergeApproval", () => {
  it("allows the merge when every prerequisite is true → score 100", () => {
    const result = evaluateMergeApproval("PR t-1 is safe to merge", ALL_SATISFIED);
    expect(result.allowed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.reasons).toEqual([]);
    expect(result.next_steps).toEqual([]);
    expect(result.type).toBe("merge_approval");
  });

  it("blocks the merge when any prerequisite is false", () => {
    const ctx = { ...ALL_SATISFIED, tests_pass: false };
    const result = evaluateMergeApproval("x", ctx);
    expect(result.allowed).toBe(false);
    expect(result.score).toBe(80); // 4/5
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/test suite/i);
    expect(result.next_steps).toHaveLength(1);
    expect(result.next_steps[0]).toMatch(/test suite/i);
  });

  it("lists every missing prereq in next_steps", () => {
    const result = evaluateMergeApproval("x", {});
    expect(result.allowed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.next_steps).toHaveLength(MERGE_APPROVAL_PREREQS.length);
    expect(result.reasons).toHaveLength(MERGE_APPROVAL_PREREQS.length);
  });

  it("surfaces per-prereq pass/fail so reviewers can show detail", () => {
    const result = evaluateMergeApproval("x", {
      tests_pass: true,
      review_checklist_complete: true,
    });
    expect(result.prerequisites.tests_pass).toBe(true);
    expect(result.prerequisites.review_checklist_complete).toBe(true);
    expect(result.prerequisites.no_unresolved_review_comments).toBe(false);
    expect(result.prerequisites.scope_matches_task).toBe(false);
    expect(result.prerequisites.evidence_logged).toBe(false);
  });

  it("coerces truthy non-boolean inputs to true", () => {
    // Users sometimes pass `context.tests_pass = 1` from loosely-typed
    // sources (CLI, env var, JSON). The coercion is explicit in the
    // implementation — make sure it's load-bearing.
    const ctx = {
      tests_pass: 1 as unknown as boolean,
      review_checklist_complete: true,
      no_unresolved_review_comments: true,
      scope_matches_task: true,
      evidence_logged: true,
    };
    expect(evaluateMergeApproval("x", ctx).allowed).toBe(true);
  });

  it("score rounds to whole integers", () => {
    const ctx: ReviewContext = { tests_pass: true };
    // 1 / 5 = 0.2 → 20.
    expect(evaluateMergeApproval("x", ctx).score).toBe(20);
  });
});

describe("isMergeAllowed", () => {
  it("boolean shorthand matches evaluateMergeApproval's verdict", () => {
    expect(isMergeAllowed("x", ALL_SATISFIED)).toBe(true);
    expect(isMergeAllowed("x", {})).toBe(false);
  });
});

describe("describePrereq", () => {
  it("returns a non-empty description for every prereq key", () => {
    for (const key of MERGE_APPROVAL_PREREQS) {
      const desc = describePrereq(key);
      expect(desc).toBeTruthy();
      expect(desc.length).toBeGreaterThan(5);
    }
  });
});

describe("MERGE_APPROVAL_PREREQS", () => {
  it("contains exactly the five prereqs the task calls out", () => {
    expect([...MERGE_APPROVAL_PREREQS].sort()).toEqual(
      [
        "tests_pass",
        "review_checklist_complete",
        "no_unresolved_review_comments",
        "scope_matches_task",
        "evidence_logged",
      ].sort(),
    );
  });
});
