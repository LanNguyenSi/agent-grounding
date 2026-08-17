# understanding-gate: opencode + npm-published-package dogfood

Post-publish dogfood: run a real `opencode` session against the **npm-published**
`@lannguyensi/understanding-gate` package (not the workspace-linked dev copy) and
verify two things end to end:

1. A stamped Understanding Report JSON lands in `.understanding-gate/reports/`.
2. A forced-failure scenario produces a `transport_error` breadcrumb under
   `.understanding-gate/parse-errors/`.

Recorded 2026-08-17. Task `f097e38e`.

## Setup

| Component | Version |
| --- | --- |
| `opencode` | 1.18.18 (`/opt/homebrew/bin/opencode`) |
| Ollama daemon | 0.32.13 |
| Model | `gemma4-q8-64k` (gemma4, 11.9B params, Q8_0 quant, 65536 ctx) |
| `@lannguyensi/understanding-gate` | **0.4.10**, installed via `npm install --save-dev` from the real npm registry |

Dogfood project: a throwaway git-initialized dummy repo (`src/Header.tsx`,
one component), not the agent-grounding workspace itself, so the plugin runs
against a real opencode project without any workspace-link shortcuts.

```bash
npm install --save-dev @lannguyensi/understanding-gate@0.4.10
npx --yes @lannguyensi/understanding-gate@0.4.10 init --target opencode --scope project
```

`init` wrote:

- `.opencode/rules/understanding-gate.md` — always-on Fast Confirm house rule
  (opencode has no per-prompt trigger; the rule is static, `/grill` escalates).
- `.opencode/command/grill.md` — the 10-section grill-me report template.
- `.opencode/plugins/understanding-gate-persist-report.ts` — a one-line shim
  re-exporting `persistReportPlugin` from the installed package; opencode
  auto-loads `.opencode/plugins/*.ts`, no `opencode.json` edit needed.

**init-default confirmed: Fast Confirm mode.** Grill-me (the only mode whose
output gets persisted to disk — see Finding 2 below) requires the user to
type `/grill` or the bare marker `grill me`.

### Gotcha found during setup — global npm-link shadows npx

This machine has a **global `npm link`** for local understanding-gate
development: `/opt/homebrew/bin/understanding-gate ->
.../pandora/agent-grounding/packages/understanding-gate` (unpublished dev
version, reports as `0.4.11`). Running `npx @lannguyensi/understanding-gate`
**unpinned** silently resolves to that linked dev binary instead of hitting
the registry — it would have tested the *wrong* (unpublished) code without
any error. Pinning the version (`npx @lannguyensi/understanding-gate@0.4.10`,
and `npm install ...@0.4.10` for the opencode-loaded copy) forces registry
resolution and was used for every command in this dogfood.
`npm view @lannguyensi/understanding-gate version` independently confirms
`0.4.10` is the current npm `latest`.

## Scenario 1 — stamped report in `.understanding-gate/reports/`

**Attempt 1 (plain `/grill add a logout button to src/Header.tsx`): no report.**
The model tried to call the `edit` tool directly instead of writing a report.
Layer 2 enforcement worked exactly as documented — it blocked the write three
times:

```text
{"at":"2026-08-17T06:34:42.873Z","kind":"block","tool":"edit",
 "reason":"understanding-gate: blocked tool \"edit\" because no Understanding
 Report has been emitted for the active session. Emit a report (the
 prompt-hook injects the template), then approve it.",
 "sessionId":"ses_ff193e3f9ffecIOc6I3Xv6TFL2", "adapter":"opencode"}
```

(three such lines total, two more sessions/attempts, all blocked). The model
never produced text matching the report marker, so no persist was attempted
and — correctly — no error log was written either (see Finding 1: silent
`no_report` is by design, not a bug).

**Attempt 2 (retry, more directive prompt) — PASS.** Per the task's "one
retry with a simpler/more directive prompt" allowance:

```text
opencode run "/grill Add a logout button to src/Header.tsx. Do not edit any
files, do not call any tools that write. Your entire reply must start with
the exact heading line '# Understanding Report' on its own line, followed by
the numbered sections from the grill-me instructions." --format json
```

Result: two report files landed under `.understanding-gate/reports/`
(see Finding 3 on the duplicate write). Latest one, in full:

```json
{
  "taskId": "ses_ff18f07a2ffe1qb27ZBq2Z7Bo3",
  "mode": "fast_confirm",
  "riskLevel": "medium",
  "currentUnderstanding": "The user wants to add a logout button to the `src/Header.tsx` component. This likely involves identifying where the header handles authentication (if at all) and placing a button that triggers a logout action (e.g., clearing a token, redirecting to a login page). I need to find the existing `src/Header.tsx` file to see its structure, the current logout logic (or lack thereof), and the styling conventions to ensure the new button fits in.",
  "intendedOutcome": "A functional and visually consistent logout button is added to the navigation header in `src/Header.tsx`.",
  "derivedTodos": [
    "Locate and read `src/Header.tsx`.",
    "Identify the authentication state/context and logout function.",
    "Determine UI placement for the logout button.",
    "(Planned) Add the button and associated logic."
  ],
  "acceptanceCriteria": [
    "A logout button appears in the header.",
    "Clicking the button triggers the correct logout flow (e.g., state update, local storage clear).",
    "The button matches the project's design system/styling."
  ],
  "assumptions": [
    "A logout function or action already exists in the codebase (e.g., in a `useAuth` hook or a global context).",
    "`src/Header.tsx` is the correct place for the logout button.",
    "The project uses React (implied by `.tsx`)."
  ],
  "openQuestions": [
    "Where is the logout logic defined?",
    "Does the project use a specific library for authentication (e.g., NextAuth, Firebase)?",
    "What is the preferred visual style for the logout button (e.g., text link, icon, distinct button)?"
  ],
  "outOfScope": [
    "Modifying other components except `src/Header.tsx`.",
    "Implementing a full authentication system.",
    "Changing the overall theme or layout of the site."
  ],
  "risks": [
    "Placing the button in a location that is hard to reach or violates UX patterns.",
    "Breaking existing header layout or styling.",
    "Missing a dependency or hook required for the logout action."
  ],
  "verificationPlan": [
    "Build the project.",
    "Navigate to the page where the header is visible.",
    "Verify the button is visible and correctly styled.",
    "Click the button and verify the user session is cleared and they are redirected."
  ],
  "priorArt": [
    "Checked the project's `src/` directory for existing auth patterns.",
    "Checked `src/Header.tsx` to see if other buttons/links have established patterns.",
    "No specific logout button was found in the current header.",
    "Build new: I will need to create the button and link it to the existing auth provider's logout method."
  ],
  "requiresHumanApproval": true,
  "approvalStatus": "pending",
  "createdAt": "2026-08-17T06:41:17.664Z",
  "sessionId": "ses_ff18f07a2ffe1qb27ZBq2Z7Bo3"
}
```

`understanding-gate status` confirms it:

```text
understanding-gate status (dir=<dogfood-dir>/.understanding-gate/reports):
  ses_ff18f07a2ffe1qb27ZBq2Z7Bo3: pending @ 2026-08-17T06:41:17.664Z — ./.understanding-gate/reports/2026-08-17T06-41-17-664Z-ses-ff18f07a2ffe1qb27zbq2z7bo3-db301534.json
```

**Verdict: PASS** (on retry). Evidence 1 satisfied: a real npm-published
0.4.10 package, real opencode 1.18.18, real Ollama-served gemma4-q8-64k,
produced a schema-valid, stamped Understanding Report JSON file.

## Scenario 2 — forced failure, `transport_error` in `parse-errors/`

Read the installed package's own source
(`dist/adapters/opencode/persist-report-plugin.js`) before attempting this,
since the task brief assumed the report transport is a configurable network
endpoint. It is not, as of 0.4.10 — see Finding 4.

