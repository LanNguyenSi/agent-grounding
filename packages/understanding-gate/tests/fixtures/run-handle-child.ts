// Helper script for the FIFO regression test in claude-code-handle.test.ts.
// Spawned as a REAL child process (via tsx) rather than imported into the
// test worker: a blocking readFileSync inside isPaused would otherwise
// block the vitest worker thread itself, and a synchronous blocking read
// never yields to the event loop that would run vitest's own `it(...,
// timeout)` timer -- so an in-process call can hang the whole suite. Out
// of process, the parent's execFileSync({ timeout }) kills THIS process
// with a real OS signal instead, turning a regression into a failed
// assertion (ETIMEDOUT) rather than a hang.
// argv: <prompt> [pauseFilePath]
import { handleUserPromptSubmit } from "../../src/adapters/claude-code/handle.js";

const [, , prompt, pauseFilePath] = process.argv;
const env = pauseFilePath
  ? { UNDERSTANDING_GATE_PAUSE_FILE: pauseFilePath }
  : {};
const out = handleUserPromptSubmit(JSON.stringify({ prompt }), env);
process.stdout.write(out);
