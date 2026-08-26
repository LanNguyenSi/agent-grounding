// Helper script for the FIFO regression test in
// opencode-tool-execute-before.test.ts. Spawned as a REAL child process
// (via tsx) rather than imported into the test worker: a blocking
// readFileSync inside isPaused would otherwise block the vitest worker
// thread itself, and a synchronous blocking read never yields to the
// event loop that would run vitest's own `it(..., timeout)` timer -- so
// an in-process call can hang the whole suite. Out of process, the
// parent's execFileSync({ timeout }) kills THIS process with a real OS
// signal instead, turning a regression into a failed assertion
// (ETIMEDOUT) rather than a hang. Mirrors run-handle-child.ts for the
// Claude Code UserPromptSubmit path.
//
// Unlike handleUserPromptSubmit (which takes its pause-file path as a
// function parameter), enforceBeforeToolExecute reads
// UNDERSTANDING_GATE_PAUSE_FILE straight off process.env, so this
// process's env has to be exactly what the test intends -- the caller
// (opencode-tool-execute-before.test.ts) passes an explicit `env` built
// from process.env with every UNDERSTANDING_GATE_* key stripped except
// UNDERSTANDING_GATE_PAUSE_FILE, so no ambient var from another test or
// the developer's shell can change this probe's outcome.
// argv: <directory> <tool>
import { persistReportPlugin } from "../../src/adapters/opencode/persist-report-plugin.js";

const [, , directory, tool] = process.argv;

async function main(): Promise<void> {
  const hooks = await persistReportPlugin({
    client: {
      session: {
        message: async () => ({ data: { info: undefined, parts: [] } }),
      },
    },
    directory,
  });
  const fn = hooks["tool.execute.before"];
  if (!fn) throw new Error("tool.execute.before hook not registered");
  try {
    await fn({ tool, sessionID: "fifo-probe" }, {});
    process.stdout.write("allowed");
  } catch {
    process.stdout.write("blocked");
  }
}

main();
