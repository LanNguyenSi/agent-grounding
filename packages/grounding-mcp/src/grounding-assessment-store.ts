/** Producer-owned persistence only. Transport registration and issuer isolation are separate. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, KeyObject, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { decodeReceipt, encodeReceipt, type GroundingReceiptPayload, MAX_WIRE_BYTES } from './grounding-receipt.js';
import {
  ASSESSMENT_POLICY, PHASES, assessSnapshot, bindingMatches, bindingProjection, currentPhase, normalizeKeyword, phasePlan,
  type AssessmentSnapshot, type Binding, type EntryKind, type Phase,
} from './grounding-assessment-policy.js';

export const STORE_LIMITS = Object.freeze({ problem: 8192, content: 8192, source: 1024, entries: 256, sessions: 128, attempts: 256, stateBytes: 8 * 1024 * 1024 });
export class AssessmentStoreError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'not_found' | 'limit' | 'storage', message: string) {
    super(message); this.name = 'AssessmentStoreError';
  }
}
function fail(code: AssessmentStoreError['code'], message: string): never { throw new AssessmentStoreError(code, message); }
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = integer.min(1);
const token = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const digest = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const scalar = (value: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const text = (limit: number, nonempty = true) => z.string().refine((value) => value.length <= limit && scalar(value) && (!nonempty || value.trim().length > 0));
const subject = z.object({ kind: z.literal('task-context/v1'), digest }).strict();
const bindingSchema = z.object({ audience: token, projectId: uuid, taskId: uuid, subject }).strict();
const challengeSchema = z.object({
  audience: token, projectId: uuid, taskId: uuid, attemptId: uuid,
  nonce: z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/).refine((value) => value.length === 43 && Buffer.from(value, 'base64url').toString('base64url') === value),
  contextRevision: revision,
  target: z.object({ workflowId: uuid.nullable(), from: token, to: token, action: token }).strict(), subject,
  policy: z.object({ id: z.literal(ASSESSMENT_POLICY.id), revision: z.literal(ASSESSMENT_POLICY.revision), sha256: z.literal(ASSESSMENT_POLICY.sha256) }).strict(),
  createdAt: integer, expiresAt: integer,
}).strict().refine((value) => value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= 86400);
export type AssessmentChallenge = z.infer<typeof challengeSchema>;
const mutationBase = { sessionId: token, expectedRevision: revision };
const exportSchema = z.object({ ...mutationBase, challenge: challengeSchema }).strict();
export type ExportRequest = z.infer<typeof exportSchema>;
const entrySchema = z.object({ id: uuid, kind: z.enum(['fact', 'hypothesis', 'rejected', 'unknown']), content: text(STORE_LIMITS.content), source: text(STORE_LIMITS.source, false), origin: z.literal('agent_asserted'), revision }).strict();
const snapshotSchema = z.object({
  id: uuid, revision, binding: bindingSchema, keyword: z.string().refine((value) => value.length >= 1 && value.length <= 64 && scalar(value)), problem: text(STORE_LIMITS.problem),
  events: z.array(z.object({ phase: z.enum(PHASES), tools: z.array(token).max(2), origin: z.literal('producer_api_agent_confirmation'), revision }).strict()).max(6),
  entries: z.array(entrySchema).max(STORE_LIMITS.entries),
  claim: z.object({ text: text(STORE_LIMITS.content, false), origin: z.literal('agent_asserted'), revision }).strict().nullable(),
}).strict();
const terminalSchema = z.object({ request: exportSchema, fingerprint: digest, snapshot: snapshotSchema, wire: z.string().max(MAX_WIRE_BYTES) }).strict();
const stateSchema = z.object({ version: z.literal(1), sessions: z.array(snapshotSchema).max(STORE_LIMITS.sessions), terminals: z.array(terminalSchema).max(STORE_LIMITS.attempts) }).strict();
type State = z.infer<typeof stateSchema>;
export interface AssessmentStoreOptions {
  directory: string; issuer: string; kid: string; privateKey: KeyObject;
  producer: GroundingReceiptPayload['producer'];
  /** Trusted producer clock, returning epoch seconds. Never a mutation argument. */
  clock?: () => number;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) fail('invalid', 'Invalid assessment input');
  return result.data;
}
function challengeProjection(challenge: AssessmentChallenge): AssessmentChallenge {
  return {
    ...bindingProjection(challenge), attemptId: challenge.attemptId, nonce: challenge.nonce, contextRevision: challenge.contextRevision,
    target: { workflowId: challenge.target.workflowId, from: challenge.target.from, to: challenge.target.to, action: challenge.target.action },
    policy: { ...ASSESSMENT_POLICY }, createdAt: challenge.createdAt, expiresAt: challenge.expiresAt,
  };
}
function fingerprint(request: ExportRequest): string {
  return createHash('sha256').update(JSON.stringify({ sessionId: request.sessionId, expectedRevision: request.expectedRevision, challenge: challengeProjection(request.challenge) })).digest('hex');
}
function checkSnapshot(snapshot: AssessmentSnapshot): void {
  const plan = phasePlan(snapshot.keyword);
  let previous = 1;
  for (const [i, event] of snapshot.events.entries()) {
    if (event.phase !== plan[i]?.phase || JSON.stringify(event.tools) !== JSON.stringify(plan[i]?.tools) || event.revision <= previous || event.revision > snapshot.revision) fail('storage', 'Invalid completion history');
    previous = event.revision;
  }
  const revisions = [...snapshot.events, ...snapshot.entries, ...(snapshot.claim ? [snapshot.claim] : [])].map((item) => item.revision);
  if (new Set(revisions).size !== revisions.length || revisions.some((value) => value <= 1 || value > snapshot.revision) || new Set(snapshot.entries.map((entry) => entry.id)).size !== snapshot.entries.length) fail('storage', 'Invalid dossier history');
}
function checkState(state: State): void {
  if (new Set(state.sessions.map((session) => session.id)).size !== state.sessions.length || new Set(state.terminals.map((terminal) => terminal.request.challenge.attemptId)).size !== state.terminals.length) fail('storage', 'Duplicate state identity');
  state.sessions.forEach(checkSnapshot);
  for (const terminal of state.terminals) {
    checkSnapshot(terminal.snapshot);
    const { request, snapshot } = terminal;
    if (terminal.fingerprint !== fingerprint(request) || snapshot.id !== request.sessionId || snapshot.revision !== request.expectedRevision || !bindingMatches(snapshot.binding, request.challenge)) fail('storage', 'Invalid terminal snapshot');
    const payload = decodeReceipt(terminal.wire).payload;
    const context = challengeProjection(request.challenge);
    if (payload.session.id !== snapshot.id || payload.session.revision !== snapshot.revision || !bindingMatches(payload, context) || payload.attemptId !== context.attemptId || payload.nonce !== context.nonce || payload.contextRevision !== context.contextRevision || JSON.stringify(payload.target) !== JSON.stringify(context.target) || payload.expiresAt > context.expiresAt || JSON.stringify(payload.assessment) !== JSON.stringify(assessSnapshot(snapshot, { sessionId: snapshot.id, revision: snapshot.revision, binding: snapshot.binding }))) fail('storage', 'Invalid terminal receipt');
  }
}

