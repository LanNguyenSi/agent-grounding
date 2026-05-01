// Helper script for fs-atomic.test.ts. Spawned N times in parallel, each
// instance writes a distinct JSON payload to the same final path through
// writeAtomicJSON. argv: <distPath-of-fs.js> <finalPath> <payloadId>
import { argv } from "node:process";

const [, , fsModulePath, finalPath, payloadId] = argv;
const { writeAtomicJSON } = await import(fsModulePath);

writeAtomicJSON(finalPath, {
  payloadId,
  filler: "x".repeat(2048),
  ts: Date.now(),
});
