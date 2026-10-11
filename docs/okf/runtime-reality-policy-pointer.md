---
type: overview
title: runtime-reality-checker as a policy — who owns the env toggles
description: Pointer doc — docs/policy-runtime-reality.md is the authoritative spec; this entry adds the ownership fact agents get backwards, namely that this package interprets its own escalation env vars while harness sets them and itself reads only the probe command and RUNTIME_REALITY_DISABLE (before it denies a timed-out stdin read).
tags: [runtime-reality-checker, policy, env, ownership, pointer]
timestamp: 2026-10-11T17:13:28Z
sources:
  - docs/policy-runtime-reality.md
  - packages/runtime-reality-checker/src/policy/handle-pre-tool-use.ts
  - packages/runtime-reality-checker/src/policy/pre-tool-use.ts
---

# runtime-reality-checker as a PreToolUse policy — pointer

## Read this first

[../policy-runtime-reality.md](../policy-runtime-reality.md) is the authoritative
spec: trigger set, drift severities, block/allow semantics, operator overrides
via `RUNTIME_REALITY_TRIGGERS_FILE`. It is not duplicated here.

Note what that spec says about status (its own opening): the policy code lives
in `packages/runtime-reality-checker/src/policy/`, and the package's own
`runtime-reality-policy-pre-tool-use` bin ships without a probe
(`packages/runtime-reality-checker/src/policy/pre-tool-use.ts:40-42#"probe: null,"`),
so on its own it never blocks on drift. The live integration is harness's
`harness pack hook runtime-reality`, which runs the host's probe command
(`RUNTIME_REALITY_PROBE_CMD`, read by harness, not by this package) and passes
the result to this package's handler. Check the harness manifest before
assuming that hook is wired in any given install.

## The ownership fact agents get backwards

The escalation environment variables are **read and interpreted inside this
package**; of the four, harness itself reads only `RUNTIME_REALITY_DISABLE`
(see below). `handle-pre-tool-use.ts` declares them on its
`PolicyEnv` type (`handle-pre-tool-use.ts:26-35#"RUNTIME_REALITY_PROBE_FAIL_BLOCK?: string;"`) and resolves each through the local `envOn`
helper (`handle-pre-tool-use.ts:88#"function envOn"`) when it builds its options (`handle-pre-tool-use.ts:113-116#"probe_fail_block: envOn(env.RUNTIME_REALITY_PROBE_FAIL_BLOCK)"`):

- `RUNTIME_REALITY_DISABLE`
- `RUNTIME_REALITY_WARN_AS_BLOCK`
- `RUNTIME_REALITY_CRITICAL_AS_WARN`
- `RUNTIME_REALITY_PROBE_FAIL_BLOCK`

Harness's role is to **set** these variables in the environment of the hook it
runs; the meaning of each flag, and the escalation logic they select, live
here. harness reads the probe command, which this package never reads, and it
also checks `RUNTIME_REALITY_DISABLE` itself, with its own copy of the
on-switch rule, before it denies a timed-out stdin read. The other three flags
are interpreted only here; a doc or comment claiming harness interprets them is
wrong.

Practical consequence: to change what a toggle does in the handler, edit this
package and release it (`@lannguyensi/runtime-reality-checker`, independently
versioned); the timed-out stdin deny and its `RUNTIME_REALITY_DISABLE` check
live in harness. To change whether a toggle is set for a given install, edit
the harness manifest.
