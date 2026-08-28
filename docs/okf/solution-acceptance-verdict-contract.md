---
type: invariant
title: Solution-acceptance verdict contract — why the marker lives outside the ledger
description: A "done" verdict is derived from a real preflight+OW run, HEAD-pinned, and written to an XDG state marker outside the agent-writable evidence-ledger because ledger rows are forgeable via ledger_add.
tags: [solution-acceptance, verdicts, anti-hacking, trust-boundary]
timestamp: 2026-08-28T11:30:59Z
sources:
  - packages/grounding-mcp/src/solution-verdict.ts
  - packages/grounding-mcp/src/verdict-signing.ts
  - packages/grounding-mcp/src/ow-run-completeness.ts
  - packages/grounding-mcp/src/session-store.ts
  - packages/grounding-mcp/src/server.ts
  - packages/grounding-mcp/tests/interop/harness-verifier.vendored.ts
  - packages/grounding-mcp/tests/interop/verdict-signing-interop.test.ts
  - packages/grounding-mcp/README.md
---

# Solution-acceptance verdict contract

## The invariant

A solution-acceptance verdict is **derived, never claimed**, and it is recorded to a
marker file that lives **outside the repo working tree and outside the agent-writable
evidence-ledger**. The gate passes for an `id` only when a `ready` verdict exists that
was produced at *exactly the current git HEAD*.

Four properties hold, stated verbatim as the anti-hacking contract in the header of
`packages/grounding-mcp/src/solution-verdict.ts:9-24#"wiring follow-up."`:

1. **Derived, not claimed** — `ready` comes from preflight's real run; the caller
   supplies no result.
2. **Producer != solver**: `evaluateSolution` (`solution-verdict.ts:609#"export async function evaluateSolution("`) *runs* preflight; the check
   set is taken from the repo's committed `.preflight.json`, not from arguments, so an
   agent cannot weaken the gate at call time.
3. **HEAD-pinned** — a verdict counts only at the HEAD it was produced at; any rework
   shifts HEAD and invalidates a green verdict (`evaluateGate`, `solution-verdict.ts:255-258#"re-run solution_evaluate"`, compares
   `verdict.head !== currentHead`).
4. **No stale green** — a not-ready run overwrites a prior green marker (`writeVerdict`,
   `solution-verdict.ts:189#"fs.writeFileSync"`, unconditionally overwrites via `fs.writeFileSync`).

The reason the marker sits outside the ledger is stated exactly at `solution-verdict.ts:19-21#"Documented residual:"`:

> The verdict marker lives OUTSIDE the agent-writable evidence-ledger on purpose: a
> ledger row is forgeable via `ledger_add` (the lesson behind understanding-gate moving
> its signal to a marker file).

So the verdict is a signal the solving agent's normal write path does not produce. This
is a trust-boundary decision: anything the agent can write as part of its solution diff
(ledger rows, working-tree files) cannot be the source of truth for "done".

## Where it's enforced

### Marker location: `verdictDir()` (`solution-verdict.ts:116-122#"'agent-grounding', 'solution-verdicts'"`)

Resolution order, exactly:

1. `process.env.SOLUTION_VERDICT_DIR` (explicit override, used by tests) — returned as-is
   when non-empty.
2. else `$XDG_STATE_HOME` when set/non-empty, else `path.join(os.homedir(), '.local', 'state')`.
3. that base is joined with the fixed suffix:

   ```js
   return path.join(base, 'agent-grounding', 'solution-verdicts');
   ```

`verdictPath(id)` (`solution-verdict.ts:140-141#"sanitizeVerdictId(id)}.json"`) is `path.join(verdictDir(), \`${sanitizeVerdictId(id)}.json\`)`.
One JSON file per `id`, deliberately outside the repo and outside the ledger.

### Path-traversal guard: `sanitizeVerdictId` (`solution-verdict.ts:131-137#"return base;"`)

```js
const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
const base = path.basename(cleaned);
if (base === '' || base === '.' || base === '..') throw ...
return base;
```

