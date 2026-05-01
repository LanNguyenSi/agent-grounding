// Tiny fs wrapper for the hypothesis-tracker store. The tracker itself
// has no persistence opinions — it owns the data shape and the
// addHypothesis/etc. mutators, but where the JSON lives is the
// consumer's call.
//
// We co-locate the store with the report dir as
// `<reportRoot>/../hypotheses.json` so dogfood inspection is
// `cat .understanding-gate/hypotheses.json`.

import { existsSync, readFileSync } from "node:fs";
import {
  createStore,
  type Hypothesis,
  type HypothesisStore,
} from "@lannguyensi/hypothesis-tracker";
import { writeAtomicJSON } from "./fs.js";

export const HYPOTHESES_STORE_FILENAME = "hypotheses.json";

export interface LoadResult {
  store: HypothesisStore;
  /** Count of array entries that failed per-entry validation. */
  droppedCount: number;
}

export function loadOrCreateStore(
  path: string,
  session = "default",
): LoadResult {
  if (!existsSync(path)) {
    return { store: createStore(session), droppedCount: 0 };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { hypotheses?: unknown }).hypotheses) &&
      typeof (parsed as { session?: unknown }).session === "string"
    ) {
      const top = parsed as { session: string; hypotheses: unknown[] };
      const valid: Hypothesis[] = [];
      let droppedCount = 0;
      for (const entry of top.hypotheses) {
        if (isValidHypothesis(entry)) valid.push(entry);
        else droppedCount += 1;
      }
      return {
        store: { session: top.session, hypotheses: valid },
        droppedCount,
      };
    }
  } catch {
    // fall through to a fresh store on corrupt JSON
  }
  return { store: createStore(session), droppedCount: 0 };
}

export function saveStore(path: string, store: HypothesisStore): void {
  writeAtomicJSON(path, store);
}

// Keep in sync with Hypothesis['status'] in @lannguyensi/hypothesis-tracker.
// If the upstream union grows, this guard will silently drop valid rows.
const VALID_STATUSES = new Set(["unverified", "supported", "rejected"]);

export function isValidHypothesis(entry: unknown): entry is Hypothesis {
  if (!entry || typeof entry !== "object") return false;
  const h = entry as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    typeof h.text === "string" &&
    typeof h.status === "string" &&
    VALID_STATUSES.has(h.status) &&
    Array.isArray(h.evidence) &&
    Array.isArray(h.required_checks) &&
    typeof h.createdAt === "string" &&
    typeof h.updatedAt === "string"
  );
}
