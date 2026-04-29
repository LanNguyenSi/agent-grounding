#!/usr/bin/env node
import { Command } from "commander";
import { runInit, runUninstall } from "./cli/init.js";
import { getPromptSnippet, FULL_PROMPT } from "./prompts.js";
import type { Mode } from "./mode.js";
import type { Scope } from "./cli/paths.js";

const program = new Command();
program
  .name("understanding-gate")
  .description(
    "Pre-execution gate that asks AI agents to produce an Understanding Report before acting.",
  )
  .version("0.1.0");

function resolveScope(value: string | undefined): Scope {
  if (value === "user" || value === "project") return value;
  if (value !== undefined) {
    throw new Error(`unknown --scope value: ${value} (expected user|project)`);
  }
  return "project";
}

function resolveTarget(value: string | undefined): "claude-code" {
  if (value === undefined || value === "claude-code") return "claude-code";
  throw new Error(
    `unknown --target value: ${value} (only claude-code is supported in Phase 0)`,
  );
}

program
  .command("init")
  .description("Wire the hook binary into a Claude Code installation")
  .option("--target <target>", "harness target", "claude-code")
  .option("--scope <scope>", "user or project", "project")
  .action((opts: { target?: string; scope?: string }) => {
    resolveTarget(opts.target);
    const scope = resolveScope(opts.scope);
    const result = runInit({ scope });
    if (result.changed) {
      process.stdout.write(
        `understanding-gate: wrote hook entry to ${result.path}\n` +
          `next: try a prompt like "add a logout button to src/Header.tsx"\n` +
          `disable temporarily with: UNDERSTANDING_GATE_DISABLE=1 claude\n`,
      );
    } else {
      process.stdout.write(
        `understanding-gate: ${result.path} already has the hook entry; nothing to do.\n`,
      );
    }
  });

program
  .command("uninstall")
  .description("Remove the hook entry from settings.json")
  .option("--target <target>", "harness target", "claude-code")
  .option("--scope <scope>", "user or project", "project")
  .action((opts: { target?: string; scope?: string }) => {
    resolveTarget(opts.target);
    const scope = resolveScope(opts.scope);
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

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`understanding-gate: ${String(err)}\n`);
  process.exit(1);
});
