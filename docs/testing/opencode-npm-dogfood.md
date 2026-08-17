# understanding-gate: opencode + npm-published-package dogfood

Post-publish dogfood: run a real `opencode` session against the **npm-published**
`@lannguyensi/understanding-gate` package (not the workspace-linked dev copy) and
verify two things end to end:

1. A stamped Understanding Report JSON lands in `.understanding-gate/reports/`.
2. A forced-failure scenario produces a `transport_error` breadcrumb under
   `.understanding-gate/parse-errors/`.

Recorded 2026-08-17 under agent-tasks task
[`f097e38e`](https://agent-tasks.opentriologue.ai/tasks/f097e38e-a250-4154-8a97-c5c90898e94e).

---

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

**init-default confirmed: Fast Confirm mode.** Grill-me's prompt template is
the only one that instructs the model to open its reply with the
`# Understanding Report` marker heading. Persistence is gated on that marker
text matching, not on the `mode` field (see Finding 2 below). Reaching
grill-me's template requires the user to type `/grill` or the bare marker
`grill me`.

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

---

## Scenario 1 — stamped report in `.understanding-gate/reports/`

**Attempt 1 (plain `/grill add a logout button to src/Header.tsx`): no report.**
The model tried to call the `edit` tool directly instead of writing a report.
Layer 2 enforcement worked exactly as documented — it blocked the write three
times. The first blocked attempt, shown as the single verbatim `audit.log`
line (not reflowed, `taskId` included):

```text
{"at":"2026-08-17T06:34:42.873Z","kind":"block","tool":"edit","reason":"understanding-gate: blocked tool \"edit\" because no Understanding Report has been emitted for the active session. Emit a report (the prompt-hook injects the template), then approve it.","sessionId":"ses_ff193e3f9ffecIOc6I3Xv6TFL2","taskId":"ses_ff193e3f9ffecIOc6I3Xv6TFL2","adapter":"opencode"}
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

---

## Scenario 2 — forced failure, `transport_error` in `parse-errors/`

Read the installed package's own source
(`dist/adapters/opencode/persist-report-plugin.js`) before attempting this,
since the task brief assumed the report transport is a configurable network
endpoint. It is not, as of 0.4.10 — see Finding 4.

`transport_error` is written only from one place: the plugin's
`message.updated` handler calls `ctx.client.session.message({...})` (opencode's
own client SDK fetching the just-finished assistant message back from
opencode's own local server, an in-process loopback call) and catches exactly
two failure shapes — a rejected promise, or any resolution that carries an
error or lacks data (`result?.error || !result?.data` in the plugin source).
There is no user-facing config for this call; it is opencode's internal
message-fetch, not a report-submission endpoint.

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
This is a clean negative result, not a hang or a crash, and it remains a
correct, distinct finding: breaking the one thing in this stack that *is*
network-configurable (the LLM provider endpoint) does not reach the
`transport_error` code path.

**Attempt B — natural race (per the package's own CHANGELOG: "opencode
transport failures ... so dogfood can see what went wrong", implying authors
observed this in real use).** Ran one more live session with the normal
(working) config and a heavier, multi-part-response prompt (four UI features
instead of one button), hoping the CLI's process-teardown-after-response
would race the plugin's async fetch. Did not reproduce it: across all three
successful sessions in this dogfood, every report write (or, in this last
one, the absence of the report marker) resolved within tens of milliseconds
of `step_finish`, well before `"exiting loop"` / `"disposing instance"`.
Concretely, for this run's final message:

```text
step_finish  reason=stop  messageID=msg_00e782cc4001hFaQpa1bE6l7fA  at 2026-08-17T06:46:42.697Z
"exiting loop"                                                       at 2026-08-17T06:46:42.782Z
```

`step_finish` landed at `06:46:42.697Z`; `"exiting loop"` followed 85ms
later, at `06:46:42.782Z`. The plugin's `message.updated` handler had that
entire window to run, and (per the empty `parse-errors/` and unchanged
`reports/` after this run) it ran and found no report marker to persist,
cleanly, well before teardown.

**Attempt C — inject a failing client via the user-owned plugin shim (what
actually reproduces it).** The black-box idea considered below Attempt B
(killing the opencode process at the narrow moment between "assistant
finished" and "plugin fetch completes") only rules out an *external,
no-file-changes* timing attack; it does not mean the code path is
unreachable. `init --target opencode` already writes a real, user-owned
TypeScript file at `.opencode/plugins/understanding-gate-persist-report.ts`
(not vendor code under `node_modules/`) that opencode loads directly and
passes its own `ctx` (including `ctx.client`) into. Wrapping that `ctx` to
swap in a `client.session.message` that always throws is a supported way to
force the exact failure branch the plugin's own unit tests exercise (see
Finding 4), through a real, live opencode session rather than a unit test.

Replaced the generated shim with:

```ts
import { persistReportPlugin } from "@lannguyensi/understanding-gate";
export default async (ctx: any) =>
  persistReportPlugin({
    ...ctx,
    client: {
      ...ctx.client,
      session: {
        ...ctx.client.session,
        message: async () => {
          throw new Error("forced transport failure");
        },
      },
    },
  });
```

Ran a plain prompt that completes an assistant turn (any prompt that
finishes a turn works; nothing report-related needed):

```bash
opencode run "What does src/Header.tsx export? Answer in one sentence, no tool calls needed if you already know." --format json
```

Model was already warm from the earlier scenarios; the whole run (command
launch to the last event) took about 55s, well inside the 600s timeout.
Result: four `transport_error` breadcrumbs landed under
`.understanding-gate/parse-errors/`, two per finished assistant message
(`message.updated` firing twice per message, ~86ms apart; see Finding 3 for
the same double-fire on the report-write path):

```text
$ ls -1 .understanding-gate/parse-errors/
2026-08-17T07-05-33-399Z-e996f7.log
2026-08-17T07-05-33-485Z-b738c8.log
2026-08-17T07-05-36-716Z-86b1d8.log
2026-08-17T07-05-36-803Z-90b084.log
```

First breadcrumb, in full:

```json
{
  "kind": "transport_error",
  "sessionID": "ses_ff17684afffeZVonlpwxJA0Meh",
  "messageID": "msg_00e897c03001cXSxLQjQ1p0N0C",
  "at": "2026-08-17T07:05:33.399Z",
  "error": {
    "name": "Error",
    "message": "forced transport failure",
    "stack": "Error: forced transport failure\n    at message (/.../.opencode/plugins/understanding-gate-persist-report.ts:10:21)\n    at <anonymous> (/.../node_modules/@lannguyensi/understanding-gate/dist/adapters/opencode/persist-report-plugin.js:59:57)\n    ..."
  }
}
```

The other three breadcrumbs are identical in shape (`kind: "transport_error"`,
the forced error message, the same stack origin), keyed to the run's two
`messageID`s. No file landed under `.understanding-gate/reports/` for this
run, as expected. The forced failure short-circuits the write.

**Verdict: PASS** (forced failure by ctx injection, Attempt C). A real
npm-published 0.4.10 package, real opencode 1.18.18, real Ollama-served
gemma4-q8-64k, running with a `client.session.message` forced to throw,
produced schema-matching `transport_error` breadcrumbs under
`.understanding-gate/parse-errors/` end to end through a live opencode
session. Attempt A stands as a separate, correct finding: pointing the LLM
provider offline does not reach this code path at all (see Findings, item 4).

---

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
   near-identical report files for the same `sessionId` and identical
   content (both `mode: "fast_confirm"`, everything else byte-equal except
   `createdAt`/filename hash):

   ```text
   $ ls -1 .understanding-gate/reports/
   2026-08-17T06-41-17-579Z-ses-ff18f07a2ffe1qb27zbq2z7bo3-ddc1ffe9.json
   2026-08-17T06-41-17-664Z-ses-ff18f07a2ffe1qb27zbq2z7bo3-db301534.json
   ```

   `createdAt` in the two files: `2026-08-17T06:41:17.559Z` and
   `2026-08-17T06:41:17.664Z`, 105ms apart. The CHANGELOG documents
   "content-hash-keyed idempotency" as a goal; in this run it did not
   dedupe. Likely the `message.updated` event fired twice for the same
   finished message (a delta update then a final update, both with
   `info.finish === true`). The four `transport_error` breadcrumbs in
   Scenario 2/Attempt C show the identical double-fire pattern on the
   error path (two breadcrumbs per `messageID`, ~86ms apart), independent
   corroboration from the same dogfood run. Root cause: `createdAt` is one
   of the fields that goes into the content hash, so a hash (or
   filename-only) idempotency check structurally cannot dedupe a re-fire
   that differs only by timestamp: the two writes hash to two different
   values by construction. Fix decision needed: drop `createdAt` from the
   hash input, or dedupe on `(sessionId, messageID)` instead of content
   hash.

4. **LOW — doc wording only; the deterministic test hook already exists.**
   `packages/understanding-gate/tests/opencode-plugin-integration.test.ts:208`
   ("logs a transport_error and does not throw when client.session.message
   rejects") and `:256` ("logs a transport_error when client.session.message
   resolves with { error } and no data") already inject a rejecting or
   error-returning `client.session.message` and assert the `transport_error`
   breadcrumb, at the unit level. This doc's earlier draft claimed no
   deterministic way existed to exercise this path outside a unit test and
   verdicted Scenario 2 "NOT REPRODUCED" on that basis. That claim was
   wrong: Scenario 2/Attempt C now demonstrates the identical technique
   (inject a throwing `client.session.message`) end to end through a live
   opencode session, via the init-generated, user-owned plugin shim.
   Narrowed follow-up candidates: (a) reference the Attempt C recipe from
   the package README's opencode section or from the test file's own
   comment, so a future dogfood doesn't have to rediscover it; (b) tighten
   the CHANGELOG's "opencode transport failures" wording so "transport
   failure" isn't read as "network-configurable" (Attempt A already shows
   empirically that it isn't).

5. **LOW — stale header comment in the vendor plugin source.**
   `packages/understanding-gate/src/adapters/opencode/persist-report-plugin.ts`
   lines 9-11 still say the shim lands at
   `.opencode/plugin/understanding-gate-persist-report.ts` (singular
   `plugin/`) and that "the user adds an entry to `opencode.json` pointing
   at that file." Both are stale as of this dogfood (0.4.10, opencode
   1.18.18): `init` writes to the plural `.opencode/plugins/` directory and
   opencode auto-loads every file there, no `opencode.json` edit needed
   (confirmed in Setup above). One-line follow-up: fix the two words in the
   comment.

---

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
- For Scenario 2, don't try to break the LLM provider or race process
  teardown. Use Attempt C instead: edit the init-generated
  `.opencode/plugins/understanding-gate-persist-report.ts` to wrap `ctx`
  with a `client.session.message` that throws (or resolves with
  `{ error, data: undefined }`), then run any prompt that completes an
  assistant turn. Revert the shim to the plain re-export afterwards if you
  want the project to persist real reports again.
