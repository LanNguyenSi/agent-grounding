// Adapter-side glue: load the hypothesis store from a known path,
// register the report's assumptions + open questions via the bridge,
// save the store back atomically. Best-effort and never throws — same
// "don't crash the harness" stance as the rest of the v0 hooks.

import { resolve } from "node:path";
import type { UnderstandingReport } from "../schema/types.js";
import {
  registerReportHypotheses,
  type RegisterResult,
} from "./hypothesis-bridge.js";
import {
  HYPOTHESES_STORE_FILENAME,
  loadOrCreateStore,
  saveStore,
} from "./hypothesis-store-fs.js";

export type SyncOutcome =
  | { kind: "ok"; storePath: string; result: RegisterResult }
  | { kind: "error"; message: string };

export interface SyncOptions {
  /**
   * Directory the report was just saved into (typically
   * `.understanding-gate/reports/`). The hypothesis store lives one
   * level up so the dogfood layout is:
   *   .understanding-gate/
   *     reports/...
   *     hypotheses.json
   */
  reportDir: string;
  /** Session id from the harness — used as the tracker store's session label. */
  sessionId: string;
}

export function syncHypothesesFromReport(
  report: UnderstandingReport,
  opts: SyncOptions,
): SyncOutcome {
  try {
    const storePath = resolve(opts.reportDir, "..", HYPOTHESES_STORE_FILENAME);
    const store = loadOrCreateStore(storePath, opts.sessionId);
    const result = registerReportHypotheses(report, store);
    if (result.added.length > 0) {
      saveStore(storePath, store);
    }
    return { kind: "ok", storePath, result };
  } catch (err) {
    return { kind: "error", message: String(err) };
  }
}
