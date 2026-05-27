#!/usr/bin/env node
// Thin entrypoint for the runtime-reality PreToolUse policy hook.
//
// Reads stdin, delegates to the pure handler, writes stdout/stderr,
// and exits with the computed code. All error paths exit 0 with empty
// stdout, the policy never crashes the harness even if its own state
// is broken.
//
// Probe wiring: this entrypoint ships WITHOUT a probe. The harness-side
// follow-up registers a probe command via env (RUNTIME_REALITY_PROBE_CMD)
// or links against a probe library. With no probe configured the policy
// degrades to allow (or block, if RUNTIME_REALITY_PROBE_FAIL_BLOCK=1).

import { handlePolicyPreToolUse } from "./handle-pre-tool-use.js";
import { loadExpectations } from "./expectations.js";
import { createJsonlAuditWriter, resolveDefaultAuditLogPath } from "./audit.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    return;
  }

  const result = handlePolicyPreToolUse(raw, process.env, {
    loadExpectations,
    probe: null,
    appendAudit: createJsonlAuditWriter(resolveDefaultAuditLogPath(process.env)),
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  process.stderr.write(`runtime-reality policy hook failed silently: ${String(err)}\n`);
  process.exitCode = 0;
});
