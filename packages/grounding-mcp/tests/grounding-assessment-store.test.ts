import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroundingAssessmentStore, STORE_LIMITS, type AssessmentChallenge } from '../src/grounding-assessment-store.js';
import { ASSESSMENT_POLICY, assessSnapshot, currentPhase, type AssessmentSnapshot } from '../src/grounding-assessment-policy.js';
import { verifyReceipt } from '../src/grounding-receipt.js';

const keys = generateKeyPairSync('ed25519');
const directories: string[] = [];
const children: ChildProcess[] = [];
const producer = { name: 'producer.test', version: '1', policyBuild: 'static-v1' };
function challenge(): AssessmentChallenge {
  return { audience: 'consumer.test', projectId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), nonce: randomBytes(32).toString('base64url'), contextRevision: 1,
    target: { workflowId: null, from: 'working', to: 'review', action: 'submit' }, subject: { kind: 'task-context/v1', digest: 'a'.repeat(64) }, policy: { ...ASSESSMENT_POLICY }, createdAt: 1000, expiresAt: 5000 };
}
function storeAt(directory: string, clock = () => 1000) {
  return new GroundingAssessmentStore({ directory, issuer: 'issuer.test', kid: 'key.test', privateKey: keys.privateKey, producer, clock });
}
async function fixture(keyword = 'service') {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'assessment-')); directories.push(directory);
  const store = storeAt(directory); const c = challenge();
  const session = await store.createSession({ challenge: c, keyword, problem: 'Investigate a reported behavior' });
  return { directory, store, c, session };
}
const request = (session: AssessmentSnapshot) => ({ sessionId: session.id, expectedRevision: session.revision });
const entry = (session: AssessmentSnapshot, kind: 'fact' | 'rejected' | 'hypothesis' | 'unknown' = 'fact') => ({ ...request(session), kind, content: 'I invented this statement; no command was run.', source: 'agent documentary note' });
async function ready(store: GroundingAssessmentStore, initial: AssessmentSnapshot, alternatives = true) {
  let s = initial;
  while (currentPhase(s) !== 'claim-evaluation') s = await store.advance({ ...request(s), expectedPhase: currentPhase(s) });
  s = await store.addDossierEntry(entry(s));
  if (alternatives) s = await store.addDossierEntry(entry(s, 'rejected'));
  return store.setClaim({ ...request(s), text: 'Root cause identified' });
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// An actual independent process loads source through tsx and pauses at a filesystem boundary.
async function worker(directory: string, stage: 'none' | 'before' | 'after' = 'none', clock = 1000) {
  const filename = path.join(directory, `worker-${randomUUID()}.mjs`);
  await fs.writeFile(filename, `
import fs from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { GroundingAssessmentStore } from ${JSON.stringify(new URL('../src/grounding-assessment-store.ts', import.meta.url).href)};
let store, stage, resume;
const rename = fs.rename;
fs.rename = async (...args) => {
  if (stage === 'before') { stage = 'none'; process.send({ type: 'boundary' }); await new Promise(r => resume = r); }
  const result = await rename(...args);
  if (stage === 'after') { stage = 'none'; process.send({ type: 'boundary' }); await new Promise(r => resume = r); }
  return result;
};
process.on('message', async message => {
  if (message.type === 'resume') { resume(); return; }
  if (message.type === 'configure') {
    stage = message.stage;
    store = new GroundingAssessmentStore({ directory: message.directory, issuer: 'issuer.test', kid: 'key.test', privateKey: createPrivateKey(message.key), producer: message.producer, clock: () => message.clock });
    process.send({ type: 'ready' }); return;
  }
  try {
    const result = await store[message.method](message.input);
    process.send({ type: 'result', result: result instanceof Uint8Array ? Buffer.from(result).toString('base64') : result });
  } catch (error) { process.send({ type: 'error', code: error.code, message: error.message }); }
});
`);
  const child = fork(filename, [], { execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  const queue: any[] = []; const pending: { type: string; resolve: (message: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  child.on('message', (message: any) => {
    const index = pending.findIndex((item) => item.type === message.type);
    if (index < 0) queue.push(message);
    else { const item = pending.splice(index, 1)[0]; clearTimeout(item.timer); item.resolve(message); }
  });
  const next = (type: string) => new Promise<any>((resolve, reject) => {
    const index = queue.findIndex((item) => item.type === type);
    if (index >= 0) { resolve(queue.splice(index, 1)[0]); return; }
    const timer = setTimeout(() => reject(new Error(`Worker did not send ${type}`)), 10000);
    pending.push({ type, resolve, reject, timer });
  });
  child.on('exit', () => { for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(new Error('Worker exited')); } });
  child.send({ type: 'configure', directory, stage, clock, producer, key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  await next('ready');
  return { child, next, send: (method: string, input: unknown) => child.send({ method, input }) };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal); await exited;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) await stop(child, 'SIGKILL');
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('authoritative assessment sessions', () => {
  it('N-05 binds before any phase and rejects every changed immutable field', async () => {
    const { store, c, session } = await fixture();
    expect(session).toMatchObject({ revision: 1, events: [], binding: { audience: c.audience, projectId: c.projectId, taskId: c.taskId, subject: c.subject } });
    const changes = [{ audience: 'other' }, { projectId: randomUUID() }, { taskId: randomUUID() }, { subject: { ...c.subject, digest: 'b'.repeat(64) } }];
    for (const change of changes) await expect(store.exportReceipt({ ...request(session), challenge: { ...c, ...change, attemptId: randomUUID() } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.exportReceipt({ sessionId: 'legacy-session', expectedRevision: 1, challenge: c })).rejects.toMatchObject({ code: 'not_found' });
    const changedEdge = { ...c, attemptId: randomUUID(), contextRevision: 2, target: { ...c.target, to: 'done', action: 'approve' } };
    expect(verifyReceipt(await store.exportReceipt({ ...request(session), challenge: changedEdge }), keys.publicKey).payload.target).toEqual(changedEdge.target);
  });

  it('N-19 rejects imported sessions, phase arrays, type/allowed flags, skips, and origin overrides', async () => {
    const { store, c, session } = await fixture();
    for (const field of ['session', 'sessionId', 'currentPhase', 'phases', 'allowed', 'binding', 'skipped']) {
      await expect(store.createSession({ challenge: c, keyword: 'service', problem: 'problem', [field]: true } as never)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const extra of [{ skipped: true }, { currentPhase: 'complete' }, { events: [] }, { keyword: 'plain' }]) {
      await expect(store.advance({ ...request(session), expectedPhase: 'scope-resolution', ...extra } as never)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const extra of [{ type: 'generic' }, { allowed: true }, { origin: 'execution_verified' }]) {
      await expect(store.setClaim({ ...request(session), text: 'root cause', ...extra } as never)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const extra of [{ origin: 'execution_verified' }, { session: {} }, { allowed: true }]) await expect(store.addDossierEntry({ ...entry(session), ...extra } as never)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.addDossierEntry({ ...entry(session), kind: 'policy_decision' } as never)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.exportReceipt({ ...request(session), challenge: c, assessment: { outcome: 'pass' } } as never)).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.getSession({ sessionId: session.id })).revision).toBe(1);
  });

  it('N-19 derives required steps and distinguishes absent facts, hypotheses, empty claims, and type downgrade', async () => {
    const { store, c, session } = await fixture();
    let s = await store.addDossierEntry(entry(session, 'hypothesis'));
    s = await store.setClaim({ ...request(s), text: '  ' });
    const output = async () => verifyReceipt(await store.exportReceipt({ ...request(s), challenge: { ...c, attemptId: randomUUID() } }), keys.publicKey).payload.assessment;
    expect(await output()).toMatchObject({ outcome: 'fail', factCount: 0, reasons: ['mandatory_steps_incomplete', 'fact_missing', 'claim_missing'] });
    s = await store.addDossierEntry(entry(s));
    s = await store.setClaim({ ...request(s), text: 'The behavior is explained' });
    expect(await output()).toMatchObject({ outcome: 'fail', claimAllowed: true, reasons: ['mandatory_steps_incomplete'] });
    while (currentPhase(s) !== 'claim-evaluation') s = await store.advance({ ...request(s), expectedPhase: currentPhase(s) });
    expect(await output()).toMatchObject({ outcome: 'pass' });
    s = await store.setClaim({ ...request(s), text: 'Architecture root cause' });
    expect(await output()).toMatchObject({ outcome: 'fail', reasons: ['claim_prerequisites_missing'] });
    s = await store.addDossierEntry(entry(s, 'rejected'));
    expect(await output()).toMatchObject({ outcome: 'pass' });
  });

  it('N-20 signs invented evidence only as documentary agent_asserted and never advances on export', async () => {
    const { store, c, session, directory } = await fixture();
    const s = await ready(store, session);
    const before = await store.getSession({ sessionId: s.id });
    const wire = await store.exportReceipt({ ...request(s), challenge: c });
    const payload = verifyReceipt(wire, keys.publicKey).payload;
    expect(payload.assessment).toEqual(assessSnapshot(s, { sessionId: s.id, revision: s.revision, binding: s.binding }));
    expect(payload.assessment).toMatchObject({ outcome: 'pass', evidenceOrigin: 'agent_asserted', factCount: 1, reasons: [] });
    expect(s.entries.every((item) => item.origin === 'agent_asserted')).toBe(true);
    expect(s.claim!.origin).toBe('agent_asserted');
    expect(payload.session).toEqual({ id: s.id, revision: s.revision });
    expect(await store.getSession({ sessionId: s.id })).toEqual(before);
    const state = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    expect(state.terminals[0].snapshot).toEqual(s);
    expect(state.terminals[0].wire).toBe(Buffer.from(wire).toString());
    expect(payload.expiresAt).toBe(1900);
  });

  it('derives the only empty phase and enforces phase CAS plus no-op revisions', async () => {
    const { store, session } = await fixture('plain');
    let s = session;
    for (const phase of ['scope-resolution', 'doc-reading', 'playbook-loading'] as const) s = await store.advance({ ...request(s), expectedPhase: phase });
    expect(currentPhase(s)).toBe('evidence-collection');
    await expect(store.advance({ ...request(s), expectedPhase: 'playbook-loading' })).rejects.toMatchObject({ code: 'conflict' });
    while (currentPhase(s) !== 'complete') s = await store.advance({ ...request(s), expectedPhase: currentPhase(s) });
    expect(s.events.map((event) => event.phase)).not.toContain('runtime-inspection');
    expect(await store.advance({ ...request(s), expectedPhase: 'complete' })).toEqual(s);
    s = await store.setClaim({ ...request(s), text: 'generic statement' });
    expect(await store.setClaim({ ...request(s), text: 'generic statement' })).toEqual(s);
  });

  it('detaches output and nested input before waiting for the transaction lock', async () => {
    const { store, directory, c, session } = await fixture();
    const release = await lockfile.lock(path.join(directory, 'store'), { stale: Infinity, update: 2000 });
    const input = { ...request(session), challenge: structuredClone(c) };
    const pending = store.exportReceipt(input);
    input.challenge.subject.digest = 'b'.repeat(64); input.challenge.target.action = 'other';
    await release();
    expect(verifyReceipt(await pending, keys.publicKey).payload.subject).toEqual(c.subject);
    session.binding.subject.digest = 'f'.repeat(64); session.events.push({ phase: 'complete' } as never);
    const read = await store.getSession({ sessionId: session.id }); read.entries.push({ kind: 'fact' } as never);
    expect((await store.getSession({ sessionId: session.id })).entries).toEqual([]);
  });
});

describe('immutable terminal attempts', () => {
  it('N-10 returns exact saved fail bytes after live mutation and expiry, but conflicts on every changed request field', async () => {
    const { store, c, session, directory } = await fixture();
    const original = { ...request(session), challenge: c };
    const wire = await store.exportReceipt(original);
    expect(verifyReceipt(wire, keys.publicKey).payload.assessment.outcome).toBe('fail');
    const updated = await ready(store, session);
    expect(Buffer.from(await store.exportReceipt(original))).toEqual(Buffer.from(wire));
    expect(Buffer.from(await storeAt(directory, () => { throw new Error('Clock must not be consulted'); }).exportReceipt(original))).toEqual(Buffer.from(wire));
    const other = await store.createSession({ challenge: c, keyword: 'service', problem: 'other session' });
    const changed = [
      { sessionId: other.id }, { expectedRevision: updated.revision },
      ...[{ audience: 'other' }, { projectId: randomUUID() }, { taskId: randomUUID() }, { nonce: randomBytes(32).toString('base64url') }, { contextRevision: 2 },
        { target: { ...c.target, workflowId: randomUUID() } }, { target: { ...c.target, from: 'other' } }, { target: { ...c.target, to: 'done' } }, { target: { ...c.target, action: 'other' } },
        { subject: { ...c.subject, digest: 'b'.repeat(64) } }, { createdAt: 999 }, { expiresAt: 4000 }].map((change) => ({ challenge: { ...c, ...change } })),
    ];
    for (const change of changed) await expect(store.exportReceipt({ ...original, ...change })).rejects.toMatchObject({ code: 'conflict' });
    for (const change of [{ id: 'other' }, { revision: '2' }, { sha256: 'b'.repeat(64) }]) await expect(store.exportReceipt({ ...original, challenge: { ...c, policy: { ...c.policy, ...change } } } as never)).rejects.toMatchObject({ code: 'invalid' });
    const next = await store.exportReceipt({ ...request(updated), challenge: { ...c, attemptId: randomUUID() } });
    expect(verifyReceipt(next, keys.publicKey).payload.assessment.outcome).toBe('pass');
    expect(Buffer.from(next)).not.toEqual(Buffer.from(wire));
    await expect(storeAt(directory, () => 5000).exportReceipt({ ...request(updated), challenge: { ...c, attemptId: randomUUID() } })).rejects.toMatchObject({ code: 'invalid' });
    expect(Buffer.from(await storeAt(directory, () => 5000).exportReceipt(original))).toEqual(Buffer.from(wire));
    const reordered = Object.fromEntries(Object.entries(c).reverse()) as AssessmentChallenge;
    expect(Buffer.from(await store.exportReceipt({ ...original, challenge: reordered }))).toEqual(Buffer.from(wire));
  });

  it('persists exact receipt bytes across actual child-process restart', async () => {
    const { store, directory, c, session } = await fixture(); const s = await ready(store, session);
    const input = { ...request(s), challenge: c };
    const first = await worker(directory); first.send('exportReceipt', input);
    const original = (await first.next('result')).result;
    await stop(first.child);
    await store.addDossierEntry(entry(s));
    const restarted = await worker(directory, 'none', 9000); restarted.send('exportReceipt', input);
    expect((await restarted.next('result')).result).toBe(original);
    expect(verifyReceipt(Buffer.from(original, 'base64'), keys.publicKey).payload.assessment.outcome).toBe('pass');
    await stop(restarted.child);
  });
});

describe('serialization, durability and fail-closed storage', () => {
  it('serializes independent store instances: exactly one competing CAS mutation commits', async () => {
    const { store, directory, session } = await fixture();
    const entered = barrier(); const resume = barrier(); const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { entered.resolve(); await resume.promise; return rename(...args); });
    const first = store.advance({ ...request(session), expectedPhase: 'scope-resolution' });
    await entered.promise;
    const second = storeAt(directory).addDossierEntry(entry(session));
    resume.resolve();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason.code).toBe('conflict');
    expect(await store.getSession({ sessionId: session.id })).toMatchObject({ revision: 2, entries: [], events: [{ phase: 'scope-resolution' }] });
  });

  it('serializes child-process advance, ledger write and export around one consistent snapshot', async () => {
    const { store, directory, c, session } = await fixture();
    const s = await ready(store, session);
    const child = await worker(directory, 'before'); child.send('exportReceipt', { ...request(s), challenge: c });
    await child.next('boundary');
    const ledger = store.addDossierEntry(entry(s));
    const advance = storeAt(directory).advance({ ...request(s), expectedPhase: 'claim-evaluation' });
    child.child.send({ type: 'resume' });
    const receipt = verifyReceipt(Buffer.from((await child.next('result')).result, 'base64'), keys.publicKey).payload;
    const results = await Promise.allSettled([ledger, advance]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(receipt.assessment).toEqual(assessSnapshot(s, { sessionId: s.id, revision: s.revision, binding: s.binding }));
    expect(receipt.session.revision).toBe(s.revision);
    expect((await store.getSession({ sessionId: s.id })).revision).toBe(s.revision + 1);
    const state = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    expect(state.terminals[0].snapshot).toEqual(s);
    await stop(child.child);
  });

  it('never takes over an old lock, including a suspended child writer', async () => {
    const { directory, session } = await fixture();
    const spy = vi.spyOn(lockfile, 'lock');
    await storeAt(directory).getSession({ sessionId: session.id });
    const options = spy.mock.calls[0][1]!;
    const child = await worker(directory, 'before'); child.send('addDossierEntry', entry(session)); await child.next('boundary');
    child.child.kill('SIGSTOP');
    const lock = path.join(directory, 'store.lock');
    const old = new Date(0); await fs.utimes(lock, old, old);
    let unexpectedRelease: (() => Promise<void>) | undefined;
    try {
      await expect(lockfile.lock(path.join(directory, 'store'), { ...options, retries: 0 }).then((release) => { unexpectedRelease = release; return release; })).rejects.toMatchObject({ code: 'ELOCKED' });
    } finally { if (unexpectedRelease) await unexpectedRelease(); }
    child.child.kill('SIGCONT');
    // Restore the heartbeat timestamp before resuming the filesystem operation.
    // The ownership probe above intentionally touched only this test-owned lock.
    const now = new Date(); await fs.utimes(lock, now, now);
    child.child.send({ type: 'resume' });
    expect((await child.next('result')).result.revision).toBe(2);
    await stop(child.child);
  });

  it.each(['before', 'after'] as const)('recovers %s atomic rename only after the crashed writer is known dead', async (stage) => {
    const { store, directory, c, session } = await fixture(); const s = await ready(store, session);
    const input = { ...request(s), challenge: c };
    const child = await worker(directory, stage); child.send('exportReceipt', input); await child.next('boundary');
    const disk = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    const saved = stage === 'after' ? disk.terminals[0].wire : null;
    expect(disk.terminals).toHaveLength(stage === 'after' ? 1 : 0);
    await stop(child.child, 'SIGKILL');
    const lock = path.join(directory, 'store.lock');
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
    await expect(lockfile.lock(path.join(directory, 'store'), { stale: Infinity, update: 2000, retries: 0 })).rejects.toMatchObject({ code: 'ELOCKED' });
    // Test-owned quiescent recovery: the only writer has exited; no live contender exists.
    await fs.rmdir(lock);
    const restarted = await worker(directory, 'none', stage === 'after' ? 9000 : 1000); restarted.send('exportReceipt', input);
    const result = Buffer.from((await restarted.next('result')).result, 'base64').toString();
    if (saved) expect(result).toBe(saved);
    expect(verifyReceipt(result, keys.publicKey).payload.assessment.outcome).toBe('pass');
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await store.getSession({ sessionId: s.id })).revision).toBe(s.revision);
    await stop(restarted.child);
  });

  it('fails before commit on write, sync, rename, or lock ownership failure; retries after post-commit uncertainty', async () => {
    const { store, directory, c, session } = await fixture();
    const statePath = path.join(directory, 'state.json'); const original = await fs.readFile(statePath);
    const input = { ...request(session), challenge: c };
    for (const fault of ['write', 'sync', 'rename', 'ownership']) {
      if (fault === 'rename') vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));
      else if (fault === 'ownership') {
        const stat = fs.stat; let count = 0;
        vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
          const result = await stat(...args);
          if (String(args[0]).endsWith('store.lock') && ++count === 4) return { ...result, ino: Number(result.ino) + 1 } as never;
          return result;
        });
      } else {
        const open = fs.open;
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith('.tmp')) vi.spyOn(handle, fault === 'write' ? 'writeFile' : 'sync').mockRejectedValueOnce(new Error('injected precommit failure'));
          return handle;
        });
      }
      await expect(store.exportReceipt(input)).rejects.toMatchObject({ code: 'storage' });
      vi.restoreAllMocks();
      expect(await fs.readFile(statePath)).toEqual(original);
      expect((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    }
    const open = fs.open;
    const canonicalDirectory = await fs.realpath(directory);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === canonicalDirectory) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected directory sync failure'));
      return handle;
    });
    await expect(store.exportReceipt(input)).rejects.toMatchObject({ code: 'storage' });
    vi.restoreAllMocks();
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8')).terminals[0].wire;
    expect(Buffer.from(await store.exportReceipt(input)).toString()).toBe(saved);
  });

  it('reports release failures without losing the exact committed terminal', async () => {
    const { store, directory, c, session } = await fixture(); const lock = lockfile.lock;
    vi.spyOn(lockfile, 'lock').mockImplementation(async (...args) => {
      const release = await lock(...args); return async () => { await release(); throw new Error('injected release failure'); };
    });
    await expect(store.exportReceipt({ ...request(session), challenge: c })).rejects.toMatchObject({ code: 'storage' });
    vi.restoreAllMocks();
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).terminals[0].wire;
    expect(Buffer.from(await store.exportReceipt({ ...request(session), challenge: c })).toString()).toBe(saved);
  });

  it('never recovers malformed, oversized, unknown-version or inconsistent stored state as empty', async () => {
    const { store, directory, session } = await fixture(); const filename = path.join(directory, 'state.json');
    const good = JSON.parse(await fs.readFile(filename, 'utf8'));
    const wrongEvent = structuredClone(good); wrongEvent.sessions[0].events = [{ phase: 'complete', tools: ['claim-gate'], origin: 'producer_api_agent_confirmation', revision: 2 }];
    for (const bad of ['{', '{"version":2,"sessions":[],"terminals":[]}', '{"version":1,"version":1,"sessions":[],"terminals":[]}', JSON.stringify({ ...good, extra: true }), JSON.stringify(wrongEvent), ' '.repeat(STORE_LIMITS.stateBytes + 1)]) {
      await fs.writeFile(filename, bad);
      await expect(store.getSession({ sessionId: session.id })).rejects.toMatchObject({ code: 'storage' });
      expect((await fs.stat(filename)).size).toBe(Buffer.byteLength(bad));
    }
  });
});

