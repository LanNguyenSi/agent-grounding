// Shape-check for the composite GitHub Action YAML.
//
// We cannot run `act` in unit tests (heavy / requires Docker), but the
// action is small enough that a schema check catches the realistic
// failure modes: YAML breakage, input/output rename, step deletion,
// the CLI call losing a required flag, the Check-Run name drifting.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { MERGE_APPROVAL_PREREQS } from "../src/lib.js";

const ACTION_PATH = fileURLToPath(
  new URL("../action/action.yml", import.meta.url),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const action: any = parseYaml(readFileSync(ACTION_PATH, "utf8"));

describe("action.yml — shape", () => {
  it("declares a composite action", () => {
    expect(action.runs.using).toBe("composite");
    expect(Array.isArray(action.runs.steps)).toBe(true);
    expect(action.runs.steps.length).toBeGreaterThan(0);
  });

  it("declares every prereq flag as an input", () => {
    // camelCase → kebab-case. Each key in MERGE_APPROVAL_PREREQS except
    // `no_unresolved_review_comments` maps directly; that one maps to
    // `comments-resolved` (commander --no- negation avoidance).
    const expected = new Set<string>();
    for (const key of MERGE_APPROVAL_PREREQS) {
      if (key === "no_unresolved_review_comments") {
        expected.add("comments-resolved");
      } else {
        expected.add(key.replace(/_/g, "-"));
      }
    }
    for (const flag of expected) {
      expect(action.inputs).toHaveProperty(flag);
    }
  });

  it("requires task-id and github-token", () => {
    expect(action.inputs["task-id"].required).toBe(true);
    expect(action.inputs["github-token"].required).toBe(true);
  });

  it("exposes verdict + score + report-path outputs", () => {
    expect(action.outputs).toHaveProperty("verdict");
    expect(action.outputs).toHaveProperty("score");
    expect(action.outputs).toHaveProperty("report-path");
  });

  it("every step name is present (ordered: setup → install → gate → check-run → fail)", () => {
    const stepNames = action.runs.steps.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.name ?? s.uses,
    );
    expect(stepNames).toEqual([
      "Set up Node",
      "Install + build review-claim-gate",
      "Evaluate merge_approval gate",
      "Post Check-Run",
      "Fail if blocked",
    ]);
  });

  it("the install step builds the review-claim-gate workspace", () => {
    const installStep = action.runs.steps.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.name === "Install + build review-claim-gate",
    );
    expect(installStep).toBeDefined();
    expect(installStep.run).toContain("npm ci");
    expect(installStep.run).toContain("build -w @lannguyensi/review-claim-gate");
  });

  it("the gate step invokes the CLI with --json on the built dist", () => {
    const gateStep = action.runs.steps.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.id === "gate",
    );
    expect(gateStep).toBeDefined();
    expect(gateStep.run).toContain("dist/cli.js");
    expect(gateStep.run).toContain("check --task-id");
    expect(gateStep.run).toContain("--json");
    expect(gateStep.run).toContain("--ledger-db");
  });

  it("the gate step forwards every prereq flag to the CLI", () => {
    // Catches the class of drift where a new prereq lands in lib.ts but
    // the action.yml bash never grows a corresponding `ARGS+=(--…)`
    // line. The previous test only checks that inputs are declared, not
    // that they are forwarded.
    const gateStep = action.runs.steps.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.id === "gate",
    );
    const expectedFlags: string[] = [];
    for (const key of MERGE_APPROVAL_PREREQS) {
      if (key === "no_unresolved_review_comments") {
        expectedFlags.push("--comments-resolved");
      } else {
        expectedFlags.push(`--${key.replace(/_/g, "-")}`);
      }
    }
    for (const flag of expectedFlags) {
      expect(gateStep.run).toContain(flag);
    }
  });

  it("inputs are routed through env: not interpolated directly into bash", () => {
    // Security-hardening guardrail: `${{ inputs.* }}` inside `run:` is
    // shell-injection prone (a task-id like `"; rm -rf …` would break
    // out). Every user-controlled input must appear in the step's
    // `env:` block and be read as a shell variable.
    const sensitiveSteps = action.runs.steps.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => typeof s.run === "string",
    );
    for (const step of sensitiveSteps) {
      // If the step references any user input (any `${{ inputs.* }}`
      // expression) it MUST be inside the `env:` block, not inside
      // `run:`.
      expect(step.run).not.toMatch(/\$\{\{\s*inputs\./);
    }
    // And the gate step must declare the expected env vars.
    const gateStep = sensitiveSteps.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.id === "gate",
    );
    expect(gateStep.env).toMatchObject({
      TASK_ID: expect.stringContaining("inputs.task-id"),
      PR_NUMBER: expect.stringContaining("inputs.pr-number"),
      EVIDENCE_LEDGER_PATH: expect.stringContaining("inputs.evidence-ledger-path"),
    });
  });

  it("posts a Check-Run named 'merge-approval'", () => {
    const checkStep = action.runs.steps.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.uses?.startsWith("actions/github-script"),
    );
    expect(checkStep).toBeDefined();
    expect(checkStep.with.script).toContain("'merge-approval'");
    expect(checkStep.with.script).toContain("checks.create");
  });

  it("fail-on-block step exits non-zero when gate reports BLOCKED", () => {
    const failStep = action.runs.steps.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.name === "Fail if blocked",
    );
    expect(failStep).toBeDefined();
    expect(failStep.if).toContain("fail-on-block == 'true'");
    expect(failStep.if).toContain("'BLOCKED'");
    expect(failStep.run).toContain("exit 1");
  });
});
