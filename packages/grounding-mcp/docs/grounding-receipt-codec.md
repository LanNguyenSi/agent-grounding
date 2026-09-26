# Grounding receipt codec

The wire format grounding-mcp uses to encode and decode grounding receipts.

The package also contains an unregistered `grounding-receipt/v1` library
primitive and a versioned conformance corpus. It serializes a strict,
Ed25519-signed documentary assessment and accepts only explicit key objects;
it does not load keys, inspect sessions, or grant any task or claim action.
Its assessment provenance is always `agent_asserted`. See the [receipt contract
document](../../../docs/okf/grounding-receipt-contract.md) for the signature,
policy-digest, and consumer-boundary details.

The [vendored repository contract](../contracts/grounding-receipt-v1/README.md)
defines every field and nested schema, canonical payload order, exact Ed25519
signature input, inclusive 32 KiB wire / 16 KiB payload limits, and stable
`invalid`, `unsupported`, `untrusted` errors. Its manifest pins immutable pass,
fail, negative and boundary bytes plus declarative policy vectors. The public
`00..1f` test seed is deliberately unsafe. The corpus and codec add no npm
exports or runtime endpoint. Verifying a correctly signed fail receipt succeeds;
context binding, clocks, issuer admission and task decisions require a separate
consumer.

## Authoritative assessment store

`grounding-assessment-store.ts` implements the separate producer evaluator as
a library wired by the restricted entrypoint below. Construction requires an absolute producer directory,
explicit issuer and key identifiers, an Ed25519 private `KeyObject`, and bounded
producer metadata. It does not discover keys, import legacy sessions, or read
the solver's default ledger or session home. The static policy module uses
frozen rules coupled to the codec's policy identity; it does not read contract
files or live wrapper/claim-gate rules at runtime.

`createSession({challenge, keyword, problem})` validates the challenge before
the first step and permanently binds the session to its audience, project,
task, and subject. Changes to that binding need a new session. Challenges also
carry attempt ID, nonce, context revision, workflow target, pinned policy, and
safe epoch-second creation/expiry times. Their lifetime is at most 24 hours;
fresh operations allow at most 60 seconds of creation-time clock skew and no
expiry grace. The consumer must authenticate those fields against its own
attempt record. Another attempt for an unchanged subject may use the session
with a different workflow edge.

`getSession({sessionId})` returns a detached snapshot including dossier entries,
claim, completion events, and derived current phase. `advance` requires
`sessionId`, `expectedRevision`, and `expectedPhase`; `addDossierEntry` requires
the first two plus `kind`, `content`, and `source`; `setClaim` requires the first
two plus `text`. Unknown fields, caller phase arrays, skipped flags, origins,
claim types, and supplied assessment decisions are rejected. A real mutation
increments the revision once. Advancing `complete` and setting the identical
claim are revision-preserving no-ops after CAS succeeds. Only the producer's
empty runtime phase can be skipped. Completion events are documentary agent
confirmations made through this API, not observed tool execution.

Entries can be `fact`, `hypothesis`, `rejected`, or `unknown`, always with
`agent_asserted` provenance. Source is inert text. At least one nonblank fact
and a nonblank claim are necessary, alongside mandatory completion events and
the prerequisites selected from the claim's text. Rejected alternatives supply
the alternatives prerequisite. Even invented but structurally valid statements
can satisfy this documentary policy. The digest's fixed projection includes
session identity/revision, binding, keyword/problem, events, concrete entries
and provenance, claim, and computed claim evaluation.

`exportReceipt({sessionId, expectedRevision, challenge})` evaluates the owned
snapshot and signs either a pass or a regular policy failure. It does not
advance the session. It stores the assessed snapshot and exact wire bytes in
one terminal attempt record. Exact retries return those bytes even after later
session mutations, receipt expiry, or restart, without consulting the clock.
A changed session, revision, or challenge field on that attempt conflicts;
unsupported policy or malformed input is rejected before lookup. A fresh
attempt evaluates the current matching revision. Receipt expiry never exceeds
challenge expiry or 900 seconds from evaluation. Validation, signing, locking,
and storage failures return errors, not another attempt's receipt.

All reads and mutations use a global cross-process `proper-lockfile` lock and
one versioned JSON state file. Writes use an exclusive same-directory temporary
file, file fsync, atomic rename, and directory fsync. A failure after rename
can mean the commit occurred: retry the exact export to recover its stored
bytes; for ordinary mutations, read the current revision before deciding what
to do next. Malformed or unknown-version state is never reset automatically.
Lock ownership loss and cleanup failures are errors.

