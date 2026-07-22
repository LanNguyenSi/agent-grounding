// Regression tests for the taskId-metadata binding vulnerability
// (agent-grounding e2e065e6). Pre-existing, no escalation: found during the
// adversarial review of the C1 self-approval fix (agent-tasks 3a994d92).
//
// Exploit: an agent's Understanding Report is always forced to
// approvalStatus: "pending" by parseReport, so it can never self-approve
// (see security-self-approval.test.ts). And PreToolUse enforcement
// (handle-pre-tool-use.ts) looks up the active task strictly by
// env.UNDERSTANDING_GATE_TASK_ID || sessionId, never by a report's own
// taskId field, so writes can never be ALLOWED by this bug.
//
// But before the fix, parseReport's METADATA_KEYS honoured an
// agent-supplied `taskid` in the report's `## Metadata` block, and that
// value beat the caller-supplied (adapter/env-derived) default in the
// merge order. In a shared reports dir, an agent could park its own
// forced-pending report under ANOTHER task's id. findLatestForTask
// (core/approval.ts) picks the most recently created/approved entry
// matching a taskId, so a newer forged pending entry would outrank that
// other task's already-approved entry, downgrading it back to pending --
// a denial-of-service / integrity break in the block direction.
//
// Fix: a caller-supplied defaults.boundTaskId now always wins over the
// Metadata block's `taskid` key (parser.ts). Both adapters
// (handle-stop.ts, persist-report.ts) always pass boundTaskId derived
// from the runtime's own env/session, so in production the persisted
// taskId is fully adapter/session-bound and the Metadata key can no
// longer forge it.
//
// agent-tasks 2078873e: this used to be implemented via a plain
// defaults.taskId, which also (wrongly) made ANY caller-supplied taskId
// win, breaking legitimate gap-fill callers. defaults.taskId is gap-fill
// again; this security property now lives in the dedicated
// defaults.boundTaskId field exercised below.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReport } from "../src/core/parser.js";
import { saveReport, listReports } from "../src/core/persistence.js";
import {
  findLatestForTask,
  isApproved,
  withApprovalStatus,
} from "../src/core/approval.js";

const VICTIM_TASK_ID = "victim-task";
const ATTACKER_TASK_ID = "attacker-session";

// A full, valid 10-section report whose Metadata block tries to forge the
// persisted binding onto the victim task's id.
const EXPLOIT_MARKDOWN = `# Understanding Report

### 1. My current understanding
The exploit test: an attacker embeds another task's id in Metadata.

### 2. Intended outcome
Confirm that parseReport ignores taskid from Metadata when the caller
supplies its own default.

### 3. Derived todos / specs
- verify parser ignores taskid from metadata

### 4. Acceptance criteria
- persisted taskId always comes from the caller-supplied default

### 5. Assumptions
- the fix is in place

### 6. Open questions
- none

### 7. Out of scope
- other metadata fields (mode, riskLevel)

### 8. Risks
- taskId forgery downgrades another task's approval back to pending

### 9. Verification plan
- this test

### 10. Prior art
- mirrors the sessionId-forgery regression (task 0a3227fe)

## Metadata
taskid: ${VICTIM_TASK_ID}
`;

// Defaults matching what handle-stop.ts / persist-report.ts derive from
// env/sessionId for the attacker's OWN session.
const ATTACKER_DEFAULTS = {
  boundTaskId: ATTACKER_TASK_ID,
  createdAt: "2026-07-14T12:00:00.000Z",
  mode: "fast_confirm" as const,
  riskLevel: "medium" as const,
};

describe("taskId forgery via Metadata: parseReport ignores it when a boundTaskId is supplied", () => {
  it("binds the report to the caller-supplied boundTaskId, not the Metadata block's", () => {
    const result = parseReport(EXPLOIT_MARKDOWN, ATTACKER_DEFAULTS);
    expect(result.ok, "parse must succeed for the exploit to be relevant").toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.report.taskId).toBe(ATTACKER_TASK_ID);
    expect(result.report.taskId).not.toBe(VICTIM_TASK_ID);
  });
});

describe("taskId forgery cannot downgrade another task's approval (block-direction integrity)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ug-taskid-binding-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a forged pending report does not outrank the victim task's already-approved entry", () => {
    const dir = join(tmpDir, "reports");

    // Step 1: the victim's own report is emitted and approved by the
    // operator at an earlier point in time.
    const victimDefaults = {
      boundTaskId: VICTIM_TASK_ID,
      createdAt: "2026-07-14T10:00:00.000Z",
      mode: "fast_confirm" as const,
      riskLevel: "medium" as const,
    };
    const victimMarkdown = EXPLOIT_MARKDOWN.replace(/## Metadata[\s\S]*$/, "");
    const victimParsed = parseReport(victimMarkdown, victimDefaults);
    expect(victimParsed.ok).toBe(true);
    if (!victimParsed.ok) return;
    saveReport(victimParsed.report, { dir });
    const approvedVictim = withApprovalStatus(
      victimParsed.report,
      "approved",
      "cli",
      new Date("2026-07-14T10:05:00.000Z"),
    );
    saveReport(approvedVictim, {
      dir,
      now: new Date("2026-07-14T10:05:00.000Z"),
    });

    // Step 2: later, the attacker's own session emits the exploit report,
    // trying to forge `taskid: victim-task` in its Metadata block. Its
    // own createdAt is AFTER the victim's approvedAt: if the forgery
    // succeeded, findLatestForTask(entries, VICTIM_TASK_ID) would return
    // this newer pending entry instead of the approved one (sortKey
    // prefers approvedAt when present, but only within entries that
    // actually share the taskId being looked up).
    const attackParsed = parseReport(EXPLOIT_MARKDOWN, ATTACKER_DEFAULTS);
    expect(attackParsed.ok).toBe(true);
    if (!attackParsed.ok) return;
    saveReport(attackParsed.report, { dir });

    const entries = listReports({ dir });

    // The victim task's latest entry is still the approved one: the
    // exploit report was filed under the attacker's own taskId, never
    // the victim's.
    const latestForVictim = findLatestForTask(entries, VICTIM_TASK_ID);
    expect(isApproved(latestForVictim)).toBe(true);
    expect(latestForVictim?.approvalStatus).toBe("approved");

    // And the exploit report is discoverable under the attacker's OWN
    // task id, exactly where the adapter-derived default put it -- not
    // silently dropped, just correctly attributed.
    const latestForAttacker = findLatestForTask(entries, ATTACKER_TASK_ID);
    expect(latestForAttacker?.approvalStatus).toBe("pending");
  });
});
