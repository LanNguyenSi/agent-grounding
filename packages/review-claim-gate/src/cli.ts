#!/usr/bin/env node
// review-claim-gate CLI.
//
// Usage: review-claim-gate check --task-id <id> [flags]
//        review-claim-gate export --task-id <id> [--ledger-db <path>] [--out <path>]
//
// Context flags are ORed with the evidence source: passing
// --evidence-logged explicitly forces the flag to true. Otherwise the
// CLI checks, in order:
//   1. a committed evidence file (default: ./.agent-grounding/evidence/
//      <task-id>.jsonl; override via --evidence-file)
//   2. the local evidence-ledger DB (session = <task-id>)
// The file path is the higher-integrity signal — it's the artifact
// the reviewer explicitly committed to the PR branch via `export`.
// The ledger fallback keeps local dev ergonomic (nothing to commit
// when you just want to pre-check a claim).
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  evidenceFile?: string;
  json?: boolean;
}

interface CheckReport {
  taskId: string;
  pr: string | null;
  evidenceEntries: number;
  /** Which source produced evidenceEntries. "none" when neither path was usable. */
  evidenceSource: "file" | "ledger" | "forced" | "none";
  /** Resolved file path used, when evidenceSource === "file". */
  evidenceFilePath?: string;
  result: MergeApprovalResult;
}

/**
 * Convention path the Action auto-detects when `--evidence-file` is
 * not passed. Lives at the consumer-workspace root so a reviewer can
 * commit it alongside the PR.
 */
export function defaultEvidenceFilePath(taskId: string, cwd = process.cwd()): string {
  return join(cwd, ".agent-grounding", "evidence", `${taskId}.jsonl`);
}

function countEvidenceFileLines(path: string): number {
  const raw = readFileSync(path, "utf8");
  // JSONL: one JSON object per line. Skip blanks; tolerate malformed
  // lines but don't count them — the reviewer committed something odd
  // and we'd rather undercount than inflate.
  let valid = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
      valid++;
    } catch {
      // malformed — skip silently; could surface in --json later if needed
    }
  }
  return valid;
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
  return listEntries(db, { session: taskId }).length;
}

function buildContext(opts: CheckOptions, evidenceEntries: number): ReviewContext {
  return {
    tests_pass: Boolean(opts.testsPass),
    review_checklist_complete: Boolean(opts.reviewChecklistComplete),
    no_unresolved_review_comments: Boolean(opts.commentsResolved),
    scope_matches_task: Boolean(opts.scopeMatchesTask),
    // Explicit flag wins; otherwise derive from the file/ledger count.
    evidence_logged:
      opts.evidenceLogged === true ? true : evidenceEntries > 0,
  };
}

function formatText(report: CheckReport): string {
  const { result, taskId, pr, evidenceEntries, evidenceSource, evidenceFilePath } =
    report;
  const lines: string[] = [];
  lines.push(`merge_approval for task ${taskId}${pr ? ` (${pr})` : ""}:`);
  lines.push(`  verdict: ${result.allowed ? "ALLOWED" : "BLOCKED"} (score ${result.score}/100)`);
  const sourceLabel =
    evidenceSource === "file"
      ? ` (file: ${evidenceFilePath})`
      : evidenceSource === "ledger"
        ? " (ledger)"
        : evidenceSource === "forced"
          ? " (forced via --evidence-logged)"
          : " (none)";
  lines.push(`  evidence entries: ${evidenceEntries}${sourceLabel}`);
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

  // Resolve the evidence source. Priority: explicit --evidence-logged
  // forces true regardless; otherwise a committed evidence file wins
  // over the local ledger; otherwise fall back to the ledger DB.
  let evidenceEntries = 0;
  let evidenceSource: CheckReport["evidenceSource"] = "none";
  let evidenceFilePath: string | undefined;

  if (opts.evidenceLogged === true) {
    // Forced: we don't count; the buildContext will set evidence_logged=true
    // regardless. Report the intent transparently.
    evidenceSource = "forced";
  } else {
    // Prefer the file when the caller pointed at one OR when the
    // convention path exists at cwd. Explicit --evidence-file with a
    // non-existent path is an error (the reviewer named it; we should
    // not silently fall back).
    const explicitFile = opts.evidenceFile;
    const autoFile = defaultEvidenceFilePath(opts.taskId);
    if (explicitFile) {
      if (!existsSync(explicitFile)) {
        throw new Error(
          `--evidence-file ${explicitFile} does not exist`,
        );
      }
      evidenceEntries = countEvidenceFileLines(explicitFile);
      evidenceSource = "file";
      evidenceFilePath = explicitFile;
    } else if (existsSync(autoFile)) {
      evidenceEntries = countEvidenceFileLines(autoFile);
      evidenceSource = "file";
      evidenceFilePath = autoFile;
    } else {
      evidenceEntries = deriveEvidenceLogged(opts.taskId, opts.ledgerDb);
      evidenceSource = "ledger";
    }
  }

  const context = buildContext(opts, evidenceEntries);
  const claim = opts.claim ?? `PR for task ${opts.taskId} is safe to merge`;
  const result = evaluateMergeApproval(claim, context);
  return {
    taskId: opts.taskId,
    pr: opts.pr ?? null,
    evidenceEntries,
    evidenceSource,
    evidenceFilePath,
    result,
  };
}

export interface ExportOptions {
  taskId: string;
  ledgerDb?: string;
  out?: string;
}

/**
 * Dump all ledger entries for `session = <taskId>` as JSONL. When `out`
 * is omitted, returns the JSONL string (callers write to stdout). When
 * `out` is provided, parent directory is auto-created and the file is
 * written.
 */
export function runExport(opts: ExportOptions): {
  count: number;
  path: string | null;
  body: string;
} {
  if (!opts.taskId) {
    throw new Error("--task-id is required");
  }
  resetDb();
  const db = getDb(opts.ledgerDb);
  const entries = listEntries(db, { session: opts.taskId });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");

  if (opts.out) {
    const parent = dirname(opts.out);
    if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(opts.out, body, "utf8");
    return { count: entries.length, path: opts.out, body };
  }
  return { count: entries.length, path: null, body };
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
    .option(
      "--evidence-file <path>",
      "explicit path to a committed evidence JSONL file (default: ./.agent-grounding/evidence/<task-id>.jsonl if it exists)",
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
    .command("export")
    .description(
      "Dump evidence-ledger entries for one task as JSONL. Commit the output to .agent-grounding/evidence/<task-id>.jsonl so the merge-approval Action can see it on CI.",
    )
    .requiredOption("--task-id <id>", "agent-tasks task id (ledger session key)")
    .option(
      "--ledger-db <path>",
      "evidence-ledger DB path (default: $EVIDENCE_LEDGER_DB or ~/.evidence-ledger/ledger.db)",
    )
    .option(
      "--out <path>",
      "write JSONL to this file (parent dir auto-created); default: write to stdout",
    )
    .action((opts: ExportOptions) => {
      const ledgerDb = opts.ledgerDb ?? process.env.EVIDENCE_LEDGER_DB;
      const result = runExport({ ...opts, ledgerDb });
      if (result.path) {
        process.stderr.write(
          `wrote ${result.count} entries to ${result.path}\n`,
        );
      } else {
        process.stdout.write(result.body);
      }
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
