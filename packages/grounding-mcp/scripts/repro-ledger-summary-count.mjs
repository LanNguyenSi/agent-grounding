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
// Findings (2026-09-23, against this repo's grounding-mcp 0.12.0):
//   - For every entry type (fact, hypothesis, rejected, unknown,
//     policy_decision), ledger_summary called with the SAME sessionId
//     string ledger_add used reports a non-zero count for that type,
//     both within one server process and across two separate server
//     process invocations (same scratch HOME).
//   - The same holds for a range of sessionId shapes: a `gs-*` id, a
//     branch-name-shaped id with a slash, leading/trailing whitespace,
//     uppercase, "default", and a 300-char id.
//   - The ONLY way ledger_summary reports 0 for an entry that was
//     actually added is calling it with a DIFFERENT sessionId string
//     than the one ledger_add used (see the mismatched-session case
//     below). That is documented as intended, strict-equality behavior
//     of the shared evidence-ledger `session` column (see
//     docs/okf/evidence-ledger-session-key-shapes.md), not a defect at
//     the ledger_add / ledger_summary MCP-tool level.
//   - Ran all four configurations above (workspace-build,
//     tarball+registry with evidence-ledger 0.6.0 confirmed resolved
//     from the registry via `npm ls`, registry @0.12.0, registry
//     @0.11.0): every configuration showed the same result, no defect
//     reproduced in any of them. The published evidence-ledger 0.6.0's
//     db.ts (getDbPath: `join(homedir(), ".evidence-ledger")`, file
//     name "ledger.db") is byte-for-byte the same session-handling and
//     DB-path logic as this workspace's source; grounding-mcp's
//     ledger-bridge.ts calls the SAME evidence-ledger `getDb()`
//     singleton for both `ledger_add` and `ledger_summary` inside one
//     process, so there is no place a write could resolve one DB path
//     and a read another, in the packed/published builds any more than
//     in the workspace build.
//   - No defect was found at the MCP tool level, in any tested
//     configuration. This script is the record of that negative
//     reproduction attempt; see tests/grounding-gate-mcp-roundtrip.test.ts
//     for the same cases pinned as automated regression tests (against
//     the workspace build, run by `npm test`).

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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

function startServer(serverPath, scratchHome) {
  const child = spawn('node', [serverPath], {
    env: { ...process.env, HOME: scratchHome, PATH: process.env.PATH },
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

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  function callTool(name, args) {
    return send('tools/call', { name, arguments: args });
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
  return { callTool, init, stop };
}

function factsCount(summaryRaw) {
  const text = summaryRaw.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text).counts;
  } catch {
    return null;
  }
}

async function runConfig({ label, serverPath }) {
  console.log(`\n=== configuration: ${label} (${serverPath}) ===`);
  let failures = 0;

  // Case 1: same sessionId, every entry type, same process.
  {
    const scratchHome = mkdtempSync(join(tmpdir(), 'ledger-repro-'));
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

  // Case 2: same sessionId, across two separate process invocations.
  {
    const scratchHome = mkdtempSync(join(tmpdir(), 'ledger-repro-cross-'));
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
    const scratchHome = mkdtempSync(join(tmpdir(), 'ledger-repro-mismatch-'));
    const server = startServer(serverPath, scratchHome);
    await server.init();
    await server.callTool('ledger_add', { sessionId: 'gs-agent-grounding-abc123', type: 'fact', content: 'added under gs-* id', confidence: 'high' });
    const summary = await server.callTool('ledger_summary', { sessionId: 'fix/0a8645d2-ledger-summary-count' });
    const counts = factsCount(summary);
    const isZero = counts && counts.facts === 0;
    console.log(`[${label}] [mismatched sessionId, intended] counts.facts=${counts?.facts} -> ${isZero ? 'OK (zero, as documented)' : 'UNEXPECTED NON-ZERO'}`);
    server.stop();
  }

  return failures;
}

async function main() {
  let totalFailures = 0;
  for (const config of configs) {
    totalFailures += await runConfig(config);
  }

  if (totalFailures > 0) {
    console.error(`\n${totalFailures} case(s), across ${configs.length} configuration(s), showed an unexpected zero count for a same-sessionId add+summary pair.`);
    process.exit(1);
  }
  console.log(`\nNo defect reproduced in any of ${configs.length} configuration(s): ledger_summary always reflects a prior ledger_add under the same exact sessionId.`);
}

main();
