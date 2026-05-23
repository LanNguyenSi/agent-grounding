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

Be critical. Optimize for making uncertainty visible, not for sounding confident. Explicitly call out weak spots, missing information, possible misunderstandings, and alternative interpretations. Do not collapse multiple distinct assumptions into a single bullet: list each one so the user can correct it individually.

## Required report structure

Begin your response with the heading \`# Understanding Report\` on its own line; the gate's persistence layer keys on that marker. Then use the section headings below verbatim.

Sections 1 and 2 are prose paragraphs. Sections 3 through 10 must each be a markdown list: one item per line, every line starting with \`- \`. Do not write sections 3 through 10 as prose paragraphs. If a list section has nothing to report, write the single item \`- None\`. Section 10 (Prior Art) has stricter content rules described below: \`- None\` is not allowed.

### 1. My current understanding
What you believe the user wants, and where you might be wrong.

### 2. Intended outcome
The desired end state.

### 3. Derived todos / specs
List the concrete work items inferred from the task.

### 4. Acceptance criteria
List what must be true for the task to be considered done.

### 5. Assumptions
List every assumption you are making, one per item. Do not collapse distinct assumptions into a single item.

### 6. Open questions
List the underspecified or unclear aspects, one per item.

### 7. Out of scope
List what you will intentionally not touch.

### 8. Risks
List the possible risks, side effects, and alternative interpretations of the task.

### 9. Verification plan
List how you would verify the result.

### 10. Prior art
Before committing to build, state what you searched for an existing solution and what you found. List, one item per line:
- the channels you checked (web search, npm / PyPI / crates registry, MCP directory, the org's own repos, the project's existing modules)
- the closest existing tool, library, or pattern you found, with a name and a one-line description
- an explicit "adopt" / "extend" / "build new" judgment with a one-line reason

If no existing solution was found, say so explicitly and name where you looked. Do not leave this section blank or write \`- None\`: the section exists specifically to make "should this be built at all" a forced, written question before you start. Grill-me mode in particular should not skip this; the broader the task, the higher the risk of re-implementing something that already exists.

End with:

"Please grill me: what is wrong, missing, too vague, too broad, or risky in this interpretation?"`;