Non-portable chars collapse to `_`, then `path.basename` strips any residual separator so
`id` can never escape `verdictDir()`. Empty / dot-only ids are rejected. Its sibling
`sanitizeSessionId` in `session-store.ts:33-39#"return base;"` is byte-identical in logic (same regex,
same `basename`, same reject set) and explicitly documents that it mirrors
`sanitizeVerdictId` because the read verbs accept a client-controlled `sessionId` that
must be sanitised before reaching the filesystem.

### The verdict shape (7 pinned keys + 2 additive signing fields)

`Verdict` (`solution-verdict.ts:53-79#"signature?: string;"`): the 7 pinned keys `{ id, head, ready, confidence, blockers,
timestamp, source }` (`solution-verdict.ts:53-67#"source: string;"`), plus, since 0.8.0, two additive OPTIONAL fields
`alg?` (`solution-verdict.ts:77#"alg?: string;"`) and `signature?` (`solution-verdict.ts:79#"signature?: string;"`). `head` is a 40-hex sha; `ready` is derived;
`source` is `'preflight'`. The 7-key shape is pinned by the harness consumer; see the
`writeVerdict` docblock at `solution-verdict.ts:159-183#"trade than the residual it would close."` ("`alg` + `signature` in addition to the 7
pinned fields", mirroring the consumer). The comments at `solution-verdict.ts:596-598#"OW state flows entirely through the"` and `solution-verdict.ts:666-668#"(Signing, which DOES add"`
scope the OW arms: they fold into `ready`/`blockers` only and do NOT add fields. `alg`/`signature` are the one addition
to that pinning rule, and deliberately additive-only (see "Verdict marker signing"
below): they are optional on the TypeScript type only because a hand-constructed
`Verdict` inside `evaluateSolution` has not been signed yet at construction time;
every marker `writeVerdict` actually puts on disk carries both, unconditionally.

### Verdict marker signing (0.8.0): `verdict-signing.ts`

Since 0.8.0, `writeVerdict` (`solution-verdict.ts:185-190#"return target;"`) no longer writes the 7 pinned
fields alone: it calls `signVerdict(resolveGeneratedDir(), verdict)` (`solution-verdict.ts:187#"signVerdict(resolveGeneratedDir()"`, from the
new `src/verdict-signing.ts`) BEFORE writing, and persists the signed copy. There is no
unsigned fallback: signing is unconditional (D-002, task 9b6c4beb / grounding-mcp
CHANGELOG 0.8.0): an unsigned-when-no-key escape hatch would reproduce exactly the
"producer doesn't sign" universal-deny failure mode this feature exists to close.

- **Same key file, same scheme, no package dependency (D-001).** `verdict-signing.ts`
  independently mirrors the harness CONSUMER's signing/verification implementation
  (`src/runtime/approval-signing.ts`, `src/policy-packs/builtin/solution-acceptance-runtime.ts`
  on harness branch `batch19/sign-verdict-marker`) field-for-field and byte-for-byte,
  the same independent-mirroring convention `verdictDir()`/`sanitizeVerdictId()` above
  already use, with no runtime dependency between the two repos' packages.
- **Key path**: `signingKeyPathFor(generatedDir)` (`verdict-signing.ts:136-137#"path.join(generatedDir, SIGNING_KEY_BASENAME)"`) is
  `<generatedDir>/.approval-signing.key` (`SIGNING_KEY_BASENAME`, `verdict-signing.ts:43#".approval-signing.key"`), and
  `resolveGeneratedDir()` (`verdict-signing.ts:131#"export function resolveGeneratedDir"`) is `<harness-home>/harness.generated`
  (`GENERATED_DIRNAME`, `verdict-signing.ts:46#"= 'harness.generated'"`), so the full path is
  `<harness-home>/harness.generated/.approval-signing.key`.
- **Env projection (primary since 0.8.0, task d0daa18a)**: when
  `$SOLUTION_VERDICT_SIGNING_KEY` is set (an absolute path to the key FILE,
  projected by harness at apply time following its `EVIDENCE_LEDGER_DB`
  pattern; slice H1 of the task-9b6c4beb Option-2 design),
  `resolveSigningKeyPath()` (`SIGNING_KEY_ENV`, end of verdict-signing.ts)
  returns it verbatim and the mirrored resolution below is the FALLBACK for
  non-harness-managed setups. `getOrCreateSigningKey` (`verdict-signing.ts:156-189#"fs.readFileSync(filePath), filePath, created: false"`)
  resolves through it, so `getOrCreate` semantics apply at the projected
  path too.
- **`<harness-home>` resolution**: `resolveHarnessHome()` (`verdict-signing.ts:100-109#"  return newPath;"`),
  mirrors harness `resolveHomeDir`. Precedence, exactly:
  1. `$HARNESS_HOME` env var, if non-empty (also the test-isolation knob).
  2. `~/.harness/` if it already exists on disk (`existsDir`, `verdict-signing.ts:112-116#"return false;"`).
  3. `~/.claude/` (legacy) if it carries harness state, either `harness.yaml` or a
     `harness.generated/` subdir (`legacyHasHarnessState`, `verdict-signing.ts:120-127#"return false;"`).
  4. else `~/.harness/`, the create-on-first-use default (no `--home` CLI-flag tier
     here; grounding-mcp has no such flag to mirror).
- **`getOrCreateSigningKey(generatedDir)` (`verdict-signing.ts:156-189#"fs.readFileSync(filePath), filePath, created: false"`).** Reads an
  existing key file when it is `>= 32` bytes; otherwise generates
  `crypto.randomBytes(32)` and writes it at mode `0600` with the exclusive `wx` flag
  (an `EEXIST` from a concurrent creator is read back rather than clobbered: race
  tolerant, "whoever runs first creates, both sides share the same file"). A key file
  shorter than 32 bytes is treated as corrupt and unconditionally regenerated
  (truncated-key repair).
- **Signed payload**: `canonicalPayload`/`signMarker`/`signVerdict` (`verdict-signing.ts:208-214#"JSON.stringify({ markerId, approvedAt, approvedBy, reportContentHash })"`,
  `verdict-signing.ts:230-245#"alg: SIGNING_ALG,"`, `verdict-signing.ts:284-300#"...verdict, alg: signed.alg, signature: signed.signature"`). `markerId = verdictMarkerId(verdict.id)` =
  `'solution-verdict-' + id` (`VERDICT_MARKER_ID_PREFIX`, `verdict-signing.ts:66#"= 'solution-verdict-'"`); the HMAC-SHA256 hex
  signature is computed over `JSON.stringify({ markerId, approvedAt, approvedBy,
  reportContentHash })` in that FIXED key order, with `approvedAt <- verdict.timestamp`,
  `approvedBy <- verdict.source`, and `reportContentHash` = a sha256 hex digest of
  `JSON.stringify({ head, ready, confidence, blockers })` (also fixed key order), so
  the signature transitively covers `head`/`ready`/`confidence`/`blockers` even though
  they have no dedicated slot in the payload tuple. `alg` is the versioned tag
  `'hmac-sha256-v1'` (`SIGNING_ALG`, `verdict-signing.ts:40#"= 'hmac-sha256-v1'"`). Binding `markerId` (hence `verdict.id`)
  into the signed bytes is what makes a copy-and-relabel of a validly-signed marker
  onto a different id's lookup path fail signature verification.
- **On a harness-less machine, this creates `~/.harness/harness.generated/` and the key
  file as a side effect of the FIRST signed verdict** (D-002, documented, not a bug):
  the producer always signs, so `getOrCreateSigningKey` always runs, and its
  `fs.mkdirSync(path.dirname(filePath), { recursive: true })` creates the directory
  tree of whichever path is in effect (the mirrored `<generatedDir>` in the fallback
  case, `dirname($SOLUTION_VERDICT_SIGNING_KEY)` under the env projection) if
  nothing else on that machine already has.
- **Threat model, unchanged from harness' own posture:** this is pragmatic
  defense-in-depth, not a new authorization boundary: the key is read under the SAME
  UID `grounding-mcp` and a shell-capable forger both run under, so signing does not
  stop a shell-capable agent from reading (or first-creating) the key and computing a
  valid signature itself. What it closes is casual/accidental forgery: a marker cannot
  be hand-typed by a tool unaware of the key file, and any content mutation after
  signing (intentional or a bug) invalidates the signature and is rejected as forged.
  See "What breaks it" below.
- **The "genuinely unsigned, not forged" carve-out is narrower than it may sound (T-002
  finding, corrected from an earlier plan paraphrase).** The harness consumer's
  `evaluateGate` classifies a marker `forged: false` ("treating as unsigned, not
  forged") ONLY when a required signed field reads blank (`verdict.timestamp` or
  `verdict.source` mapping to an empty `approvedAt`/`approvedBy`) AND `alg` and
  `signature` are BOTH absent from the marker. A realistic legacy marker, one written
  by a pre-0.8.0 grounding-mcp, with a perfectly valid `timestamp`/`source` and simply
  no `alg`/`signature` fields at all, does NOT hit that narrow reason; it hits the
  generic "missing signature (legacy pre-signing marker, or forged file)" branch
  instead and is classified `forged: true`. Proven by
  `packages/grounding-mcp/tests/interop/verdict-signing-interop.test.ts`, describe
  block "signature AND alg both removed, timestamp/source still valid => STILL
  forged:true, not the carve-out", which matches harness' own golden-fixture assertion
  for its pre-`c7c3f606` 0.3.2/0.5.0 markers. This is the exact mechanism behind the
  CHANGELOG 0.8.0 release-sequencing warning: releasing the harness consumer before
  every producer is on 0.8.0 denies the completion gate universally, not selectively.
- **Drift guard: the interop suite (`packages/grounding-mcp/tests/interop/`).**
  `harness-verifier.vendored.ts` is a TEST-ONLY, source-stamped (branch + file + line
  citations in its header) transcription of the harness consumer's verification logic,
  deliberately NOT derived from this package's own producer mirror (copying the
  producer to test itself would not catch a drift between the two independently
  mirrored implementations; that drift is exactly the risk D-003 names).
  `verdict-signing-interop.test.ts` (15 tests) runs the REAL `writeVerdict` against a
  tempdir `HARNESS_HOME`, reads the marker back off disk, and feeds it to the vendored
  verifier: a positive round-trip, tamper negatives (`ready`/`head`/`confidence`/
  `blockers`/one signature byte each independently flipped), cross-id replay at both
  the signature-binding layer and the belt-and-braces `verdict.id !== id` layer, `alg`
  negatives, and the carve-out-vs-generic-forged distinction above. Any drift between
  this producer and the harness consumer that would silently break verification is
  meant to surface here first.

### The two MCP tools (server.ts, `PACKAGE_VERSION = '0.8.0'` at `server.ts:49#"PACKAGE_VERSION = '0.8.0'"`)

- **`solution_evaluate`** (registered `server.ts:316#"'solution_evaluate'"`) — the producer. Runs preflight against
  the repo, records a HEAD-pinned verdict for `id`. Args: `id` (min 1), optional
  `repoPath` (defaults to cwd). Calls `evaluateSolution(id, repoPath ?? process.cwd())`.
- **`solution_gate`** (registered `server.ts:332#"'solution_gate'"`) — read-only checker. Resolves current HEAD
  via `getHeadSha`, then `evaluateGate(id, head)`. Deny reasons are precise: no verdict /
  not ready + blockers / HEAD drift / unresolvable HEAD.

`evaluateSolution` fails **closed**: an invalid `id`, an unresolvable git HEAD, a missing
`preflight` binary (ENOENT), or unparseable preflight output all return an `error` and
write NO marker (`solution-verdict.ts:609-661#"preflight invocation failed:"`), so the gate stays denied via "no verdict recorded". The
binary is `SOLUTION_PREFLIGHT_BIN ?? 'preflight'` (`solution-verdict.ts:630#"SOLUTION_PREFLIGHT_BIN ?? 'preflight'"`); preflight exits non-zero
when not-ready but still prints JSON, so a non-zero exit with parseable stdout is a normal
not-ready verdict, not a failure. `writeVerdict`, and therefore signing, is only ever
reached (`solution-verdict.ts:686#"writeVerdict(verdict)"`) on a successfully parsed, non-error result.

### The OW process-completeness arm (cross-repo coupling)

Beyond preflight's technical floor, `solution_evaluate` folds in **orchestrator-workflow
(OW) process-completeness** via `owBlockersFor` (`solution-verdict.ts:339#"export async function owBlockersFor"`), whose blockers are folded into
`ready` and `blockers` only (`solution-verdict.ts:666-675#"...pf.blockers, ...owBlockers"`): `ready = pf.ready && owBlockers.length === 0`
(`solution-verdict.ts:674#"owBlockers.length === 0"`). Each OW blocker is prefixed `orchestrator-workflow: ` (`solution-verdict.ts:353#"orchestrator-workflow: "`).

`ow-run-completeness.ts` is a **pure, side-effect-free reader** (no subprocess, no
mutation — comment `ow-run-completeness.ts:3#"Pure, side-effect-free read"`, spelled out again at `ow-run-completeness.ts:9-11#"here writes, spawns, or mutates."`: "This module only READS...
nothing here writes, spawns, or mutates"). Given a `repoPath`, it reads a *third* repo's
OW run files under `<repoPath>/.ai/runs/`:

- **Active run selection, pointer-first**: the worktree root is found by walking
  up from `repoPath` for the nearest `.git` entry — a directory, a linked
  worktree's `.git` FILE, or even a DANGLING symlink, checked with `fs.lstatSync`
  so a broken symlink still marks the root
  (`findWorktreeRoot`, `ow-run-completeness.ts:580-584#"fs.lstatSync(path.join(dir, '.git'));"`).
  A `.ai/run` pointer file at that root, when present, has its target resolved
  with `fs.realpathSync` before the directory/dated-prefix checks — a
  symlinked pointer target is therefore transparent, its REAL directory is
  what is checked and returned. Only the first non-empty line of the pointer
  file matters; an optional second line (for example `base=<sha>`) is
  ignored outright — the named run directory's own files are the source of
  truth, never the pointer file
  (`resolveRunPointer`, `ow-run-completeness.ts:601-604#"why an invalid pointer is a distinct fail-closed blocker rather than a"`,
  `ow-run-completeness.ts:615-653#"return { kind: 'run', dir: realTarget };"`)
  and WINS OUTRIGHT over the newest-run scan
  (`ow-run-completeness.ts:259-273#"runSource: 'pointer',"`); the scan
  (`findActiveRun`, `ow-run-completeness.ts:738-755#"return path.join(runsDir, dirs[0]);"`:
  newest dated dir, only dirs matching `/^\d{4}-\d{2}-\d{2}-/` are eligible;
  name-descending sort, mtime tiebreak) runs ONLY when no pointer file exists at
  all (`ow-run-completeness.ts:256-281#"runSource = activeRun === null ? null : 'scan';"`).
  A pointer file that exists but does not resolve (unreadable, empty, a relative
  path, or a target missing / not a directory / not date-prefixed) is a DISTINCT
  fail-closed blocker and never falls back to the scan. Which channel actually
  resolved the run is reported on `runSource: 'pointer' | 'scan' | null`
  (`ow-run-completeness.ts:170-180#"runSource: 'pointer' | 'scan' | null;"`).
- **`06-handoff.md`** → `final-status` marker (`resolveAcceptanceValue`, `ow-run-completeness.ts:301#"'final-status', 'Final Status'"`); must
  be in `{accepted, accepted_with_notes}` (`ow-run-completeness.ts:215#"ACCEPTED_FINAL_STATUS"`).
- **`05-review-findings.md`** → `acceptance-recommendation` marker (`ow-run-completeness.ts:318#"const recommendation = resolveAcceptanceValue"`); must be in
  `{accept, accept_with_notes}` (`ow-run-completeness.ts:216#"ACCEPT_RECOMMENDATION"`). Plus the **findings table**: rows are located
  by anchoring on a header row whose cells include both `Severity` and `Decision`
  (`parseFindingsHeaderRow`, `ow-run-completeness.ts:964#"function parseFindingsHeaderRow"`), not by the `## Findings` heading text. A concrete
  `high`/`critical` severity row ARMS the gate UNLESS its Decision is explicitly in
  `{accepted, defer}` (`RESOLVED_DECISIONS`, `ow-run-completeness.ts:221#"RESOLVED_DECISIONS = new Set(['accepted', 'defer'])"`) — fix, reject, blank, `open`,
  `TODO`, unknown all block (fail-closed). All tables are parsed (appended second-round
  tables count); a findings section with content but no table yields an explicit format
  blocker (`findingsFormatBlocker`, `ow-run-completeness.ts:987#"function findingsFormatBlocker"`).
- **Mixed-state bypass guard** (task `8f173547`): completeness above is not enough —
  an operator could flip the acceptance markers to an accepted value without ever
  transferring the reviewer's findings into the table. `scanFindings` (`ow-run-completeness.ts:885-942#"  return scan;"`)
  additionally tracks whether the shipped review template's placeholder/legend row
  survived untouched (`placeholderRowSeen`, matched byte-exactly cell-by-cell by
  `isPlaceholderRow`, `ow-run-completeness.ts:950-953#"PLACEHOLDER_ROW_CELLS[idx]"`, against `OW_FINDINGS_PLACEHOLDER_ROW`,
  `ow-run-completeness.ts:235-236#"correctness/architecture/security/tests/maintainability/performance/docs"`) and whether any row anywhere carries a real concrete severity
  (`concreteRowSeen`). When the placeholder row survived AND no concrete row was ever
  seen, `readOwRunCompleteness` blocks with `complete: false` (`ow-run-completeness.ts:347-352#"genuinely a zero-findings review"`), naming
  both escape hatches: transfer the reviewer's findings into the table, or delete the
  placeholder row for a genuine zero-findings review. A header row with no data rows at
  all (the placeholder already deleted) still reads `complete: true`, and a concrete
  finding row sitting next to a left-behind placeholder row is unaffected.
- **`00-goal.md`** → the `run-base` marker, keyed per repo, is a GRAMMAR rather than
  one regex per accepted shape. `collectKeyedRunBaseMarkers` walks
  `goal.split(/\r?\n/)` and treats a keyed marker as a WHOLE-LINE HTML comment
  (leading/trailing whitespace only): a strict-shape line
  `<!-- solution-acceptance: run-base[<key>] = <value> -->` is well-formed.
  The strict shape is EXACT — lowercase `solution-acceptance:` and
  `run-base`, no whitespace before the colon, exactly two dashes in the
  comment opener — the same exactness the legacy unkeyed matcher already
  demands. The separate LOOSE net that decides whether a line was an ATTEMPT
  at a keyed marker is deliberately more tolerant: case-insensitive
  (`RUN-BASE[`), whitespace allowed around the colon
  (`solution-acceptance : run-base[`) and before the bracket
  (`run-base [alpha]`), one or more dashes in the comment opener (`<!--- `).
  A line the loose net catches but the strict shape rejects is collected as
  MALFORMED instead of silently degrading
  (`ow-run-completeness.ts:446-466#"return { markers, malformedLines };"`;
  grammar constants at
  `ow-run-completeness.ts:416-434#"const PLACEHOLDER_KEY = /^<[^>]*>$/;"`). A
  strict match whose key is placeholder-shaped (`<repo-basename>`-style,
  `/^<[^>]*>$/`) is a documentation example, not a marker, and is skipped
  entirely — not counted as present, not malformed; an example that itself
  deviates from the strict shape (case, colon spacing, comment opener) is an
  attempt like any other and blocks as malformed. Both nets are anchored at
  the LINE START and require the literal tokens `solution-acceptance`, a
  colon and `run-base[`; that anchoring and exactness are the documented
  residual: a keyed marker that does not start its own line (a list bullet
  `- <!-- ... -->`, a marker embedded in prose, a bare `run-base[alpha] = <sha>`
  with no comment wrapper), or a whole-line comment that deviates in those
  tokens (the colon omitted, `run_base`, `runbase`, a full-width colon), is
  NOT a marker — neither well-formed nor malformed. With no other
  applicable marker in the file the run then behaves as MARKERLESS and falls
  through to the legacy date heuristic (fail-open by design, the kit's
  documented markerless path; a fully fail-closed variant is tracked as its
  own task). All well-formed keyed markers are collected in
  one scan and matched CASE-INSENSITIVELY against each candidate key from
  `repoKeys`, tried in order — the worktree's own basename, then (for a LINKED
  git worktree) the main repository's basename, resolved via the worktree's
  `.git` `gitdir:` file and `commondir`
  (`repoKeys`/`resolveMainWorktreeRoot`,
  `ow-run-completeness.ts:663-670#"return keys;"`,
  `ow-run-completeness.ts:687-724#"if (worktreesMatch) return worktreesMatch[1];"`)
  — and the FIRST key whose WELL-FORMED keyed marker is present decides (its
  value, or `null` for `TODO`) without falling through to a later key or to
  the legacy unkeyed `run-base` marker
  (`ow-run-completeness.ts:519-561#"exists; add a run-base[<key>] marker for this repo or an unkeyed run-base marker"`).
  Only when no well-formed keyed marker matches any key does the unkeyed
  marker apply. Whenever malformed near-miss lines were found, their blocker
  reason is reported REGARDLESS of whether a keyed match or the unkeyed
  marker also resolved a value (the value is still returned, but the run is
  not complete either way); when NOTHING resolved a value AND malformed
  lines exist, that takes priority over "no key matches"
  (`runBaseKind: 'malformed'` beats `'unmatched-keyed'`) — never a silent
  fallback to the date heuristic. Both blocker messages are bounded (keys
  truncated to 64 chars / 10 shown, malformed lines truncated to 80 chars / 5
  shown, `(+N more)` beyond that) so a goal file with many or very long keys
  cannot blow up the reason string
  (`ow-run-completeness.ts:484-489#"(expected '<!-- solution-acceptance: run-base[<key>] = <sha> -->' on its own line)"`).
  `owBindingBlockers` in the verdict layer skips the legacy date heuristic
  outright for BOTH `'unmatched-keyed'` and `'malformed'`, so exactly one
  blocker is reported, never two
  (`solution-verdict.ts:411-424#"if (ow.runBaseKind === 'unmatched-keyed' || ow.runBaseKind === 'malformed') return [];"`).
  Raw `\S+` capture for the value. `runBaseKind` (`'sha' | 'todo' | 'absent' |
  'unmatched-keyed' | 'malformed'`) names WHY `runBase` has the value it has,
  so the verdict layer can branch without re-deriving this key logic
  (`ow-run-completeness.ts:181-206#"runBaseKind: 'sha' | 'todo' | 'absent' | 'unmatched-keyed' | 'malformed';"`).
  This module only *extracts* the value; git verification happens in the
  verdict layer. Documented asymmetry: the legacy UNKEYED `run-base` matcher
  (`matchMarker`) stays NOT line-anchored (a substring match anywhere in the
  file) — only the keyed grammar was hardened.

**Marker-first, prose fallback** throughout (`resolveAcceptanceValue`, `ow-run-completeness.ts:778-796#"kind: 'value', value: prose"`): the
machine-readable `<!-- solution-acceptance: <field> = <value> -->` marker wins; only when
the field is entirely absent does it fall back to the `## <heading>` prose value. A `TODO`
or malformed marker surfaces its own blocker and never silently falls back (fail-closed).

**Change binding** (`owBindingBlockers`, `solution-verdict.ts:411-468#"no OW run claims this change"`): completeness alone
would let one old accepted run keep the gate green for every later change, so the active
run must also *claim the current change*. New-kit runs carry a `run-base` sha in
`00-goal.md` — possibly a keyed one, and the run itself may have been resolved via the
pointer or the scan; either way `ow.runBase`/`ow.runName` are already resolved by the time
this check sees them (`solution-verdict.ts:365-374#"run claims the current change iff the recorded base"`).
It must (1) resolve to a commit here, (2) be an ancestor of HEAD, and (3)
not lie strictly behind the fork point (merge-base of HEAD with the remote default branch).
`RUN_BASE_SHA = /^[0-9a-f]{7,40}$/i` (`solution-verdict.ts:360#"RUN_BASE_SHA = /^[0-9a-f]{7,40}$/i"`) validates the agent-writable value BEFORE
any git call (argv-injection guard). Legacy markerless runs downgrade to a day-granular
date heuristic (`solution-verdict.ts:463-468#"no OW run claims this change"`). The knob `<repoPath>/.ai/solution-acceptance.json`
`{ "orchestratorWorkflow": "auto"|"on"|"off" }` resolves **fail-SAFE** to `auto` on any
missing/unparseable/invalid config (`resolveOwKnob`, `solution-verdict.ts:301-306#"v === 'auto' || v === 'on' || v === 'off'"`); a malformed file can
never silently disable the gate. When enforced but no run was found at all (pointer absent
AND no `.ai/runs/` dir), the `on` knob names both channels in its blocker
(`solution-verdict.ts:349#"no OW run was found (no .ai/run pointer and no .ai/runs/ run directory)"`).

## What breaks it

- **Hand-writing the marker, still not a closed hole under shared UID.** As of 0.8.0
  every marker is signed (see "Verdict marker signing" above), so a naive hand-typed
  JSON file (no `alg`/`signature`, or a wrong signature) is rejected by the harness
  consumer as forged. But this is explicitly pragmatic defense-in-depth, not a new
  authorization boundary: a shell-capable agent runs under the SAME UID that reads and
  first-creates `<harness-home>/harness.generated/.approval-signing.key`, so it could
  read that key and compute a valid signature too, same as the harness consumer's own
  documented threat model. The residual comment at `solution-verdict.ts:19-24#"wiring follow-up."` (unchanged
  since before 0.8.0) still names "signing... is the harness wiring follow-up" as the
  next step for this specific residual; that step is what this task's producer-side
  half delivers, paired with the harness CONSUMER wiring (task `c7c3f606`, merge-held
  pending the release sequencing in the grounding-mcp 0.8.0 CHANGELOG entry). The
  ledger-forge hole was closed earlier (marker moved outside the ledger); the
  shell-forge hole is now *harder* (a forger needs the shared key, not just a text
  editor), but still open under a same-UID threat model, by design.
- **Self-serving the OW knob.** The knob is read from the agent-writable working tree, so
  an agent can write `{"orchestratorWorkflow":"off"}` to disable the OW *process* arm.
  Bounded and NOT closed (`solution-verdict.ts:26-32#"non-agent-writable source."`): it disables only the process arm; the preflight
  technical floor (lint/typecheck/test/audit/secrets) still gates regardless.
- **Committing after a green evaluate, then not re-running.** HEAD moves; `evaluateGate`
  returns `stale verdict ... (re-run solution_evaluate)`. Re-running is required after any
  change. preflight's own clean-worktree check also fails a dirty tree, so a fresh
  evaluate on uncommitted work is not-ready.
- **Evaluating at an already-pushed default-branch tip.** Pre-merge by design: the binding
  arm false-blocks (fork == HEAD), which is deliberate and pinned by a test (`solution-verdict.ts:403-409#"matches the ship-flow, which evaluates before pushing."`).
  The remedy in the blocker text — start a new run — matches the ship-flow, which evaluates
  before pushing.
- **Marker-shadowing in run files.** First marker match wins; a quoted mention of marker
  syntax earlier in a run file can shadow the real marker — a known non-goal, run files are
  agent-authored honor-system (`ow-run-completeness.ts:24-26#"agent-authored, honor-system"`).

## Out-of-repo boundary note (harness consumer)

A consumer (the harness ship-flow) reads the marker to gate an action such as `pr_merge`.
This doc does not assert harness internals; the contract this repo guarantees is only the
marker's location (`verdictDir()`), its pinned 7-key shape plus (since 0.8.0) the two
additive signing fields `alg`/`signature` and the exact HMAC scheme + key-file contract
those are computed against ("Verdict marker signing" above), and the `solution_gate`
allow/deny semantics. How the harness wires those into a gate, including its
`forged`-classification carve-out logic, lives out of this repo; this doc's account of
that carve-out is a read of the harness source at a stamped commit (see the interop
suite's vendored-verifier header), measured via the interop suite, not assumed.

## Where the `run-base` marker comes from

The `run-base` marker this module verifies is **not emitted by this repo**. It is
written into `00-goal.md` by the orchestrator-workflow kit (agent-dx); this repo
ships no `00-goal.md` template and only *reads and verifies* the marker
(`grounding-mcp/README.md`). Runs that predate the kit change carry no marker and
fall back to the day-granular date heuristic. Treat marker emission as a
cross-repo contract owned by agent-dx, and the verification semantics above as
owned here.
