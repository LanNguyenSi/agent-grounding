// grounding-sdk — ergonomic facade over the agent-grounding building blocks.
//
// Three entry points (`verify`, `track`, `validate`) wrap existing
// `claim-gate`, `hypothesis-tracker`, and `evidence-ledger` primitives.
// No new engine, no persistence beyond what those packages already own —
// this layer exists to spare agent code from learning the full surface.

import {
  evaluateClaim,
  type ClaimContext,
  type ClaimResult,
  type ClaimType,
} from "@lannguyensi/claim-gate";
import type { GroundingPhase, GroundingSession } from "@lannguyensi/grounding-wrapper";
import {
  addHypothesis,
  createStore,
  type Hypothesis,
  type HypothesisStore,
} from "@lannguyensi/hypothesis-tracker";
import type { LedgerSummary } from "@lannguyensi/evidence-ledger";

// Public types — re-exported so consumers only import from this SDK.
export type {
  ClaimContext,
  ClaimResult,
  ClaimType,
  GroundingPhase,
  GroundingSession,
  Hypothesis,
  HypothesisStore,
  LedgerSummary,
};
export { createStore };

// -- verify -----------------------------------------------------------------

/**
 * Evidence flags the agent has collected, in the SDK's camelCase shape.
 * Each field maps 1:1 to a claim-gate ClaimContext prerequisite.
 * Omitting a field is equivalent to `false` (not yet checked).
 */
export interface Evidence {
  readmeRead?: boolean;
  processChecked?: boolean;
  configChecked?: boolean;
  healthChecked?: boolean;
  hasEvidence?: boolean;
  alternativesConsidered?: boolean;
}

function toClaimContext(e: Evidence): ClaimContext {
  return {
    readme_read: e.readmeRead,
    process_checked: e.processChecked,
    config_checked: e.configChecked,
    health_checked: e.healthChecked,
    has_evidence: e.hasEvidence,
    alternatives_considered: e.alternativesConsidered,
  };
}

/**
 * Evaluate a claim against explicit evidence flags. Synchronous.
 *
 * Thin wrapper around `claim-gate`'s `evaluateClaim`. Use when evidence
 * is already in hand and no grounding session is involved.
 */
export function verify(
  claim: string,
  evidence: Evidence = {},
  type?: ClaimType,
): ClaimResult {
  return evaluateClaim(claim, toClaimContext(evidence), type);
}

// -- track ------------------------------------------------------------------

export interface TrackInput {
  text: string;
  requiredChecks?: string[];
}

/**
 * Register a hypothesis in the given store and return it (with the
 * auto-generated id and timestamps). The store is the `hypothesis-tracker`
 * in-memory shape — callers who need persistence should snapshot it via
 * `exportStore` / `importStore` from that package.
 *
 * Accepts either a plain string (shorthand for `{ text }`) or a
 * `TrackInput` with optional required checks.
 */
export function track(
  store: HypothesisStore,
  input: TrackInput | string,
): Hypothesis {
  const text = typeof input === "string" ? input : input.text;
  const requiredChecks =
    typeof input === "string" ? [] : (input.requiredChecks ?? []);
  return addHypothesis(store, text, requiredChecks);
}

// -- validate ---------------------------------------------------------------

export interface ValidateInput {
  session: GroundingSession;
  claim: string;
  type?: ClaimType;
  /**
   * Optional ledger summary for the session. When provided, enriches the
   * derived context with `has_evidence` / `alternatives_considered`
   * signals. When omitted, validate() derives context from phase
   * progress only — the result is still well-defined, just based on
   * fewer inputs.
   */
  ledgerSummary?: LedgerSummary;
}

export interface ValidateResult extends ClaimResult {
  derivedContext: ClaimContext;
}

/**
 * Aggregate a grounding session's phase progress with (optionally) its
 * ledger summary and evaluate a claim against the result. Mirrors the
 * MCP `claim_evaluate_from_session` tool's logic for in-process use —
 * callers pass the session object directly instead of a session id, so
 * the SDK does not depend on any particular persistence layer.
 */
export function validate(input: ValidateInput): ValidateResult {
  const derivedContext = deriveContextFromSession(
    input.session,
    input.ledgerSummary,
  );
  const result = evaluateClaim(input.claim, derivedContext, input.type);
  return { ...result, derivedContext };
}

// -- context derivation -----------------------------------------------------

// A phase counts as satisfied when it's `done` or `skipped`. `skipped`
// means grounding-wrapper resolved no steps for that phase — requiring
// it as a prereq would be a deadlock. Mirrors the identical logic in
// grounding-mcp/src/derive-context.ts; kept in sync manually to avoid
// an SDK-layer dep on the MCP server package.
//
// `phase: GroundingPhase` (not `string`) so a typo in a phase name is
// caught at compile time — precisely the class of silent-wrong-answer
// bug this SDK exists to prevent.
function phaseSatisfied(
  session: GroundingSession,
  phase: GroundingPhase,
): boolean {
  const status = session.phase_status[phase];
  return status === "done" || status === "skipped";
}

/**
 * Exported in case a consumer already has a ClaimContext-based flow and
 * just wants the phase→context mapping. Not the primary entry point.
 */
export function deriveContextFromSession(
  session: GroundingSession,
  summary?: LedgerSummary,
): ClaimContext {
  return {
    readme_read: phaseSatisfied(session, "doc-reading"),
    process_checked: phaseSatisfied(session, "runtime-inspection"),
    config_checked: phaseSatisfied(session, "runtime-inspection"),
    health_checked: phaseSatisfied(session, "runtime-inspection"),
    has_evidence: (summary?.facts.length ?? 0) > 0,
    alternatives_considered: (summary?.rejected.length ?? 0) > 0,
  };
}
