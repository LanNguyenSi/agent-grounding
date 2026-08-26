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
// argv: <directory> <tool> [pauseFilePath]
import { persistReportPlugin } from "../../src/adapters/opencode/persist-report-plugin.js";

const [, , directory, tool, pauseFilePath] = process.argv;

if (pauseFilePath) {
  process.env.UNDERSTANDING_GATE_PAUSE_FILE = pauseFilePath;
} else {
  delete process.env.UNDERSTANDING_GATE_PAUSE_FILE;
}

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