The lock has no time-based takeover. A suspended writer retains exclusion;
an unclean exit leaves the store busy. Recovery requires the operator to stop
and confirm every potential writer is dead before removing the producer
directory's `store.lock` directory. There is no force-unlock API. Restart after
this quiescent recovery retains committed terminals and removes abandoned
temporary state files. These guarantees require a local filesystem with the
documented atomic rename/fsync and locking behavior; host power-loss and OS
isolation qualification remain deployment responsibilities. File modes are
defense in depth, not isolation from another process running as the same user.

Bounds are 64 raw UTF-16 units for keyword, 8,192 each for problem, entry content
and claim, and 1,024 for source; text rejects unpaired surrogates. A store holds
at most 128 sessions, 256 entries per session, 256 terminal attempts, and 8 MiB
of encoded state. Capacity and safe-integer revision exhaustion fail explicitly;
there is no automatic terminal pruning or lifecycle migration. The library itself adds no transport registration, key loader, consumer
enforcement, or deployment approval. The separate entrypoint below supplies
explicit local configuration and MCP registration.

## Restricted assessment MCP

`grounding-assessment-mcp` is a separate stdio binary for the producer store.
It loads `GROUNDING_ASSESSMENT_CONFIG`, which must select an absolute JSON file.
For example, an operator-provisioned configuration has this exact shape:

```json
{
  "issuer": "assessment.example",
  "kid": "signing-key-1",
  "privateKeyPath": "/srv/assessment/issuer.pem",
  "stateDirectory": "/srv/assessment/state",
  "policy": {
    "id": "debug-evidence-assessment/v1",
    "revision": "1",
    "sha256": "50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4"
  }
}
```

The private key must be an existing Ed25519 private PEM key. Issuer and key
identifiers are 1–128 ASCII letters, digits, dots, underscores, colons, or
hyphens. Key and state paths must be absolute. Configuration and key reads
are each capped at 64 KiB and reject invalid UTF-8. Unknown fields (including
nested policy fields), wrong policy identity, invalid keys, missing files,
and relative paths fail before service registration. Startup failures exit
nonzero with a fixed error on stderr and no MCP output or default state.
There is no key generation, home-directory fallback, network discovery, or
automatic consumer trust registration.

```bash
GROUNDING_ASSESSMENT_CONFIG=/srv/assessment/config.json grounding-assessment-mcp
```

The configuration is trusted startup input. Tool callers cannot supply issuer,
key, filesystem, execution, or policy-authority overrides. The normal
`grounding-mcp` binary retains its existing session/ledger/verdict contract;
configure the restricted binary separately, with its explicit issuer input.
`--version` (also `-v`) prints the package version without loading that input.

The complete tool surface is:

| Tool | Required arguments |
| --- | --- |
| `assessment_start` | `challenge`, `keyword`, `problem` |
| `assessment_status` | `sessionId` |
| `assessment_advance` | `sessionId`, `expectedRevision`, `expectedPhase` |
| `assessment_dossier_add` | `sessionId`, `expectedRevision`, `kind`, `content`, `source` |
| `assessment_dossier_read` | `sessionId` |
| `assessment_claim_set` | `sessionId`, `expectedRevision`, `text` |
| `assessment_export` | `sessionId`, `expectedRevision`, `challenge` |

`challenge` is the strict object described by the store and
[receipt contract](../contracts/grounding-receipt-v1/README.md): audience, project
and task UUIDs, attempt UUID, nonce, context revision, target, subject, pinned
policy, and epoch-second creation/expiry times. The server rejects unknown
fields before dispatch, including nested challenge/target/subject/policy
fields. Status returns session ID, revision, and current phase. Dossier read
returns the fixed documentary projection and computed claim evaluation.
Advance confirms only the current phase; the producer derives its tools and
provenance. Facts, claim text, and path- or command-shaped source text stay
`agent_asserted` documentary data; they trigger no file reads or execution.

Every operation uses the assessment store. Export returns one MCP text content
item containing the exact UTF-8 receipt wire string; clients preserve that
string's UTF-8 bytes without JSON-wrapping or reserializing the envelope.
An identical retry preserves bytes even after restart. Changed attempt inputs
conflict. Policy failures produce signed `fail` receipts; invalid input or a
storage/evaluation failure returns an MCP error, never an earlier receipt.
The store limits and quiescent recovery procedure above apply unchanged.

This producer interface does not approve production activation. Consumer issuer
admission, context checks, freshness, active-attempt supersession, and task
transitions require separate consumer enforcement. Deployment must separately
qualify key access, filesystem semantics, process/OS isolation, and rollout;
a signature or a temporary-key transport test does not establish those facts.
