---
type: overview
title: runtime-reality-checker as a policy — who owns the env toggles
description: Pointer doc — docs/policy-runtime-reality.md is the authoritative spec; this entry adds the ownership fact agents get backwards, namely that this package interprets its own escalation env vars while harness only sets them.
tags: [runtime-reality-checker, policy, env, ownership, pointer]
timestamp: 2026-07-10T01:40:00.436303Z
sources:
  - docs/policy-runtime-reality.md
  - packages/runtime-reality-checker/src/policy/handle-pre-tool-use.ts
---

# runtime-reality-checker as a PreToolUse policy — pointer

## Read this first

[../policy-runtime-reality.md](../policy-runtime-reality.md) is the authoritative
spec: trigger set, drift severities, block/allow semantics, operator overrides
via `RUNTIME_REALITY_TRIGGERS_FILE`. It is not duplicated here.

Note what that spec says about status (its own opening): the checker is
**library-only**; nothing in a live Claude Code session calls `runRealityCheck`
automatically. The PoC policy code lives in
`packages/runtime-reality-checker/src/policy/`; the harness-side hook
registration is tracked as a follow-up in the harness project. Read the spec as
a design, and check the harness manifest before assuming the hook is live in
any given install.

## The ownership fact agents get backwards

The escalation environment variables are **read and interpreted inside this
package**, not by harness. `handle-pre-tool-use.ts` declares them on its
`PolicyEnv` type (lines 26-36) and resolves each through the local `envOn`
helper (line 88) when it builds its options (lines 113-116):

- `RUNTIME_REALITY_DISABLE`
- `RUNTIME_REALITY_WARN_AS_BLOCK`
- `RUNTIME_REALITY_CRITICAL_AS_WARN`
- `RUNTIME_REALITY_PROBE_FAIL_BLOCK`

Harness's role is only to **set** these variables in the environment of the hook
process it spawns; the meaning of each flag, and the escalation logic they
select, live here. A doc or comment claiming harness interprets them is wrong.

Practical consequence: to change what a toggle does, edit this package and
release it (`@lannguyensi/runtime-reality-checker`, independently versioned);
to change whether a toggle is set for a given install, edit the harness manifest.
