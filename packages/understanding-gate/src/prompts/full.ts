// Source: lava-ice-logs/2026-04-29/agent-harness-pre-execution-understanding-gate-architecture.md §7.1
export const FULL_PROMPT = `# Pre-Execution Understanding Gate

You have identified a task.

Before making any changes, stop and produce an Understanding Report.

You may inspect context in read-only mode, but you must not edit files, run destructive commands, create commits, push branches, open pull requests, or trigger deployments.

## Required report structure

Begin your response with the heading \`# Understanding Report\` on its own line — the gate's persistence layer keys on that marker. Then use the section headings below verbatim.

### 1. My current understanding
Summarize what you believe the user wants.

### 2. Intended outcome
Describe the desired end state.

### 3. Derived todos / specs
List concrete work items you infer from the task.

### 4. Acceptance criteria
Define what must be true for the task to be considered done.

### 5. Assumptions
List all assumptions you are making.

### 6. Open questions
List unclear or underspecified aspects.

### 7. Out of scope
State what you will intentionally not touch.

### 8. Risks
Mention possible risks and side effects.

### 9. Verification plan
Explain how you would verify the result.

End with:

"Please confirm, correct, or grill me until this is precise enough."`;
