// Atomic file-write helpers used by every persistence site in
// understanding-gate. A write opens a uniquely-named tmp file in the
// destination directory, fsyncs, then renames over the final path. A
// crash between open and rename leaves only the tmp file (cleaned up
// best-effort on rename failure); a crash after rename leaves the file
// in its new state. Concurrent writers each pick a distinct tmp name
// and race only at rename time, where the last writer wins.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type WriteAtomicOptions = {
  /** mkdir -p the parent directory before writing. Default: true. */
  mkdir?: boolean;
};

export function writeAtomicText(
  finalPath: string,
  contents: string,
  opts: WriteAtomicOptions = {},
): void {
  if (opts.mkdir !== false) {
    mkdirSync(dirname(finalPath), { recursive: true });
  }
  const tmpPath = `${finalPath}.tmp-${randomBytes(6).toString("hex")}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "wx", 0o644);
    writeSync(fd, contents);
    fsyncSync(fd);
  } catch {
    // Fallback for environments where openSync/fsync misbehave (rare).
    writeFileSync(tmpPath, contents, { encoding: "utf8", flag: "w" });
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function writeAtomicJSON(
  finalPath: string,
  value: unknown,
  opts: WriteAtomicOptions = {},
): void {
  writeAtomicText(finalPath, `${JSON.stringify(value, null, 2)}\n`, opts);
}
