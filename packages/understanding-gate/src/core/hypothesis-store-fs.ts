// Tiny fs wrapper for the hypothesis-tracker store. The tracker itself
// has no persistence opinions — it owns the data shape and the
// addHypothesis/etc. mutators, but where the JSON lives is the
// consumer's call.
//
// We co-locate the store with the report dir as
// `<reportRoot>/../hypotheses.json` so dogfood inspection is
// `cat .understanding-gate/hypotheses.json`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createStore,
  type HypothesisStore,
} from "@lannguyensi/hypothesis-tracker";

export const HYPOTHESES_STORE_FILENAME = "hypotheses.json";

export function loadOrCreateStore(
  path: string,
  session = "default",
): HypothesisStore {
  if (!existsSync(path)) return createStore(session);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { hypotheses?: unknown }).hypotheses) &&
      typeof (parsed as { session?: unknown }).session === "string"
    ) {
      return parsed as HypothesisStore;
    }
  } catch {
    // fall through to a fresh store on corrupt JSON
  }
  return createStore(session);
}

export function saveStore(path: string, store: HypothesisStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
