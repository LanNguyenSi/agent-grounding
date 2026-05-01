// Post-save hypothesis-sync helper, factored out of the Stop binary so
// both the binary entrypoint and tests can drive it without spawning a
// child process. Side effect: on sync error, drops a side-channel log
// file under the resolved sync-error dir. Returns the SyncOutcome so
// callers (or tests) can inspect what happened.

import { dirname } from "node:path";
import {
  syncHypothesesFromReport,
  type SyncOutcome,
} from "../../core/hypothesis-sync.js";
import type { UnderstandingReport } from "../../schema/types.js";

export interface SyncAndLogDeps {
  /** Resolves the directory where the sync-error log should land. */
  resolveSyncErrorDir: () => string;
  /** Atomic stamped-log writer, mirroring writeParseErrorLog. */
  writeSyncErrorLog: (dir: string, payload: string) => string;
}

export function runSyncAndLog(
  report: UnderstandingReport,
  reportPath: string,
  sessionId: string,
  deps: SyncAndLogDeps,
): SyncOutcome {
  const outcome = syncHypothesesFromReport(report, {
    reportDir: dirname(reportPath),
    sessionId,
  });
  if (outcome.kind === "error") {
    try {
      deps.writeSyncErrorLog(deps.resolveSyncErrorDir(), outcome.message);
    } catch {
      // The side-channel log itself failing must not crash the harness.
    }
  }
  return outcome;
}
