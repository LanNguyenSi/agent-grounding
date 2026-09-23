#!/usr/bin/env node
// Reproduction script for tracker task 0a8645d2: "ledger_add then
// ledger_summary reports 0 facts".
//
// Runs against the BUILT server (dist/server.js) over real stdio
// JSON-RPC, with HOME pointed at a fresh scratch directory per run so it
// never touches a real ~/.evidence-ledger.
//
// Usage:
//   node scripts/repro-ledger-summary-count.mjs [label=]path/to/server.js ...
// One or more server entry points, each optionally prefixed with a
// "label=" tag for the report. Defaults to a single "workspace-build"
// configuration at ../dist/server.js relative to this script when no
// argument is given.
//
// The tracker observation was made against a PACKED tarball installed
// into an isolated npm prefix with REGISTRY siblings (evidence-ledger
// 0.6.0 from npm, not this workspace's build), HOME at scratch; the
// published grounding-mcp 0.11.0 reportedly behaved identically. To
// reproduce that exact configuration (not just the workspace build),
// run this script against each of:
//
//   1. workspace-build:   this repo's own `npm run build` output
//                          (default, no npm/network dependency)
//   2. tarball+registry:  `npm pack` this package (from
//                          packages/grounding-mcp, after `npm run
//                          build`), then
//                          `npm install --prefix <scratch> <tarball>`
//                          (never -g) and pass
//                          `<scratch>/node_modules/@lannguyensi/grounding-mcp/dist/server.js`.
//                          `npm ls --prefix <scratch>
//                          @lannguyensi/evidence-ledger` confirms which
//                          evidence-ledger version resolved (the
//                          tarball's package.json pins an exact
//                          version, e.g. "0.6.0", so npm installs that
//                          from the registry as a sibling, not this
//                          workspace's source).
//   3. registry@0.12.0:   `npm install --prefix <scratch>
//                          @lannguyensi/grounding-mcp@0.12.0` (the
//                          published version this repo currently
//                          ships), same server.js path pattern.
//   4. registry@0.11.0:   same, pinned to @0.11.0 (the version the
//                          tracker task says behaved identically).
//
// Configurations 2-4 need npm registry access and are not run
// automatically here (no network dependency baked into a committed
// script); the exact commands above reproduce them.
//
// Findings (sequential-only investigation, 2026-09-23, against this
// repo's grounding-mcp 0.12.0, Cases 1/1b/2/3 below: every one
// SEQUENTIAL, i.e. it awaits ledger_add's response before sending
// ledger_summary):
//   - For every entry type (fact, hypothesis, rejected, unknown,
//     policy_decision), ledger_summary called with the SAME sessionId
//     string ledger_add used reports a non-zero count for that type,
//     both within one server process and across two separate server
//     process invocations (same scratch HOME).
//   - The same holds for a range of sessionId shapes (Case 1b): a
//     `gs-*` id, a branch-name-shaped id with a slash,
//     leading/trailing whitespace, uppercase, "default", and a
//     300-char id.
//   - A mismatched sessionId (Case 3) reports 0 for the mismatched
//     call, as documented: intended, strict-equality behavior of the
//     shared evidence-ledger `session` column (see
//     docs/okf/evidence-ledger-session-key-shapes.md), not a defect.
//   - Ran all four configurations above (workspace-build,
//     tarball+registry with evidence-ledger 0.6.0 confirmed resolved
//     from the registry via `npm ls`, registry @0.12.0, registry
//     @0.11.0): every configuration showed the same result in every
//     SEQUENTIAL case. The published evidence-ledger 0.6.0's db.ts
//     (getDbPath: `join(homedir(), ".evidence-ledger")`, file name
//     "ledger.db") is byte-for-byte the same session-handling and
//     DB-path logic as this workspace's source; grounding-mcp's
//     ledger-bridge.ts calls the SAME evidence-ledger `getDb()`
//     singleton for both `ledger_add` and `ledger_summary` inside one
//     process, so there is no place a write could resolve one DB path
//     and a read another, in the packed/published builds any more than
//     in the workspace build.
//   - The sequential-only investigation concluded (WRONG, see the
//     pipelined investigation below) that no defect existed at the MCP
//     tool level. That conclusion held only because it never tried a
//     concurrent/pipelined add+summary pair.
//
// Findings (pipelined investigation, 2026-09-23, against this repo's
// grounding-mcp, base commit fe8fa4f, Case 4 below, PIPELINED: the
// ledger_summary request is sent immediately after ledger_add, WITHOUT
// awaiting ledger_add's response first):
//   - The defect IS real: 20/20 runs of Case 4 against base fe8fa4f
//     reported counts.facts=0 for a ledger_summary that raced a
//     ledger_add on the same sessionId. Cause: the MCP SDK's
//     `tools/call` dispatch validates each request's zod input schema
//     asynchronously before invoking its handler, and ledger_add's
//     (5-key object) and ledger_summary's (3-key object) schemas
//     resolve that validation in a different number of microtask
//     ticks, so the summary handler can be INVOKED before the add
//     handler even though the add request was sent, and received,
//     first, confirmed by an instrumented trace, not just by output
//     timing (see the "Ledger request serialization" comment above
//     `createLedgerRequestQueue` in src/server.ts for the full
//     mechanism).
//   - An earlier fix serialized every ledger-touching handler (ledger_add,
//     ledger_summary, claim_evaluate_from_session, ledger_status)
//     through one queue keyed by the JSON-RPC request id's own VALUE
//     (falling back to enqueue-call order for a non-numeric id). Case 4's
//     default rising-integer-id sub-case passed against that fix.
//
// Findings (arrival-stamp investigation, 2026-09-23, against this repo's
// grounding-mcp, same base commit fe8fa4f, Case 4's STRING-id and
// FALLING-numeric-id sub-cases below): the id-VALUE-sorting fix above was
// still wrong for an id shape a real client is free to use.
//   - Sorting by id VALUE assumes a rising numeric sequence, which
//     JSON-RPC does not require: Case 4's string-id and falling-id
//     sub-cases both reproduced the original defect (counts.facts=0)
//     against the id-VALUE-sorting fix, exactly like the unfixed base.
//   - The enqueue-call-order fallback for a non-numeric id has the same
//     flaw the original bug did: it observes the SDK's already-reordered
//     invocation order, not the real arrival order, for the same reason
//     the original bug existed.
//   - Fixed by stamping true arrival order at the transport instead
//     (`stampLedgerRequestArrival`, installed by wrapping `server.connect`
//     in `createServer`; see the "Ledger request serialization" comment
//     above `createLedgerRequestQueue` in src/server.ts for the full
//     mechanism). Every Case 4 sub-case (every entry type, default ids,
//     string ids, falling numeric ids) now passes against the fixed
//     build.
//   - This script is the reproduction record for the full investigation;
//     see tests/grounding-gate-mcp-roundtrip.test.ts for the same cases
//     (including pipelined string/falling/UUID ids, as raw JSON-RPC
//     frames over InMemoryTransport) pinned as automated regression
//     tests against the workspace build, run by `npm test`.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Each CLI argument is one configuration to test, as "label=path" or
// just "path" (label defaults to the path). No arguments means a single
// "workspace-build" configuration at the default dist/server.js.
const configs =
  process.argv.length > 2
    ? process.argv.slice(2).map((arg) => {
        const eq = arg.indexOf('=');
        return eq > 0 ? { label: arg.slice(0, eq), serverPath: arg.slice(eq + 1) } : { label: arg, serverPath: arg };
      })
    : [{ label: 'workspace-build', serverPath: join(__dirname, '..', 'dist', 'server.js') }];

