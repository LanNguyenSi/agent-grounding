#!/usr/bin/env node
// Thin entrypoint for the Claude Code UserPromptSubmit hook. Reads stdin,
// delegates to the pure handler, writes to stdout. All error paths exit 0
// with empty stdout: the v0 gate is non-blocking and must NEVER crash
// Claude Code, even on stdin parse failures or unexpected runtime errors.

import { readStdin } from "../io.js";
import { handleUserPromptSubmit } from "./handle.js";

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    // stdin overflow or read error: silent no-op.
    return;
  }

  const output = handleUserPromptSubmit(raw, process.env);
  if (output) process.stdout.write(output);
}

main().catch((err: unknown) => {
  // Last-resort guard. Log to stderr (Claude Code surfaces this in the
  // hook diagnostic stream) but exit 0 so the prompt still flows.
  process.stderr.write(
    `understanding-gate claude-code hook failed silently: ${String(err)}\n`,
  );
});
