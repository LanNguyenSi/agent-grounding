import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ASSESSMENT_POLICY } from '../src/grounding-assessment-policy.js';
import { loadAssessmentIssuer } from '../src/grounding-issuer.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { failures.push(error); } }
  vi.restoreAllMocks();
  expect(failures).toEqual([]);
});
const entrypoint = resolve(import.meta.dirname, '../dist/assessment-index.js');
const expectedTools = ['assessment_advance', 'assessment_claim_set', 'assessment_dossier_add', 'assessment_dossier_read', 'assessment_export', 'assessment_start', 'assessment_status'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'assessment-surface-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  const key = join(root, 'issuer.pem'); const file = join(root, 'config.json'); const state = join(root, 'state');
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(key, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const config = { issuer: 'issuer.test', kid: 'key.test', privateKeyPath: key, stateDirectory: state, policy: { ...ASSESSMENT_POLICY } };
  writeFileSync(file, JSON.stringify(config));
  const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: home, HARNESS_HOME: join(home, '.harness'),
    GROUNDING_ASSESSMENT_CONFIG: file, SOLUTION_VERDICT_SIGNING_KEY: 'secret-environment-canary',
    GROUNDING_MCP_SESSIONS_DIR: join(home, 'legacy-sessions'), EVIDENCE_LEDGER_DB: join(home, 'legacy-ledger.db') };
  return { root, home, key, file, state, keys, config, env };
}
type Fixture = ReturnType<typeof fixture>;
async function run(f: Fixture, args: string[], env: NodeJS.ProcessEnv = f.env) {
  const child = spawn(process.execPath, args, { cwd: f.home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let timedOut = false;
  const done = new Promise<{ code: number | null; signal: string | null }>((resolvePromise, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  child.stdout.on('data', (value) => { stdout += String(value); if (stdout.length > 65536) child.kill('SIGKILL'); });
  child.stderr.on('data', (value) => { stderr += String(value); if (stderr.length > 65536) child.kill('SIGKILL'); });
  child.stdin.end();
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 4000);
  try { return { ...await done, stdout, stderr, timedOut }; } finally { clearTimeout(timer); }
}

const invalidConfigurations: { name: string; change: (f: Fixture) => string | undefined }[] = [
  { name: 'missing environment', change: () => undefined },
  { name: 'missing config file', change: (f) => join(f.root, 'missing-secret-config') },
  { name: 'relative config path', change: () => 'relative-secret-config.json' },
  { name: 'malformed JSON', change: (f) => { writeFileSync(f.file, '{secret-config'); return f.file; } },
  { name: 'malformed UTF8', change: (f) => { writeFileSync(f.file, Buffer.from(JSON.stringify({ ...f.config, stateDirectory: `${f.state}-UTF8` })).map((byte, i, bytes) => bytes.subarray(i, i + 4).toString() === 'UTF8' ? 0xff : byte)); return f.file; } },
  { name: 'oversized config', change: (f) => { writeFileSync(f.file, ' '.repeat(65537)); return f.file; } },
  { name: 'config directory', change: (f) => f.home },
  ...[
    ['unknown top-level field', { authority: 'secret-config' }],
    ['relative key path', { privateKeyPath: 'issuer.pem' }],
    ['relative state path', { stateDirectory: 'state' }],
    ['invalid issuer', { issuer: 'invalid issuer secret' }],
    ['invalid kid', { kid: '' }],
    ['wrong policy id', { policy: { ...ASSESSMENT_POLICY, id: 'other-policy' } }],
    ['wrong policy revision', { policy: { ...ASSESSMENT_POLICY, revision: '2' } }],
    ['wrong policy digest', { policy: { ...ASSESSMENT_POLICY, sha256: 'b'.repeat(64) } }],
    ['unknown policy field', { policy: { ...ASSESSMENT_POLICY, allowed: true } }],
  ].map(([name, override]) => ({ name: name as string, change: (f: Fixture) => { writeFileSync(f.file, JSON.stringify({ ...f.config, ...override as object })); return f.file; } })),
  { name: 'missing key', change: (f) => { rmSync(f.key); return f.file; } },
  { name: 'oversized key', change: (f) => { writeFileSync(f.key, 'secret-key'.repeat(10000)); return f.file; } },
  { name: 'malformed key', change: (f) => { writeFileSync(f.key, 'secret-key'); return f.file; } },
  { name: 'malformed key UTF8', change: (f) => { writeFileSync(f.key, Buffer.from([0xff])); return f.file; } },
  { name: 'public key', change: (f) => { writeFileSync(f.key, f.keys.publicKey.export({ format: 'pem', type: 'spki' })); return f.file; } },
  { name: 'non-Ed25519 private key', change: (f) => { writeFileSync(f.key, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' })); return f.file; } },
];

describe('assessment producer startup and surface', () => {
  it('loads valid explicit issuer config without creating state or looking up trust', async () => {
    const f = fixture(); const loaded = await loadAssessmentIssuer(f.file);
    expect(loaded.config).toEqual(f.config); expect(loaded.privateKey.type).toBe('private'); expect(loaded.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(existsSync(f.state)).toBe(false); expect(readdirSync(f.home)).toEqual([]);
  });

  it('issuer reads tolerate short chunks on one handle and close both files', async () => {
    const f = fixture(); const open = fs.open.bind(fs); const opened: string[] = []; const closes: string[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args); const read = handle.read.bind(handle); const close = handle.close.bind(handle);
      opened.push(String(args[0]));
      handle.read = ((buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 7), position)) as typeof handle.read;
      handle.close = async () => { closes.push(String(args[0])); await close(); };
      return handle;
    });
    expect((await loadAssessmentIssuer(f.file)).config).toEqual(f.config);
    expect(opened).toEqual([f.file, f.key]); expect(closes).toEqual(opened);
  });

  it('issuer rejects a file that grows after stat and closes its handle', async () => {
    const f = fixture(); const open = fs.open.bind(fs); let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args); const stat = handle.stat.bind(handle); const close = handle.close.bind(handle);
      handle.stat = (async () => { const result = await stat(); writeFileSync(f.file, JSON.stringify(f.config) + ' '); return result; }) as typeof handle.stat;
      handle.close = async () => { closed = true; await close(); };
      return handle;
    });
    await expect(loadAssessmentIssuer(f.file)).rejects.toThrow('Assessment startup configuration rejected'); expect(closed).toBe(true);
  });

  it.each(invalidConfigurations)('config: $name fails independently, safely, and before registration', async ({ change }) => {
    const f = fixture(); const selected = change(f);
    // An explicit empty string exercises the missing selector independently of the host environment.
    await expect(loadAssessmentIssuer(selected ?? '')).rejects.toThrow(/^Assessment startup configuration rejected$/);
    const env: NodeJS.ProcessEnv = { ...f.env }; if (selected === undefined) delete env.GROUNDING_ASSESSMENT_CONFIG; else env.GROUNDING_ASSESSMENT_CONFIG = selected;
    const result = await run(f, [entrypoint], env);
    expect(result.timedOut).toBe(false); expect(result.code).toBe(1); expect(result.signal).toBe(null);
    expect(result.stdout).toBe(''); expect(result.stderr).toBe('grounding-assessment-mcp failed to start\n');
    expect(result.stderr).not.toContain(f.root); expect(result.stderr).not.toContain('secret');
    expect(existsSync(f.state)).toBe(false); expect(readdirSync(f.home)).toEqual([]);
  });

  it('new bin metadata, import-only entrypoint, and version work without issuer startup', async () => {
    const f = fixture(); const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
    expect(manifest.bin).toMatchObject({ 'grounding-mcp': 'dist/server.js', 'grounding-assessment-mcp': 'dist/assessment-index.js' });
    const env = { ...f.env, GROUNDING_ASSESSMENT_CONFIG: 'missing-config' };
    for (const option of ['--version', '-v']) {
      const result = await run(f, [entrypoint, option], env);
      expect(result).toEqual({ code: 0, signal: null, timedOut: false, stdout: `${manifest.version}\n`, stderr: '' });
    }
    const imported = await run(f, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(entrypoint).href)})`], env);
    expect(imported).toEqual({ code: 0, signal: null, timedOut: false, stdout: '', stderr: '' });
    expect(existsSync(f.state)).toBe(false); expect(readdirSync(f.home)).toEqual([]);
  });

  it('N-01/N-21 transitive restricted import graph rejects privileged imports, re-exports, and dynamic dependencies', () => {
    const sourceRoot = resolve(import.meta.dirname, '../src');
    const allowedLocal = new Set(['assessment-index.ts', 'assessment-server.ts', 'grounding-issuer.ts', 'grounding-assessment-store.ts', 'grounding-assessment-policy.ts', 'grounding-receipt.ts']);
    const allowedExternal = new Set(['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:url', 'zod', 'proper-lockfile', '@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/stdio.js']);
    const seen = new Set<string>();
    const visitFile = (file: string) => {
      const local = relative(sourceRoot, file);
      expect(allowedLocal.has(local), `forbidden local import: ${local}`).toBe(true);
      if (seen.has(local)) return; seen.add(local);
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const dependency = (expression: ts.Expression) => {
        expect(ts.isStringLiteralLike(expression), 'dependency must use a static literal').toBe(true);
        if (!ts.isStringLiteralLike(expression)) return;
        const name = expression.text;
        if (name.startsWith('.')) visitFile(resolve(dirname(file), name.replace(/\.js$/, '.ts')));
        else expect(allowedExternal.has(name), `forbidden external import: ${name}`).toBe(true);
      };
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) dependency(node.moduleSpecifier as ts.Expression);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && ['require', 'createRequire'].includes(node.expression.text))) {
          expect(node.expression.getText(ast)).not.toBe('createRequire');
          expect(node.arguments).toHaveLength(1); dependency(node.arguments[0]);
        }
        if (ts.isImportEqualsDeclaration(node)) throw new Error('require-style import is outside the restricted graph');
        ts.forEachChild(node, visit);
      };
      visit(ast);
    };
    visitFile(join(sourceRoot, 'assessment-index.ts'));
    expect([...seen].sort()).toEqual([...allowedLocal].sort());
  });

  it('N-21 actual bin symlink exposes exactly seven tools; forbidden names and path inputs have no file or process effects', async () => {
    const f = fixture(); const bin = join(f.root, 'grounding-assessment-mcp'); symlinkSync(entrypoint, bin);
    const canary = join(f.root, 'private-canary'); const marker = join(f.root, 'effect-marker');
    writeFileSync(canary, 'DO-NOT-READ-SECRET');
    const guard = join(f.root, 'guard.cjs');
    // Runtime instrumentation complements the source graph. All normal store/key IO remains real.
    writeFileSync(guard, `const fs = require('node:fs'); const fsp = require('node:fs/promises'); const cp = require('node:child_process');
const mark = fs.appendFileSync.bind(fs); const marker = ${JSON.stringify(marker)}; const canary = ${JSON.stringify(canary)};
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name] = () => { mark(marker, 'process'); throw Error('unexpected process'); };
for (const obj of [fs, fsp]) for (const name of ['readFile','readFileSync','open','openSync','writeFile','writeFileSync']) if (obj[name]) { const original = obj[name]; obj[name] = function(file, ...args) { if (String(file) === canary || String(file) === marker) { mark(marker, 'file'); throw Error('unexpected file access'); } return original.call(this, file, ...args); }; }
require('node:module').syncBuiltinESMExports();`);
    const transport = new StdioClientTransport({ command: bin, cwd: f.home, env: { ...f.env, NODE_OPTIONS: `--require=${guard}` }, stderr: 'pipe' });
    const client = new Client({ name: 'surface-test', version: '1' });
    cleanup.push(() => transport.close()); cleanup.push(() => client.close());
    await client.connect(transport, { timeout: 4000 });
    const previousClose = transport.onclose;
    const closed = new Promise<void>((done) => { transport.onclose = () => { previousClose?.(); done(); }; });
    cleanup.push(async () => { await client.close(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('child did not close')), 5000); })]); } finally { clearTimeout(timer); } });
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, { timeout: 4000 });
    const reject = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args); expect(result.isError, name).toBe(true);
      expect(JSON.stringify(result)).not.toContain('DO-NOT-READ-SECRET');
      expect(existsSync(marker)).toBe(false); expect(readFileSync(canary, 'utf8')).toBe('DO-NOT-READ-SECRET');
      expect(readdirSync(f.home)).toEqual([]);
    };
    for (const name of ['solution_evaluate', 'grounding_start', 'grounding_status', 'ledger_add', 'ledger_summary', 'claim_evaluate', 'claim_evaluate_from_session', 'exec', 'run_command', 'read_file', 'write_file', 'runtime_check', 'runtime_inspect', 'resolve_path']) {
      await reject(name, { sessionId: canary, path: canary, cwd: f.home, command: `touch ${marker}` });
      expect(existsSync(f.state)).toBe(false);
    }
    const now = Math.floor(Date.now() / 1000);
    const c = { audience: 'test', projectId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), nonce: Buffer.alloc(32, 1).toString('base64url'), contextRevision: 1,
      target: { workflowId: null, from: 'a', to: 'b', action: 'c' }, subject: { kind: 'task-context/v1', digest: 'a'.repeat(64) }, policy: ASSESSMENT_POLICY, createdAt: now - 1, expiresAt: now + 600 };
    const pathInputs: [string, Record<string, unknown>][] = [
      ['assessment_start', { challenge: c, keyword: 'service', problem: 'issue', path: canary }],
      ['assessment_status', { sessionId: canary }],
      ['assessment_dossier_read', { sessionId: canary }],
      ['assessment_advance', { sessionId: canary, expectedRevision: 1, expectedPhase: 'scope-resolution' }],
      ['assessment_dossier_add', { sessionId: canary, expectedRevision: 1, kind: 'fact', content: 'x', source: 'x' }],
      ['assessment_claim_set', { sessionId: canary, expectedRevision: 1, text: 'x' }],
      ['assessment_export', { sessionId: canary, expectedRevision: 1, challenge: c }],
    ];
    for (const [name, args] of pathInputs) {
      await reject(name, args); expect(existsSync(f.state)).toBe(false);
    }
    const decode = (result: any) => { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text); };
    const started = decode(await call('assessment_start', { challenge: c, keyword: 'service', problem: 'issue' }));
    const before = readFileSync(join(f.state, 'state.json'));
    await reject('assessment_dossier_add', { sessionId: started.id, expectedRevision: started.revision, kind: 'fact', content: 'x', source: 'x', path: canary });
    expect(readFileSync(join(f.state, 'state.json'))).toEqual(before);
    const inert = `${canary}; touch ${marker}; $(touch ${marker})`;
    decode(await call('assessment_dossier_add', { sessionId: started.id, expectedRevision: started.revision, kind: 'fact', content: inert, source: inert }));
    const dossier = decode(await call('assessment_dossier_read', { sessionId: started.id }));
    expect(dossier.entries[0]).toMatchObject({ content: inert, source: inert, origin: 'agent_asserted' });
    expect(existsSync(marker)).toBe(false); expect(readFileSync(canary, 'utf8')).toBe('DO-NOT-READ-SECRET');
    expect(readdirSync(f.home)).toEqual([]);
  });
});
