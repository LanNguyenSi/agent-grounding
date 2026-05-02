#!/usr/bin/env node
// Thin entrypoint for the Claude Code PreToolUse hook. Reads stdin,
// delegates to the pure handler, writes stdout/stderr, exits with the
// computed code. All error paths exit 0 with empty stdout: the gate
// must never crash the harness, even if its own state is broken.

import { readStdin } from "../io.js";
import { listReports } from "../../core/persistence.js";
import {
  appendAuditLine,
  defaultAuditLogPath,
  type AuditEvent,
} from "../../core/audit.js";
import { handlePreToolUse } from "./handle-pre-tool-use.js";

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    return;
  }

  const result = handlePreToolUse(raw, process.env, {
    listReports: (opts) => listReports(opts),
    now: () => new Date(),
    appendAudit: (cwd: string, event: AuditEvent) => {
      appendAuditLine(defaultAuditLogPath(cwd), event);
    },
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `understanding-gate claude-code pre-tool-use hook failed silently: ${String(err)}\n`,
  );
  // Pin the exit code so a future edit that lets a throw escape `main`
  // doesn't accidentally exit non-zero and crash the harness — the
  // header comment promises "all error paths exit 0 with empty stdout".
  process.exitCode = 0;
});
