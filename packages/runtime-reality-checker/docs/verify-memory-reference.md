# verify_memory_reference

Checks whether a stored memory's claim about the repo (a file path, a
symbol, or a CLI flag) still holds against the current working tree.

A memory that names a concrete file, symbol, or CLI flag is making a
claim about the current repo state. Files get renamed, symbols get
deleted, never-merged PRs leave phantom references, and a memory
written months ago has no way to catch up on its own. An agent's own
instructions may require verifying such references before recommending
anything based on a memory.

`verifyMemoryReference` does that check in-process:

```typescript
import { verifyMemoryReference } from "@lannguyensi/runtime-reality-checker";

// 1. Does the file still exist?
const pathResult = verifyMemoryReference({
  kind: "path",
  value: "src/hooks/user-prompt-submit.ts", // example: a path from another repo's memory
  repoRoot: "/path/to/repo",
});
// -> { exists: true, lastModified: "2026-04-21T...", summary: "path '...' exists ..." }

// 2. Does the function the memory references still exist?
const symbolResult = verifyMemoryReference({
  kind: "symbol",
  value: "loadMemoriesFromDir",
});
// -> { exists: true, foundIn: [...], matchCount: N, summary: "symbol '...' found in N files" }

// 3. Is the CLI flag still wired up?
const flagResult = verifyMemoryReference({
  kind: "flag",
  value: "--no-verify",
});
// -> { exists: false, summary: "flag '...' not found in any scanned file" }
```

Implementation notes:

- No runtime dependencies, native `fs` recursion + `RegExp`. Walks a
  typical mid-size repo in ~100 ms.
- Default ignores: `node_modules`, `dist`, `build`, `.git`, `.next`,
  `coverage`, `.venv`, `__pycache__`, `.turbo`, `.cache`.
- Default extensions (symbol/flag): `ts`, `tsx`, `mts`, `mjs`, `js`,
  `jsx`, `py`, `go`, `rs`, `java`. Override via `VerifyOptions.extensions`.
- Cap via `VerifyOptions.maxFiles` (default 5000): the `summary` flags
  truncation so the caller can raise the cap on a larger repo.
- Never throws: unreadable `repoRoot` returns `{ exists: false }`.
- `kind:'flag'` uses a word-boundary guard: `-v` does **not** match
  inside `--verbose`, and `--force` does **not** match inside
  `--force-with-lease`. The guard treats dash-or-word as the token
  boundary, so flag tokens are matched in isolation.
- `kind:'path'` on a *relative* value refuses to check paths that
  resolve outside `repoRoot` (traversal like `../../etc/passwd` ->
  `exists:false` with a clear summary). Absolute values pass through
  unchanged, use that when the caller legitimately wants to check
  something outside the repo.
- **Symlink cycles are safe.** The walker uses `lstat` to classify
  directory symlinks out of the descent and canonicalises each
  visited directory via `realpath` so hard-link/loop fixtures cannot
  run the walker forever.
- **No-extension files** (`Makefile`, `Dockerfile`, `LICENSE`, etc.)
  are **off by default**. Opt in via `VerifyOptions.includeNoExtension: true`
  to scan them all, or pass `VerifyOptions.extraNoExtensionNames: ['Makefile']`
  to opt in by name only.

Exposed via MCP as the `verify_memory_reference` tool in
[`grounding-mcp`](../../grounding-mcp). Agents should call it whenever a
memory's content cites a specific file/function/flag before acting on
the advice.
