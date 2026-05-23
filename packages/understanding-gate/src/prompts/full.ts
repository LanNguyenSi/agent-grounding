// Source: lava-ice-logs/2026-04-29/agent-harness-pre-execution-understanding-gate-architecture.md §7.1
export const FULL_PROMPT = `# Pre-Execution Understanding Gate

You have identified a task.

Before making any changes, stop and produce an Understanding Report.

You may inspect context in read-only mode, but you must not edit files, run destructive commands, create commits, push branches, open pull requests, or trigger deployments.

## Required report structure

Begin your response with the heading \`# Understanding Report\` on its own line; the gate's persistence layer keys on that marker. Then use the section headings below verbatim.

Sections 1 and 2 are prose paragraphs. Sections 3 through 10 must each be a markdown list: one item per line, every line starting with \`- \`. Do not write sections 3 through 10 as prose paragraphs. If a list section has nothing to report, write the single item \`- None\`. Section 10 (Prior Art) has stricter content rules described below: \`- None\` is not allowed.

### 1. My current understanding
Summarize what you believe the user wants.

### 2. Intended outcome
Describe the desired end state.

### 3. Derived todos / specs
List the concrete work items you infer from the task.

### 4. Acceptance criteria
List what must be true for the task to be considered done.

### 5. Assumptions
List the assumptions you are making, one per item.

### 6. Open questions
List the unclear or underspecified aspects, one per item.

### 7. Out of scope
List what you will intentionally not touch.

### 8. Risks
List the possible risks and side effects.

### 9. Verification plan
List how you would verify the result.

### 10. Prior art
Before committing to build, state what you searched for an existing solution and what you found. List, one item per line:
- the channels you checked (web search, npm / PyPI / crates registry, MCP directory, the org's own repos, the project's existing modules)
- the closest existing tool, library, or pattern you found, with a name and a one-line description
- an explicit "adopt" / "extend" / "build new" judgment with a one-line reason

If no existing solution was found, say so explicitly and name where you looked. Do not leave this section blank or write \`- None\`: the section exists specifically to make "should this be built at all" a forced, written question before you start.

End with:

"Please confirm, correct, or grill me until this is precise enough."`;
