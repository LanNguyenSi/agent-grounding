#!/usr/bin/env node
import { Command } from "commander";
import { runInit, runUninstall } from "./cli/init.js";
import { runOpencodeInit, runOpencodeUninstall } from "./cli/opencode.js";
import { runReportList, runReportShow } from "./cli/report.js";
import { runApprove, runRevoke, runStatus } from "./cli/approve.js";
import { getPromptSnippet, FULL_PROMPT } from "./prompts.js";
import type { Mode } from "./mode.js";
import type { Scope } from "./cli/paths.js";

type Target = "claude-code" | "opencode";

const program = new Command();
program
  .name("understanding-gate")
  .description(
    "Pre-execution gate that asks AI agents to produce an Understanding Report before acting.",
  )
  .version("0.2.1");

function resolveScope(value: string | undefined): Scope {
  if (value === "user" || value === "project") return value;
  if (value !== undefined) {
    throw new Error(`unknown --scope value: ${value} (expected user|project)`);
  }
  return "project";
}

function resolveTarget(value: string | undefined): Target {
  if (value === undefined || value === "claude-code") return "claude-code";
  if (value === "opencode") return "opencode";
  throw new Error(
    `unknown --target value: ${value} (expected claude-code|opencode)`,
  );
}

program
  .command("init")
  .description("Install the gate into a Claude Code or opencode setup")
  .option("--target <target>", "harness target", "claude-code")
  .option("--scope <scope>", "user or project", "project")
  .action((opts: { target?: string; scope?: string }) => {
    const target = resolveTarget(opts.target);
    const scope = resolveScope(opts.scope);
    if (target === "claude-code") {
      const result = runInit({ scope });
      if (result.changed) {
        process.stdout.write(
          `understanding-gate: wrote hook entries to ${result.path}\n` +
            `installed: UserPromptSubmit (Phase 0), Stop (Phase 1), PreToolUse (Phase 2)\n` +
            `next: try a prompt like "add a logout button to src/Header.tsx".\n` +
            `      after the agent emits the report, run \`understanding-gate approve\` to unlock write tools.\n` +
            `disable temporarily with: UNDERSTANDING_GATE_DISABLE=1 claude\n`,
        );
      } else {
        process.stdout.write(
          `understanding-gate: ${result.path} already has all hook entries; nothing to do.\n`,
        );
      }
      return;
    }
    // opencode
    const result = runOpencodeInit({ scope });
    const lines: string[] = [];
    if (result.rulesChanged) {
      lines.push(`understanding-gate: wrote rules file to ${result.paths.rules}`);
    } else {
      lines.push(`understanding-gate: ${result.paths.rules} unchanged.`);
    }
    if (result.commandChanged) {
      lines.push(
        `understanding-gate: wrote /grill command to ${result.paths.command}`,
      );
    } else {
      lines.push(`understanding-gate: ${result.paths.command} unchanged.`);
    }
    if (result.pluginChanged) {
      lines.push(
        `understanding-gate: wrote persist-report plugin shim to ${result.paths.plugin}`,
      );
    } else {
      lines.push(`understanding-gate: ${result.paths.plugin} unchanged.`);
    }
    lines.push(
      "note: opencode v0.5 has no per-prompt trigger; the rule applies always, type /grill for grill-me mode.",
    );
    lines.push(
      "note: opencode auto-loads .opencode/plugins/*.ts at startup; the shim resolves @lannguyensi/understanding-gate at import time.",
    );
    lines.push(
      "note: install the package via `npm install --save-dev @lannguyensi/understanding-gate` in your project (or pin a local path / tarball in .opencode/package.json) so opencode's Bun runtime can resolve it.",
    );
    process.stdout.write(`${lines.join("\n")}\n`);
  });

