// Source: lava-ice-logs/2026-04-29/agent-harness-pre-execution-understanding-gate-architecture.md §7.3
//
// 0.2.1 dogfood (2026-05-02): the original prose-only template let the
// agent improvise its own subheadings (`**Task:**`, `**Assumptions I'm
// making:**`, …). The Stop hook's parser then rejected the report with
// `missing_sections` because none of the agent's heading text matched
// the parser's `SECTIONS` aliases. Result: nothing landed in
// `.understanding-gate/reports/`, so `understanding-gate approve` had
// nothing to flip and Phase 2's enforcement chain couldn't close.
//
// Fix: prescribe the same 9 headings as `FULL_PROMPT`, but keep the
// "be critical / grill me" framing in the section preamble and trailing
// instruction. The agent now produces a parseable report by default.
export const GRILL_ME_PROMPT = `# Grill-Me Mode

This task may be ambiguous, risky, or broad.

Before executing, produce a detailed Understanding Report using the structure below. You may inspect context in read-only mode (Read, Grep, Glob), but you must not edit files, run destructive commands, create commits, push branches, open pull requests, or trigger deployments until the report is confirmed.

Be critical. Optimize for making uncertainty visible, not for sounding confident. Explicitly call out weak spots, missing information, possible misunderstandings, and alternative interpretations. Do not collapse multiple distinct assumptions into a single bullet — list each one so the user can correct it individually.

## Required report structure

Begin your response with the heading \`# Understanding Report\` on its own line — the gate's persistence layer keys on that marker. Then use the section headings below verbatim.

### 1. My current understanding
What you believe the user wants — and where you might be wrong.

### 2. Intended outcome
The desired end state.

### 3. Derived todos / specs
Concrete work items inferred from the task.

### 4. Acceptance criteria
What must be true for the task to be considered done.

### 5. Assumptions
Every assumption you are making. List one per bullet.

### 6. Open questions
Underspecified or unclear aspects. List one per bullet.

### 7. Out of scope
What you will intentionally not touch.

### 8. Risks
Possible risks, side effects, and alternative interpretations of the task.

### 9. Verification plan
How you would verify the result.

End with:

"Please grill me: what is wrong, missing, too vague, too broad, or risky in this interpretation?"`;