describe('bounded validation and producer configuration', () => {
  it('rejects invalid identifiers, nested fields, time bounds, unicode and oversized input', async () => {
    const { store, c, session } = await fixture();
    for (const change of [{ audience: '../../etc' }, { projectId: 'bad' }, { nonce: 'x'.repeat(43) }, { createdAt: -1 }, { createdAt: 1061 }, { expiresAt: 1000 }, { expiresAt: 87401 }, { contextRevision: 0 }, { contextRevision: Number.MAX_SAFE_INTEGER + 1 }, { target: { ...c.target, extra: true } }, { subject: { ...c.subject, extra: true } }, { extra: true }]) {
      await expect(store.createSession({ challenge: { ...c, ...change }, keyword: 'service', problem: 'problem' } as never)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const keyword of ['', '!!!', 'x'.repeat(65)]) await expect(store.createSession({ challenge: c, keyword, problem: 'problem' })).rejects.toThrow();
    for (const content of ['', ' \n ', '\ud800', 'x'.repeat(STORE_LIMITS.content + 1)]) await expect(store.addDossierEntry({ ...entry(session), content })).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.addDossierEntry({ ...entry(session), source: 'x'.repeat(STORE_LIMITS.source + 1) })).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.createSession({ challenge: c, keyword: 'plain', problem: 'x'.repeat(STORE_LIMITS.problem + 1) })).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.setClaim({ ...request(session), text: 'x'.repeat(STORE_LIMITS.content + 1) })).rejects.toMatchObject({ code: 'invalid' });
    for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(store.setClaim({ sessionId: session.id, expectedRevision, text: 'claim' })).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.getSession({ sessionId: session.id })).revision).toBe(1);
  });

  it('checks fresh clocks at boundaries while receipt expiry never exceeds challenge expiry', async () => {
    const { directory, c, session } = await fixture();
    const store = storeAt(directory, () => 1060);
    const wire = await store.exportReceipt({ ...request(session), challenge: { ...c, createdAt: 1120, expiresAt: 1121 } });
    expect(verifyReceipt(wire, keys.publicKey).payload.expiresAt).toBe(1121);
    for (const clock of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 5000]) await expect(storeAt(directory, () => clock).exportReceipt({ ...request(session), challenge: { ...c, attemptId: randomUUID() } })).rejects.toMatchObject({ code: 'invalid' });
    const max = Number.MAX_SAFE_INTEGER;
    const atEnd = storeAt(directory, () => max - 1);
    const tail = { ...c, attemptId: randomUUID(), createdAt: max - 2, expiresAt: max };
    expect(verifyReceipt(await atEnd.exportReceipt({ ...request(session), challenge: tail }), keys.publicKey).payload.expiresAt).toBe(max);
  });

  it('requires an explicit directory and private Ed25519 key with detached metadata', async () => {
    const config = { directory: '/unused-test-path', issuer: 'issuer.test', kid: 'key.test', privateKey: keys.privateKey, producer };
    for (const change of [{ directory: undefined }, { directory: './relative' }, { privateKey: undefined }, { privateKey: keys.publicKey }, { privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }, { issuer: 'https://keys.invalid' }, { producer: { ...producer, source: 'extra' } }]) expect(() => new GroundingAssessmentStore({ ...config, ...change } as never)).toThrow();
  });

  it('bounds entry/aggregate capacity and prevents safe revision overflow', async () => {
    const { store, directory, c, session } = await fixture(); const filename = path.join(directory, 'state.json');
    const original = JSON.parse(await fs.readFile(filename, 'utf8'));
    const exhausted = structuredClone(original); exhausted.sessions[0].revision = Number.MAX_SAFE_INTEGER;
    await fs.writeFile(filename, JSON.stringify(exhausted));
    await expect(store.addDossierEntry(entry(exhausted.sessions[0]))).rejects.toMatchObject({ code: 'limit' });
    await expect(store.advance({ ...request(exhausted.sessions[0]), expectedPhase: 'scope-resolution' })).rejects.toMatchObject({ code: 'limit' });
    await expect(store.setClaim({ ...request(exhausted.sessions[0]), text: 'claim' })).rejects.toMatchObject({ code: 'limit' });
    const full = structuredClone(original); full.sessions[0].revision = STORE_LIMITS.entries + 1;
    full.sessions[0].entries = Array.from({ length: STORE_LIMITS.entries }, (_, i) => ({ id: randomUUID(), kind: 'fact', content: 'fact', source: '', origin: 'agent_asserted', revision: i + 2 }));
    await fs.writeFile(filename, JSON.stringify(full));
    await expect(store.addDossierEntry(entry(full.sessions[0]))).rejects.toMatchObject({ code: 'limit' });
    const sessions = structuredClone(original); sessions.sessions = Array.from({ length: STORE_LIMITS.sessions }, () => ({ ...session, id: randomUUID() }));
    await fs.writeFile(filename, JSON.stringify(sessions));
    await expect(store.createSession({ challenge: c, keyword: 'plain', problem: 'problem' })).rejects.toMatchObject({ code: 'limit' });
    // A bounded valid near-capacity state; the next bounded entry exceeds aggregate bytes.
    const aggregate = structuredClone(full);
    aggregate.sessions = Array.from({ length: 4 }, () => ({ ...structuredClone(full.sessions[0]), id: randomUUID() }));
    for (const s of aggregate.sessions) for (const item of s.entries) item.content = 'x'.repeat(STORE_LIMITS.content - 200);
    let serialized = JSON.stringify(aggregate);
    expect(Buffer.byteLength(serialized)).toBeLessThan(STORE_LIMITS.stateBytes);
    // Fill a remaining producer-owned problem to bring the state inside one entry's distance.
    const space = STORE_LIMITS.stateBytes - Buffer.byteLength(serialized);
    const extra = structuredClone(session); extra.id = randomUUID(); extra.problem = 'p'; aggregate.sessions.push(extra);
    serialized = JSON.stringify(aggregate);
    if (STORE_LIMITS.stateBytes - Buffer.byteLength(serialized) > STORE_LIMITS.content) {
      const filler = STORE_LIMITS.stateBytes - Buffer.byteLength(serialized) - 4000;
      for (const s of aggregate.sessions.slice(0, 4)) { const amount = Math.min(filler / 4, STORE_LIMITS.problem - s.problem.length); s.problem += 'x'.repeat(Math.floor(amount)); }
    }
    // Use multibyte content to create the exact byte margin while retaining field limits.
    let remaining = STORE_LIMITS.stateBytes - Buffer.byteLength(JSON.stringify(aggregate)) - 1000;
    for (const s of aggregate.sessions.slice(0, 4)) for (const item of s.entries) {
      const count = Math.min(Math.floor(remaining / 2), item.content.length);
      if (count > 0) { item.content = '€'.repeat(count) + item.content.slice(count); remaining -= count * 2; }
    }
    await fs.writeFile(filename, JSON.stringify(aggregate));
    await expect(store.addDossierEntry({ ...entry(extra), content: 'x'.repeat(STORE_LIMITS.content) })).rejects.toMatchObject({ code: 'limit' });
    expect(createHash('sha256').update(await fs.readFile(filename)).digest('hex')).toBe(createHash('sha256').update(JSON.stringify(aggregate)).digest('hex'));
    expect(space).toBeGreaterThan(0);
  });
});