program
  .command("uninstall")
  .description("Remove the gate from a Claude Code or opencode setup")
  .option("--target <target>", "harness target", "claude-code")
  .option("--scope <scope>", "user or project", "project")
  .action((opts: { target?: string; scope?: string }) => {
    const target = resolveTarget(opts.target);
    const scope = resolveScope(opts.scope);
    if (target === "claude-code") {
      const result = runUninstall({ scope });
      if (result.changed) {
        process.stdout.write(
          `understanding-gate: removed hook entry from ${result.path}\n`,
        );
      } else {
        process.stdout.write(
          `understanding-gate: no hook entry found in ${result.path}; nothing to do.\n`,
        );
      }
      return;
    }
    // opencode
    const result = runOpencodeUninstall({ scope });
    const lines: string[] = [];
    lines.push(
      result.rulesRemoved
        ? `understanding-gate: removed rules file ${result.paths.rules}`
        : `understanding-gate: no rules file at ${result.paths.rules}; nothing to do.`,
    );
    lines.push(
      result.commandRemoved
        ? `understanding-gate: removed command file ${result.paths.command}`
        : `understanding-gate: no command file at ${result.paths.command}; nothing to do.`,
    );
    lines.push(
      result.pluginRemoved
        ? `understanding-gate: removed plugin shim ${result.paths.plugin}`
        : `understanding-gate: no plugin shim at ${result.paths.plugin}; nothing to do.`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
  });

program
  .command("print")
  .description("Print a prompt snippet to stdout (useful for debugging)")
  .option(
    "--mode <mode>",
    "fast_confirm | grill_me | full",
    "fast_confirm",
  )
  .action((opts: { mode?: string }) => {
    const mode = opts.mode ?? "fast_confirm";
    if (mode === "full") {
      process.stdout.write(`${FULL_PROMPT}\n`);
      return;
    }
    if (mode !== "fast_confirm" && mode !== "grill_me") {
      process.stderr.write(
        `unknown --mode: ${mode} (expected fast_confirm | grill_me | full)\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${getPromptSnippet(mode as Mode)}\n`);
  });

const report = program
  .command("report")
  .description("Inspect persisted Understanding Reports");

report
  .command("list")
  .description("List persisted reports")
  .option("--dir <path>", "override report directory")
  .option("--json", "emit JSON instead of a table")
  .action((opts: { dir?: string; json?: boolean }) => {
    const result = runReportList({ dir: opts.dir, json: opts.json });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });

report
  .command("show <id>")
  .description("Print a single report by taskId, filename, or absolute path")
  .option("--dir <path>", "override report directory")
  .action((id: string, opts: { dir?: string }) => {
    const result = runReportShow({ id, dir: opts.dir });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });

program
  .command("approve")
  .description("Mark the latest Understanding Report as approved (Phase 2 enforcement)")
  .option("--task-id <id>", "approve the latest report matching this taskId")
  .option("--report-id <id>", "approve a specific report (taskId, filename, or absolute path)")
  .option("--dir <path>", "override report directory")
  .action((opts: { taskId?: string; reportId?: string; dir?: string }) => {
    const result = runApprove({
      taskId: opts.taskId,
      reportId: opts.reportId,
      dir: opts.dir,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });

program
  .command("revoke")
  .description("Revoke a previously approved Understanding Report (set status=pending)")
  .option("--task-id <id>", "revoke approval for the latest report matching this taskId")
  .option("--report-id <id>", "revoke a specific report (taskId, filename, or absolute path)")
  .option("--dir <path>", "override report directory")
  .action((opts: { taskId?: string; reportId?: string; dir?: string }) => {
    const result = runRevoke({
      taskId: opts.taskId,
      reportId: opts.reportId,
      dir: opts.dir,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });

program
  .command("status")
  .description("Show approval state of persisted Understanding Reports")
  .option("--task-id <id>", "limit to a single taskId")
  .option("--dir <path>", "override report directory")
  .action((opts: { taskId?: string; dir?: string }) => {
    const result = runStatus({ taskId: opts.taskId, dir: opts.dir });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`understanding-gate: ${String(err)}\n`);
  process.exit(1);
});