export class GroundingAssessmentStore {
  #directory: string;
  #issuer: string;
  #kid: string;
  #key: KeyObject;
  #producer: GroundingReceiptPayload['producer'];
  #clock: () => number;

  constructor(options: AssessmentStoreOptions) {
    if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) fail('invalid', 'Explicit absolute producer directory required');
    if (!(options.privateKey instanceof KeyObject) || options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519') fail('invalid', 'Explicit Ed25519 private key required');
    this.#directory = path.resolve(options.directory);
    this.#issuer = parse(token, options.issuer); this.#kid = parse(token, options.kid); this.#key = options.privateKey;
    this.#producer = parse(z.object({ name: token, version: token, policyBuild: token }).strict(), options.producer);
    this.#clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    if (typeof this.#clock !== 'function') fail('invalid', 'Invalid producer clock');
  }

  #now(): number { return parse(integer, this.#clock()); }
  #fresh(challenge: AssessmentChallenge): number {
    const now = this.#now();
    if (challenge.createdAt - now > 60 || challenge.expiresAt <= now) fail('invalid', 'Challenge is not current');
    return now;
  }

  async #read(directory: string): Promise<State> {
    let handle;
    try { handle = await fs.open(path.join(directory, 'state.json'), 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: [], terminals: [] }; throw error; }
    try {
      const size = (await handle.stat()).size;
      if (size > STORE_LIMITS.stateBytes) fail('storage', 'State exceeds byte limit');
      const bytes = Buffer.alloc(size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length !== size) fail('storage', 'State size changed while reading');
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      const decoded: unknown = JSON.parse(raw);
      if (JSON.stringify(decoded) !== raw) fail('storage', 'Noncanonical state');
      const state = stateSchema.parse(decoded);
      checkState(state);
      return state;
    } finally { await handle.close(); }
  }

  async #write(directory: string, state: State, owned: () => Promise<void>): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(state));
    if (bytes.length > STORE_LIMITS.stateBytes) fail('limit', 'State capacity exceeded');
    const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close(); handle = undefined;
      await owned();
      await fs.rename(temporary, path.join(directory, 'state.json'));
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      await owned();
    } finally {
      try { if (handle) await handle.close(); }
      finally { await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    }
  }

  async #transaction<T>(operation: (state: State) => { result: T; changed: boolean }): Promise<T> {
    try {
      await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const directory = await fs.realpath(this.#directory);
      const target = path.join(directory, 'store');
      const handle = await fs.open(target, 'a', 0o600); await handle.close();
      let compromised: Error | undefined;
      const release = await lockfile.lock(target, { stale: Infinity, update: 2000, retries: { retries: 400, minTimeout: 10, maxTimeout: 50, factor: 1.2 }, onCompromised: (error) => { compromised = error; } });
      try {
        const identity = await fs.stat(`${target}.lock`);
        const owned = async (): Promise<void> => {
          if (compromised) throw compromised;
          const current = await fs.stat(`${target}.lock`);
          if (identity.ino !== current.ino || identity.dev !== current.dev || compromised) fail('storage', 'Store lock ownership lost');
        };
        await owned();
        for (const name of await fs.readdir(directory)) {
          if (/^\.state-[0-9a-f-]{36}\.tmp$/.test(name)) await fs.unlink(path.join(directory, name));
        }
        const state = await this.#read(directory);
        const { result, changed } = operation(state);
        await owned();
        if (changed) await this.#write(directory, state, owned);
        return structuredClone(result);
      } finally { await release(); }
    } catch (error) {
      if (error instanceof AssessmentStoreError) throw error;
      fail('storage', 'Assessment storage transaction failed');
    }
  }

  #session(state: State, request: { sessionId: string; expectedRevision: number }): AssessmentSnapshot {
    const session = state.sessions.find((item) => item.id === request.sessionId);
    if (!session) fail('not_found', 'Unknown producer session');
    if (session.revision !== request.expectedRevision) fail('conflict', 'Session revision conflict');
    return session;
  }
  #increment(session: AssessmentSnapshot): number {
    if (session.revision === Number.MAX_SAFE_INTEGER) fail('limit', 'Session revision exhausted');
    session.revision += 1;
    return session.revision;
  }

  async createSession(input: { challenge: AssessmentChallenge; keyword: string; problem: string }): Promise<AssessmentSnapshot> {
    const request = parse(z.object({ challenge: challengeSchema, keyword: z.string().refine((value) => value.length >= 1 && value.length <= 64 && scalar(value)), problem: text(STORE_LIMITS.problem) }).strict(), input);
    normalizeKeyword(request.keyword);
    return this.#transaction((state) => {
      this.#fresh(request.challenge);
      if (state.sessions.length >= STORE_LIMITS.sessions) fail('limit', 'Session capacity exceeded');
      const session: AssessmentSnapshot = { id: randomUUID(), revision: 1, binding: bindingProjection(request.challenge), keyword: request.keyword, problem: request.problem, events: [], entries: [], claim: null };
      state.sessions.push(session);
      return { result: session, changed: true };
    });
  }

  async getSession(input: { sessionId: string }): Promise<AssessmentSnapshot & { currentPhase: Phase }> {
    const request = parse(z.object({ sessionId: token }).strict(), input);
    return this.#transaction((state) => {
      const session = state.sessions.find((item) => item.id === request.sessionId);
      if (!session) fail('not_found', 'Unknown producer session');
      return { result: { ...session, currentPhase: currentPhase(session) }, changed: false };
    });
  }

  async advance(input: { sessionId: string; expectedRevision: number; expectedPhase: Phase }): Promise<AssessmentSnapshot> {
    const request = parse(z.object({ ...mutationBase, expectedPhase: z.enum(PHASES) }).strict(), input);
    return this.#transaction((state) => {
      const session = this.#session(state, request);
      if (currentPhase(session) !== request.expectedPhase) fail('conflict', 'Current phase conflict');
      const step = phasePlan(session.keyword)[session.events.length];
      if (!step) return { result: session, changed: false };
      session.events.push({ ...step, origin: 'producer_api_agent_confirmation', revision: this.#increment(session) });
      return { result: session, changed: true };
    });
  }

  async addDossierEntry(input: { sessionId: string; expectedRevision: number; kind: EntryKind; content: string; source: string }): Promise<AssessmentSnapshot> {
    const request = parse(z.object({ ...mutationBase, kind: entrySchema.shape.kind, content: entrySchema.shape.content, source: entrySchema.shape.source }).strict(), input);
    return this.#transaction((state) => {
      const session = this.#session(state, request);
      if (session.entries.length >= STORE_LIMITS.entries) fail('limit', 'Dossier capacity exceeded');
      session.entries.push({ id: randomUUID(), kind: request.kind, content: request.content, source: request.source, origin: 'agent_asserted', revision: this.#increment(session) });
      return { result: session, changed: true };
    });
  }

  async setClaim(input: { sessionId: string; expectedRevision: number; text: string }): Promise<AssessmentSnapshot> {
    const request = parse(z.object({ ...mutationBase, text: text(STORE_LIMITS.content, false) }).strict(), input);
    return this.#transaction((state) => {
      const session = this.#session(state, request);
      if (session.claim?.text === request.text) return { result: session, changed: false };
      session.claim = { text: request.text, origin: 'agent_asserted', revision: this.#increment(session) };
      return { result: session, changed: true };
    });
  }

  async exportReceipt(input: ExportRequest): Promise<Uint8Array> {
    // Zod detaches all nested caller data before the first asynchronous boundary.
    const request = parse(exportSchema, input);
    return this.#transaction((state) => {
      const requestFingerprint = fingerprint(request);
      const terminal = state.terminals.find((item) => item.request.challenge.attemptId === request.challenge.attemptId);
      if (terminal) {
        if (terminal.fingerprint !== requestFingerprint) fail('conflict', 'Attempt already assessed with different input');
        return { result: Buffer.from(terminal.wire, 'utf8'), changed: false };
      }
      const session = this.#session(state, request);
      if (!bindingMatches(session.binding, request.challenge)) fail('conflict', 'Immutable session binding mismatch');
      const evaluatedAt = this.#fresh(request.challenge);
      if (state.terminals.length >= STORE_LIMITS.attempts) fail('limit', 'Attempt capacity exceeded');
      const assessment = assessSnapshot(session, { sessionId: request.sessionId, revision: request.expectedRevision, binding: request.challenge });
      const payload: GroundingReceiptPayload = {
        schemaVersion: 1, receiptId: randomUUID(), audience: request.challenge.audience, projectId: request.challenge.projectId, taskId: request.challenge.taskId,
        attemptId: request.challenge.attemptId, nonce: request.challenge.nonce, contextRevision: request.challenge.contextRevision,
        target: request.challenge.target, subject: request.challenge.subject, policy: { ...ASSESSMENT_POLICY }, session: { id: session.id, revision: session.revision }, assessment,
        evaluatedAt, issuedAt: evaluatedAt, expiresAt: Math.min(request.challenge.expiresAt, evaluatedAt + Math.min(900, Number.MAX_SAFE_INTEGER - evaluatedAt)), producer: this.#producer,
      };
      const wire = encodeReceipt(payload, this.#issuer, this.#kid, this.#key);
      state.terminals.push({ request, fingerprint: requestFingerprint, snapshot: structuredClone(session), wire: Buffer.from(wire).toString('utf8') });
      return { result: wire, changed: true };
    });
  }
}
