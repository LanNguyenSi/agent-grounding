#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { evaluateClaim, detectClaimType, POLICIES } from "./lib.js";
import type { ClaimContext, ClaimType } from "./lib.js";

// Reads the version from package.json instead of hardcoding it, so the CLI
// can never desync from the published version on a release bump. Resolved
// relative to this module so it works both from src/ (dev, via tsx) and from
// the built dist/ layout (dist/cli.js sits one level below the package root,
// same as src/cli.ts), and package.json is always included in the npm
// tarball via the `files` field.
function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const text = readFileSync(url, "utf8");
    const pkg = JSON.parse(text) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("claim-gate")
    .description("Policy engine for agent diagnoses")
    .version(readVersion());

  program
    .command("check <claim>")
    .description("Check if a claim is allowed given current context")
    .option("--readme", "README has been read")
    .option("--process", "process state has been checked")
    .option("--config", "configuration source has been verified")
    .option("--health", "health/port/status check performed")
    .option("--evidence", "supporting evidence exists")
    .option("--alternatives", "alternative hypotheses have been considered")
    .option("--type <type>", "claim type override (root_cause|architecture|network|...)")
    .option("--json", "output JSON")
    .action(
      (
        claim: string,
        opts: {
          readme?: boolean;
          process?: boolean;
          config?: boolean;
          health?: boolean;
          evidence?: boolean;
          alternatives?: boolean;
          type?: string;
          json?: boolean;
        },
      ) => {
        const context: ClaimContext = {
          readme_read: opts.readme,
          process_checked: opts.process,
          config_checked: opts.config,
          health_checked: opts.health,
          has_evidence: opts.evidence,
          alternatives_considered: opts.alternatives,
        };

        const result = evaluateClaim(claim, context, opts.type as ClaimType | undefined);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log();
        const statusIcon = result.allowed ? chalk.green("✅ ALLOWED") : chalk.red("🚫 BLOCKED");
        console.log(`${statusIcon} — ${chalk.bold(result.claim)}`);
        console.log(chalk.dim(`  Type: ${result.type} | Readiness: ${result.score}%`));

        if (!result.allowed) {
          console.log();
          console.log(chalk.red("  Missing prerequisites:"));
          result.reasons.forEach((r) => console.log(chalk.red(`    · ${r}`)));
          console.log();
          console.log(chalk.yellow("  Required next steps:"));
          result.next_steps.forEach((s) => console.log(chalk.yellow(`    → ${s}`)));
        }
        console.log();

        if (!result.allowed) process.exit(1);
      },
    );

  program
    .command("policies")
    .description("List all claim policies")
    .action(() => {
      console.log();
      console.log(chalk.bold.cyan("📋 Claim Gate Policies"));
      console.log();
      POLICIES.forEach((p) => {
        console.log(chalk.bold(`  ${p.type}`));
        console.log(chalk.dim(`    ${p.description}`));
        console.log(`    Requires: ${p.requires.join(", ")}`);
        console.log();
      });
    });

  return program;
}

// Only run when executed directly as a script (not when imported in tests).
// realpathSync resolves the node_modules/.bin/claim-gate symlink so the
// published bin still triggers the CLI: node leaves process.argv[1] as the
// symlink path but resolves import.meta.url to the realpath, so a naive `===`
// compares false and the bin silently no-ops. Mirrors grounding-mcp/server.ts.
function resolveArgv1(): string | undefined {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return undefined;
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}
if (resolveArgv1() === fileURLToPath(import.meta.url)) {
  buildProgram().parse();
}