`transport_error` is written only from one place: the plugin's
`message.updated` handler calls `ctx.client.session.message({...})` (opencode's
own client SDK fetching the just-finished assistant message back from
opencode's own local server, an in-process loopback call) and catches exactly
two failure shapes — a rejected promise or a `{ error, data: undefined }`
resolved envelope. There is no user-facing config for this call; it is
opencode's internal message-fetch, not a report-submission endpoint.

**Attempt A — literal "offline / bad endpoint" reading (break the LLM
provider, per the task's own phrasing).** Project-local `opencode.json`
override pointing the `ollama` provider at an unreachable `baseURL`
(`http://127.0.0.1:1/v1`), same model name, otherwise unchanged:

```text
timestamp=...Z level=ERROR message="stream error" providerID=ollama modelID=gemma4-q8-64k
  error.error="AI_APICallError: Cannot connect to API: Unable to connect. Is
  the computer able to access the url? (cause: Error: Unable to connect...)"
{"type":"error","sessionID":"ses_ff18a6d75ffek3z3PnaBmKqmYH",
 "error":{"name":"APIError","data":{"message":"Cannot connect to API...",
 "metadata":{"url":"http://127.0.0.1:1/v1/chat/completions"}}}}
```

Result: **no new file under `.understanding-gate/` at all** (checked with
`find .understanding-gate -newer opencode.json`, empty). No assistant message
ever reaches `finish: true` with `role: "assistant"`, so the plugin's
`message.updated` handler never runs its fetch — provider-offline is a
different failure class entirely, one level below where this plugin hooks in.
This is a clean negative result, not a hang or a crash.

**Attempt B — natural race (per the package's own CHANGELOG: "opencode
transport failures ... so dogfood can see what went wrong", implying authors
observed this in real use).** Ran one more live session with the normal
(working) config and a heavier, multi-part-response prompt (four UI features
instead of one button), hoping the CLI's process-teardown-after-response
would race the plugin's async fetch. Did not reproduce it: across all three
successful sessions in this dogfood, every report write (or, in this last
one, the absence of the report marker) resolved within tens of milliseconds
of `step_finish`, well before `"exiting loop"` / `"disposing instance"`.

**Attempt not made:** deliberately killing the opencode process at the
narrow moment between "assistant finished" and "plugin fetch completes" to
force the loopback call to fail. Rejected: `opencode run` is a single process
(no separate server child observed in `ps`), so killing it kills the plugin
too — nothing would be left alive to write the log. Reproducing this
black-box, without modifying the vendor plugin, would need either sub-100ms
external timing precision (not reliably achievable from an outside shell
script) or root-level loopback traffic shaping timed to the same window —
both rejected as unsafe/unreliable for a dogfood session, not attempted.

**Verdict: NOT REPRODUCED.** No `.understanding-gate/parse-errors/` directory
was created in this dogfood session. This is a documented finding (Finding 4
below), not a fabricated log — see "Findings" for the follow-up recommendation.

## Findings / follow-up task candidates

Not fixed here (out of scope for a dogfood task); listed for the operator to
triage into agent-grounding follow-ups.

1. **(informational, not a bug)** When the assistant never emits the
   `# Understanding Report` marker, the opencode adapter is silent: no
   `reports/` entry, no `parse-errors/` entry, nothing in `audit.log` beyond
   the Layer-2 `block` events on the write-tool attempts. That's arguably
   correct (matches `{kind: "no_report"}` in `persist-report.js`, a
   no-op by design), but it means a human watching only `.understanding-gate/`
   has zero signal that the agent tried and gave up versus never tried at
   all. Worth a LOW-severity follow-up: log a lightweight breadcrumb (or at
   least a debug line) on `no_report` too, distinguishable from `parse_error`.

2. **(informational)** `UNDERSTANDING_GATE_MODE=grill_me` and the `/grill`
   marker are two independent levers on opencode: the env var only sets the
   *default* `mode` field written into a persisted report, while whether a
   report gets parsed/persisted at all depends purely on the assistant text
   matching `REPORT_MARKER_RE` (`^\s*#+\s*understanding\s+report\b`),
   regardless of mode or marker. A weak local model that ignores the
   `/grill` command's format instructions produces **no signal whatsoever**,
   not a degraded-but-present report. Consider documenting this coupling
   explicitly in the README's opencode section (it currently reads as if
   `/grill` alone is sufficient).

3. **LOW — duplicate report write.** The retry in Scenario 1 produced *two*
   near-identical report files 85ms apart for the same `sessionId` and
   identical content (both `mode: "fast_confirm"`, everything else byte-equal
   except `createdAt`/filename hash). The CHANGELOG documents
   "content-hash-keyed idempotency" as a goal; in this run it did not
   dedupe. Likely the `message.updated` event fired twice for the same
   finished message (a delta update then a final update, both with
   `info.finish === true`). Candidate follow-up: dedupe on
   `(sessionId, messageID)` in the opencode adapter, or verify the
   content-hash idempotency check actually covers this path.

4. **MEDIUM — task/README framing mismatch on the `transport_error` trigger.**
   The task brief (and a plausible README reading) assumes the report
   transport has a configurable "endpoint" that can be pointed offline/bad.
   As of 0.4.10 there is no such thing: `transport_error` is exclusively
   about opencode's *own* in-process client refetching its *own* just-finished
   message, not a report-submission network call. Breaking the actual
   network-configurable thing in this stack — the LLM provider endpoint —
   does not reach this code path at all (Attempt A above). Recommend either
   (a) adding a deterministic, documented way to exercise this path for
   dogfood/CI (e.g., a test-only hook/env-var that makes the injected
   `ctx.client` reject), or (b) tightening the README/CHANGELOG language so
   "transport failure" isn't read as "network-configurable" by a future
   dogfood task.

## Running this yourself

- `opencode` and a running Ollama daemon with the configured model.
- A throwaway git repo with one small `.tsx` file.
- Pin the understanding-gate version everywhere
  (`npx @lannguyensi/understanding-gate@<version> ...`,
  `npm install --save-dev @lannguyensi/understanding-gate@<version>`) if the
  machine has a local dev copy `npm link`-ed globally — see the gotcha above.
- For Scenario 1, expect to need the more directive retry prompt with a
  weak/small local model; a stock `/grill <task>` is not guaranteed to
  produce the marker heading on the first try.
