import type { LedgerEntry } from "./types.js";

export interface HandoffSummary {
  facts: LedgerEntry[];
  hypotheses: LedgerEntry[];
  rejected: LedgerEntry[];
  unknowns: LedgerEntry[];
}

export interface HandoffJson {
  session: string;
  generatedAt: string;
  status: {
    factsCount: number;
    hypothesesCount: number;
    rejectedCount: number;
    unknownsCount: number;
  };
  facts: { id: number; content: string; source: string | null; confidence: string }[];
  openHypotheses: { id: number; content: string; source: string | null; confidence: string }[];
  rejectedHypotheses: { id: number; content: string; source: string | null }[];
  openQuestions: { id: number; content: string; source: string | null }[];
  nextSteps: string[];
}

function nextSteps(summary: HandoffSummary): string[] {
  const steps: string[] = [];
  if (summary.unknowns.length > 0) steps.push("Investigate open questions");
  if (summary.hypotheses.length > 0) steps.push("Validate or reject remaining hypotheses");
  if (summary.unknowns.length === 0 && summary.hypotheses.length === 0) {
    steps.push("All resolved — ready to close");
  }
  return steps;
}

export function buildHandoffMarkdown(session: string, summary: HandoffSummary): string {
  const lines: string[] = [];
  const ts = new Date().toISOString();
  lines.push(`# Handoff — Session: ${session}`);
  lines.push(`Generated: ${ts}\n`);

  lines.push(`## Current Status`);
  lines.push(`- ${summary.facts.length} confirmed facts`);
  lines.push(`- ${summary.hypotheses.length} open hypotheses`);
  lines.push(`- ${summary.rejected.length} rejected hypotheses`);
  lines.push(`- ${summary.unknowns.length} open questions\n`);

  lines.push(`## Confirmed Facts`);
  if (summary.facts.length === 0) {
    lines.push(`_None yet._\n`);
  } else {
    for (const e of summary.facts) {
      lines.push(`- **${e.content}** (confidence: ${e.confidence}${e.source ? `, source: ${e.source}` : ""})`);
    }
    lines.push("");
  }

  lines.push(`## Open Hypotheses`);
  if (summary.hypotheses.length === 0) {
    lines.push(`_None._\n`);
  } else {
    for (const e of summary.hypotheses) {
      lines.push(`- ${e.content} (confidence: ${e.confidence}${e.source ? `, source: ${e.source}` : ""})`);
    }
    lines.push("");
  }

  lines.push(`## Rejected Hypotheses`);
  lines.push(`> These were investigated and disproven. Do not re-investigate.\n`);
  if (summary.rejected.length === 0) {
    lines.push(`_None._\n`);
  } else {
    for (const e of summary.rejected) {
      lines.push(`- ~~${e.content}~~${e.source ? ` — ${e.source}` : ""}`);
    }
    lines.push("");
  }

  lines.push(`## Open Questions`);
  if (summary.unknowns.length === 0) {
    lines.push(`_None._\n`);
  } else {
    for (const e of summary.unknowns) {
      lines.push(`- ${e.content}${e.source ? ` (${e.source})` : ""}`);
    }
    lines.push("");
  }

  lines.push(`## Next Steps`);
  const steps = nextSteps(summary);
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");

  return lines.join("\n");
}

export function buildHandoffJson(session: string, summary: HandoffSummary): HandoffJson {
  return {
    session,
    generatedAt: new Date().toISOString(),
    status: {
      factsCount: summary.facts.length,
      hypothesesCount: summary.hypotheses.length,
      rejectedCount: summary.rejected.length,
      unknownsCount: summary.unknowns.length,
    },
    facts: summary.facts.map((e) => ({ id: e.id, content: e.content, source: e.source, confidence: e.confidence })),
    openHypotheses: summary.hypotheses.map((e) => ({ id: e.id, content: e.content, source: e.source, confidence: e.confidence })),
    rejectedHypotheses: summary.rejected.map((e) => ({ id: e.id, content: e.content, source: e.source })),
    openQuestions: summary.unknowns.map((e) => ({ id: e.id, content: e.content, source: e.source })),
    nextSteps: nextSteps(summary),
  };
}
