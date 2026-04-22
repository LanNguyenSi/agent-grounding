#!/usr/bin/env node
// review-claim-gate CLI.
//
// Usage: review-claim-gate check --task-id <id> [flags]
//
// Context flags are ORed with the evidence-ledger lookup: passing
// --evidence-logged explicitly forces the flag to true, otherwise the
// CLI derives it by counting entries where session = <task-id>. All
// other flags default to false — reviewers opt each prereq in as they
// confirm it.
//
// Text mode emits a human-readable summary; --json emits a stable
// machine-parseable shape for the parent reviewer session to consume.

import { Command } from "commander";
import {
  evaluateMergeApproval,
  MERGE_APPROVAL_PREREQS,
  describePrereq,
  type MergeApprovalResult,
  type ReviewContext,
} from "./lib.js";
import { getDb, resetDb, listEntries } from "evidence-ledger";

interface CheckOptions {
  taskId: string;
  pr?: string;
  claim?: string;
  testsPass?: boolean;
  reviewChecklistComplete?: boolean;
  commentsResolved?: boolean;
  scopeMatchesTask?: boolean;
  evidenceLogged?: boolean;
  ledgerDb?: string;
  json?: boolean;
}

interface CheckReport {
  taskId: string;
  pr: string | null;
  evidenceEntries: number;
  result: MergeApprovalResult;
}

function deriveEvidenceLogged(
  taskId: string,
  dbPath: string | undefined,
): number {
  // Fresh db handle each invocation. evidence-ledger caches a singleton
  // under the hood; reset first so a prior invocation with a different
  // dbPath does not win.
  resetDb();
  const db = getDb(dbPath);
  try {
    return listEntries(db, { session: taskId }).length;
  } finally {
    // Callers own the process lifetime; we don't close the DB explicitly
    // so any follow-up call in the same process reuses the handle. The
    // OS reclaims on exit.
  }
}

function buildContext(opts: CheckOptions, evidenceEntries: number): ReviewContext {
  return {
    tests_pass: Boolean(opts.testsPass),
    review_checklist_complete: Boolean(opts.reviewChecklistComplete),
    no_unresolved_review_comments: Boolean(opts.commentsResolved),
    scope_matches_task: Boolean(opts.scopeMatchesTask),
    // Explicit flag wins; otherwise derive from the ledger.
    evidence_logged:
      opts.evidenceLogged === true ? true : evidenceEntries > 0,
  };
}

function formatText(report: CheckReport): string {
  const { result, taskId, pr, evidenceEntries } = report;
  const lines: string[] = [];
  lines.push(`merge_approval for task ${taskId}${pr ? ` (${pr})` : ""}:`);
  lines.push(`  verdict: ${result.allowed ? "ALLOWED" : "BLOCKED"} (score ${result.score}/100)`);
  lines.push(`  evidence_ledger entries: ${evidenceEntries}`);
  lines.push("  prerequisites:");
  for (const key of MERGE_APPROVAL_PREREQS) {
    const check = result.prerequisites[key] ? "✓" : "✗";
    lines.push(`    ${check} ${key}`);
  }
  if (result.next_steps.length > 0) {
    lines.push("  next steps:");
    for (const step of result.next_steps) lines.push(`    - ${step}`);
  }
  return lines.join("\n") + "\n";
}

export function runCheck(opts: CheckOptions): CheckReport {
  if (!opts.taskId) {
    throw new Error("--task-id is required");
  }
  const evidenceEntries = deriveEvidenceLogged(opts.taskId, opts.ledgerDb);
  const context = buildContext(opts, evidenceEntries);
  const claim = opts.claim ?? `PR for task ${opts.taskId} is safe to merge`;
  const result = evaluateMergeApproval(claim, context);
  return {
    taskId: opts.taskId,
    pr: opts.pr ?? null,
    evidenceEntries,
    result,
  };
}

function main(argv: string[]): void {
  const program = new Command();
  program
    .name("review-claim-gate")
    .description(
      "Evaluate a PR's merge_approval claim against reviewer evidence",
    );

  program
    .command("check")
    .description("Evaluate the merge_approval gate for one PR")
    .requiredOption("--task-id <id>", "agent-tasks task id (ledger session key)")
    .option("--pr <url>", "PR URL (metadata only)")
    .option(
      "--claim <text>",
      "custom claim text (defaults to a generic merge-approval sentence)",
    )
    .option("--tests-pass", "mark tests_pass prerequisite as satisfied")
    .option(
      "--review-checklist-complete",
      "mark review_checklist_complete as satisfied",
    )
    .option(
      "--comments-resolved",
      "mark no_unresolved_review_comments as satisfied (every review comment resolved or replied to)",
    )
    .option(
      "--scope-matches-task",
      "mark scope_matches_task as satisfied",
    )
    .option(
      "--evidence-logged",
      "force evidence_logged=true (bypasses ledger lookup)",
    )
    .option(
      "--ledger-db <path>",
      "evidence-ledger DB path (default: $EVIDENCE_LEDGER_DB or ~/.evidence-ledger/ledger.db)",
    )
    .option("--json", "emit JSON instead of text")
    .action((opts: CheckOptions) => {
      const ledgerDb = opts.ledgerDb ?? process.env.EVIDENCE_LEDGER_DB;
      const report = runCheck({ ...opts, ledgerDb });
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        process.stdout.write(formatText(report));
      }
      process.exit(report.result.allowed ? 0 : 1);
    });

  program
    .command("describe")
    .description("Print the merge_approval prerequisite list")
    .action(() => {
      for (const key of MERGE_APPROVAL_PREREQS) {
        process.stdout.write(`${key}\n  ${describePrereq(key)}\n`);
      }
    });

  program.parse(argv);
}

// Only run when invoked directly (support in-process test imports).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/review-claim-gate/dist/cli.js") ||
  process.argv[1]?.endsWith("review-claim-gate");

if (isDirectInvocation) {
  main(process.argv);
}

export { main, formatText };