// Scratch dirs made by every case below, removed in `main`'s `finally` so a
// run that fails partway still cleans up instead of leaking tempdirs.
const scratchDirs = [];

function makeScratchHome(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function startServer(serverPath, scratchHome) {
  // Drop EVIDENCE_LEDGER_DB from the child's env even when it is set in
  // THIS process's own env (a leftover from a manual invocation, or a
  // parent test run): otherwise the child ignores the scratch HOME below
  // and writes to whatever path that variable names, defeating the
  // isolation this script exists to guarantee.
  const { EVIDENCE_LEDGER_DB: _unused, ...restEnv } = process.env;
  const child = spawn('node', [serverPath], {
    env: { ...restEnv, HOME: scratchHome, PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`));

  // `sendRaw` writes the request and returns immediately with the pending
  // response promise, WITHOUT awaiting it: the caller decides whether to
  // await right away (the sequential cases below) or fire a second
  // request first (the pipelined case, which is the one that actually
  // reproduces the tracker defect; see `send`/`callTool`, which both
  // await, for why the sequential cases above never do).
  // `id` is optional: defaults to the next auto-incrementing integer, or
  // pass an explicit string/number to control the exact JSON-RPC request
  // id (used by Case 4's string-id and falling-id sub-cases below, which
  // need ids the default rising-integer counter never produces).
  function sendRaw(method, params, id = nextId++) {
    const promise = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return { id, promise };
  }
  function send(method, params) {
    return sendRaw(method, params).promise;
  }
  function callTool(name, args) {
    return send('tools/call', { name, arguments: args });
  }
  function callToolRaw(name, args, id) {
    return sendRaw('tools/call', { name, arguments: args }, id);
  }
  async function init() {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'repro-ledger-summary-count', version: '0.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  function stop() {
    child.stdin.end();
    child.kill();
  }
  return { callTool, callToolRaw, init, stop };
}

function factsCount(summaryRaw) {
  const text = summaryRaw.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text).counts;
  } catch {
    return null;
  }
}

// Session id shapes actually exercised by Case 1b below. Every entry here
// is expected to be non-zero when ledger_summary is called with the exact
// same string ledger_add used: the header's shape claim is backed by
// this array, not by prose alone.
const SESSION_ID_SHAPES = [
  'gs-repro-shape-basic',
  'fix/0a8645d2-ledger-summary-count', // branch-name-shaped, contains a slash
  '  gs-repro-shape-padded  ', // leading/trailing whitespace
  'GS-REPRO-SHAPE-UPPER', // uppercase
  'default',
  'g'.repeat(300), // 300-char id
];

async function runConfig({ label, serverPath }) {
  console.log(`\n=== configuration: ${label} (${serverPath}) ===`);
  let failures = 0;

  // Case 1: same sessionId, every entry type, same process, sequential
  // (ledger_add's response is awaited before ledger_summary is sent).
  {
    const scratchHome = makeScratchHome('ledger-repro-');
    const server = startServer(serverPath, scratchHome);
    await server.init();
    const sessionId = 'gs-repro-session-abc123';
    for (const type of ['fact', 'hypothesis', 'rejected', 'unknown', 'policy_decision']) {
      await server.callTool('ledger_add', { sessionId, type, content: `entry of type ${type}`, confidence: 'high' });
      const summary = await server.callTool('ledger_summary', { sessionId });
      const counts = factsCount(summary);
      const key = { fact: 'facts', hypothesis: 'hypotheses', rejected: 'rejected', unknown: 'unknowns', policy_decision: 'policyDecisions' }[type];
      const ok = counts && counts[key] >= 1;
      console.log(`[${label}] [same-session, type=${type}] count.${key}=${counts?.[key]} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`);
      if (!ok) failures++;
    }
    server.stop();
  }

  // Case 1b: a range of sessionId shapes, sequential add-then-summary,
  // each on its own fresh session so the shapes cannot collide with each
  // other. Backs the header's "a range of sessionId shapes" claim with an
  // actual run instead of prose only (round-2 finding: the header used to
  // claim these shapes were tested without a corresponding case).
  {
    const scratchHome = makeScratchHome('ledger-repro-shapes-');
    const server = startServer(serverPath, scratchHome);
    await server.init();
    for (const sessionId of SESSION_ID_SHAPES) {
      await server.callTool('ledger_add', { sessionId, type: 'fact', content: 'shape pin', confidence: 'high' });
      const summary = await server.callTool('ledger_summary', { sessionId });
      const counts = factsCount(summary);
      const ok = counts && counts.facts >= 1;
      console.log(`[${label}] [sessionId shape=${JSON.stringify(sessionId)}] counts.facts=${counts?.facts} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`);
      if (!ok) failures++;
    }
    server.stop();
  }

  // Case 2: same sessionId, across two separate process invocations.
  {
    const scratchHome = makeScratchHome('ledger-repro-cross-');
    const sessionId = 'gs-repro-cross-proc-xyz789';
    const s1 = startServer(serverPath, scratchHome);
    await s1.init();
    await s1.callTool('ledger_add', { sessionId, type: 'fact', content: 'cross-process fact', confidence: 'high' });
    s1.stop();
    const s2 = startServer(serverPath, scratchHome);
    await s2.init();
    const summary = await s2.callTool('ledger_summary', { sessionId });
    const counts = factsCount(summary);
    const ok = counts && counts.facts >= 1;
    console.log(`[${label}] [cross-process, same HOME, same sessionId] counts.facts=${counts?.facts} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`);
    if (!ok) failures++;
    s2.stop();
  }

  // Case 3: mismatched sessionId (documented, intended zero).
  {
    const scratchHome = makeScratchHome('ledger-repro-mismatch-');
    const server = startServer(serverPath, scratchHome);
    await server.init();
    await server.callTool('ledger_add', { sessionId: 'gs-agent-grounding-abc123', type: 'fact', content: 'added under gs-* id', confidence: 'high' });
    const summary = await server.callTool('ledger_summary', { sessionId: 'fix/0a8645d2-ledger-summary-count' });
    const counts = factsCount(summary);
    const isZero = counts && counts.facts === 0;
    console.log(`[${label}] [mismatched sessionId, intended] counts.facts=${counts?.facts} -> ${isZero ? 'OK (zero, as documented)' : 'UNEXPECTED NON-ZERO'}`);
    server.stop();
  }

  // Case 4: PIPELINED add+summary for the same sessionId, the exact
  // shape that actually reproduces the tracker defect (the sequential
  // cases above never do): a ledger_add request is sent, then a second
  // request is sent immediately after WITHOUT awaiting ledger_add's
  // response first; both responses are then awaited together. Three
  // sub-cases:
  //   - every entry type (fact, hypothesis, rejected, unknown,
  //     policy_decision), one pipelined add+summary pair per type, each
  //     on its own sessionId, default rising-integer request ids;
  //   - STRING request ids ('s-add'/'s-summary'): an id has no numeric
  //     value a rising-integer-id-shaped fix can sort by;
  //   - FALLING numeric request ids (add's id numerically LARGER than
  //     summary's, even though add is sent, and arrives, first): a fix
  //     that sorts by id VALUE runs summary before add here.
  // Failed 20/20 runs of the default-ids sub-case against this task's
  // base commit (fe8fa4f, no queue at all): the MCP SDK validates each
  // request's zod schema asynchronously before invoking its handler, and
  // ledger_add's and ledger_summary's schemas (different field counts)
  // resolve that validation in a different number of microtask ticks, so
  // the summary handler can run before the add handler even though its
  // request was sent second. An earlier fix for this task serialized
  // ledger-touching handlers by sorting the JSON-RPC request id's own
  // VALUE: that fixed the default rising-integer-id sub-case but not the
  // string-id or falling-id sub-cases below, since neither id shape has
  // a value a rising-sequence sort can rely on. The fix that closes all
  // three sub-cases stamps true arrival order at the transport instead
  // (see the "Ledger request serialization" comment in src/server.ts).
  {
    const entryTypeToKey = {
      fact: 'facts',
      hypothesis: 'hypotheses',
      rejected: 'rejected',
      unknown: 'unknowns',
      policy_decision: 'policyDecisions',
    };
    for (const [type, key] of Object.entries(entryTypeToKey)) {
      const scratchHome = makeScratchHome('ledger-repro-pipelined-type-');
      const server = startServer(serverPath, scratchHome);
      await server.init();
      const sessionId = `gs-repro-pipelined-${type}`;
      const addPending = server.callToolRaw('ledger_add', { sessionId, type, content: `pipelined add type=${type}`, confidence: 'high' });
      const summaryPending = server.callToolRaw('ledger_summary', { sessionId });
      const [, summaryRaw] = await Promise.all([addPending.promise, summaryPending.promise]);
      const counts = factsCount(summaryRaw);
      const ok = counts && counts[key] >= 1;
      console.log(`[${label}] [pipelined add(id=${addPending.id})+summary(id=${summaryPending.id}), type=${type}, same sessionId] counts.${key}=${counts?.[key]} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`);
      if (!ok) failures++;
      server.stop();
    }

    {
      const scratchHome = makeScratchHome('ledger-repro-pipelined-string-id-');
      const server = startServer(serverPath, scratchHome);
      await server.init();
      const sessionId = 'gs-repro-pipelined-string-id';
      const addPending = server.callToolRaw(
        'ledger_add',
        { sessionId, type: 'fact', content: 'pipelined add, string id', confidence: 'high' },
        's-add',
      );
      const summaryPending = server.callToolRaw('ledger_summary', { sessionId }, 's-summary');
      const [, summaryRaw] = await Promise.all([addPending.promise, summaryPending.promise]);
      const counts = factsCount(summaryRaw);
      const ok = counts && counts.facts >= 1;
      console.log(
        `[${label}] [pipelined add(id=${JSON.stringify(addPending.id)})+summary(id=${JSON.stringify(summaryPending.id)}), STRING ids, same sessionId] counts.facts=${counts?.facts} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`,
      );
      if (!ok) failures++;
      server.stop();
    }

    {
      const scratchHome = makeScratchHome('ledger-repro-pipelined-falling-id-');
      const server = startServer(serverPath, scratchHome);
      await server.init();
      const sessionId = 'gs-repro-pipelined-falling-id';
      const addPending = server.callToolRaw(
        'ledger_add',
        { sessionId, type: 'fact', content: 'pipelined add, falling id', confidence: 'high' },
        9000,
      );
      const summaryPending = server.callToolRaw('ledger_summary', { sessionId }, 7);
      const [, summaryRaw] = await Promise.all([addPending.promise, summaryPending.promise]);
      const counts = factsCount(summaryRaw);
      const ok = counts && counts.facts >= 1;
      console.log(
        `[${label}] [pipelined add(id=${addPending.id})+summary(id=${summaryPending.id}), FALLING numeric ids, same sessionId] counts.facts=${counts?.facts} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`,
      );
      if (!ok) failures++;
      server.stop();
    }
  }

  return failures;
}

async function main() {
  let totalFailures = 0;
  try {
    for (const config of configs) {
      totalFailures += await runConfig(config);
    }
  } finally {
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (totalFailures > 0) {
    console.error(`\n${totalFailures} case(s), across ${configs.length} configuration(s), showed an unexpected zero count for a same-sessionId add+summary pair.`);
    process.exit(1);
  }
  // States only what THIS run exercised: Cases 1/1b/2/3 (sequential, every
  // entry type, a range of sessionId shapes, cross-process) and Case 4
  // (pipelined, every entry type, default rising-integer / string /
  // falling-numeric request ids), against the ${configs.length}
  // configuration(s) passed on the command line. It does not claim
  // anything about a configuration not passed, or about hypothesis_*
  // tools (a separate store, out of scope for this task).
  console.log(
    `\nNo unexpected zero count in any of ${configs.length} configuration(s): ledger_summary always reflected a prior ledger_add under the same exact sessionId, across every entry type, sequential and pipelined, including STRING and FALLING-numeric pipelined request ids.`,
  );
}

main();
