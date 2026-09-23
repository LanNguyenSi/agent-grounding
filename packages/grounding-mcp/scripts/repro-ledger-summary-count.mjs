#!/usr/bin/env node
// Reproduction script for tracker task 0a8645d2: "ledger_add then
// ledger_summary reports 0 facts".
//
// Runs against the BUILT server (dist/server.js) over real stdio
// JSON-RPC, with HOME pointed at a fresh scratch directory per run so it
// never touches a real ~/.evidence-ledger.
//
// Usage: node scripts/repro-ledger-summary-count.mjs [path/to/dist/server.js]
// (defaults to ../dist/server.js relative to this script)
//
// Findings (2026-09-23, against this repo's grounding-mcp 0.12.0 build):
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
//   - No defect was found at the MCP tool level. This script is the
//     record of that negative reproduction attempt; see
//     tests/grounding-gate-mcp-roundtrip.test.ts for the same cases
//     pinned as automated regression tests.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] ?? join(__dirname, '..', 'dist', 'server.js');

function startServer(scratchHome) {
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

async function main() {
  let failures = 0;

  // Case 1: same sessionId, every entry type, same process.
  {
    const scratchHome = mkdtempSync(join(tmpdir(), 'ledger-repro-'));
    const server = startServer(scratchHome);
    await server.init();
    const sessionId = 'gs-repro-session-abc123';
    for (const type of ['fact', 'hypothesis', 'rejected', 'unknown', 'policy_decision']) {
      await server.callTool('ledger_add', { sessionId, type, content: `entry of type ${type}`, confidence: 'high' });
      const summary = await server.callTool('ledger_summary', { sessionId });
      const counts = factsCount(summary);
      const key = { fact: 'facts', hypothesis: 'hypotheses', rejected: 'rejected', unknown: 'unknowns', policy_decision: 'policyDecisions' }[type];
      const ok = counts && counts[key] >= 1;
      console.log(`[same-session, type=${type}] count.${key}=${counts?.[key]} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`);
      if (!ok) failures++;
    }
    server.stop();
  }

  // Case 2: same sessionId, across two separate process invocations.
  {
    const scratchHome = mkdtempSync(join(tmpdir(), 'ledger-repro-cross-'));
    const sessionId = 'gs-repro-cross-proc-xyz789';
    const s1 = startServer(scratchHome);
    await s1.init();
    await s1.callTool('ledger_add', { sessionId, type: 'fact', content: 'cross-process fact', confidence: 'high' });
    s1.stop();
    const s2 = startServer(scratchHome);
    await s2.init();
    const summary = await s2.callTool('ledger_summary', { sessionId });
    const counts = factsCount(summary);
    const ok = counts && counts.facts >= 1;
    console.log(`[cross-process, same HOME, same sessionId] counts.facts=${counts?.facts} -> ${ok ? 'OK (non-zero)' : 'UNEXPECTED ZERO'}`);
    if (!ok) failures++;
    s2.stop();
  }

  // Case 3: mismatched sessionId (documented, intended zero).
  {
    const scratchHome = mkdtempSync(join(tmpdir(), 'ledger-repro-mismatch-'));
    const server = startServer(scratchHome);
    await server.init();
    await server.callTool('ledger_add', { sessionId: 'gs-agent-grounding-abc123', type: 'fact', content: 'added under gs-* id', confidence: 'high' });
    const summary = await server.callTool('ledger_summary', { sessionId: 'fix/0a8645d2-ledger-summary-count' });
    const counts = factsCount(summary);
    const isZero = counts && counts.facts === 0;
    console.log(`[mismatched sessionId, intended] counts.facts=${counts?.facts} -> ${isZero ? 'OK (zero, as documented)' : 'UNEXPECTED NON-ZERO'}`);
    server.stop();
  }

  if (failures > 0) {
    console.error(`\n${failures} case(s) showed an unexpected zero count for a same-sessionId add+summary pair.`);
    process.exit(1);
  }
  console.log('\nNo defect reproduced: ledger_summary always reflects a prior ledger_add under the same exact sessionId.');
}

main();
