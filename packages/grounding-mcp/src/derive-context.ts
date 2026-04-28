// Map a grounding session's phase progress + ledger summary to the
// claim-gate ClaimContext shape.
//
// Why a phase status of 'skipped' counts as satisfied: a phase is skipped
// only when grounding-wrapper resolved no steps for it (e.g. runtime-
// inspection has no steps when the keyword doesn't trigger a runtime
// reality-checker). The agent literally has nothing to do for that phase,
// so requiring it as a prerequisite would be a deadlock.

import type { GroundingSession } from '@lannguyensi/grounding-wrapper';
import type { getSummary } from '@lannguyensi/evidence-ledger';
import type { ClaimContext } from '@lannguyensi/claim-gate';

type LedgerSummary = ReturnType<typeof getSummary>;

function phaseSatisfied(
  session: GroundingSession,
  phase: keyof GroundingSession['phase_status'],
): boolean {
  const status = session.phase_status[phase];
  return status === 'done' || status === 'skipped';
}

export function deriveContext(
  session: GroundingSession,
  ledgerSummary: LedgerSummary,
): ClaimContext {
  return {
    readme_read: phaseSatisfied(session, 'doc-reading'),
    process_checked: phaseSatisfied(session, 'runtime-inspection'),
    config_checked: phaseSatisfied(session, 'runtime-inspection'),
    health_checked: phaseSatisfied(session, 'runtime-inspection'),
    has_evidence: ledgerSummary.facts.length > 0,
    alternatives_considered: ledgerSummary.rejected.length > 0,
  };
}
