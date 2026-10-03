import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { accountNamespace } from './desktop-auth.ts'
import type { ArchiveReceipt, ReceiptStatus, RunAuthorization, SourceRef } from './enterprise-broker.ts'

export type RecoveryBinding = RunAuthorization['binding']
export type LocalExecutionSummary = 'local_queued' | 'running' | 'cancel_requested' | 'completed_local' | 'failed' | 'interrupted' | 'cancelled'
export interface InputSnapshot extends SourceRef { readonly text: string }
export interface DraftRecord {
  readonly draftId: string
  readonly run: RunAuthorization
  readonly sessionId: string
  readonly generatedAt: string
  readonly updatedAt: string
  readonly content: string
  readonly sha256: string
  readonly inputSnapshots: readonly InputSnapshot[]
  readonly clientRequestId: string
  readonly localExecution: LocalExecutionSummary
  readonly lastSessionSeq: number
  readonly archive: 'local-only' | 'needs-reconciliation' | 'receipt-recorded'
  readonly receipt?: ArchiveReceipt
  readonly lastSyncAt?: string
  readonly predecessor?: { readonly runId: string; readonly attempt: number; readonly draftId: string }
}

/** Trusted Main capabilities, never credentials or arbitrary fetch. Every method rechecks server authority. */
export interface RecoveryTransport {
  assertCurrent(binding: RecoveryBinding, projectId: string, signal: AbortSignal): Promise<void>
  /** Server query must verify current ACL, policy, immutable input/release and device before minting an owned Broker handle. */
  validateRun(run: RunAuthorization, signal: AbortSignal): Promise<RunAuthorization>
  /** Receipt query remains possible for expired runs; must enforce the current account/project ACL. */
  getReceipt(run: RunAuthorization, signal: AbortSignal): Promise<ReceiptStatus>
  archiveDraft(run: RunAuthorization, content: string, clientRequestId: string, signal: AbortSignal): Promise<ArchiveReceipt>
}

/** Pure subset of the official dsh-session 0.1.7-rc.2 SessionEvent envelope. No prompt/error body is retained. */
export interface OfficialSessionSummaryEvent {
  readonly type: 'turn/start' | 'turn/end'
  readonly seq: number
  readonly time: number
  readonly data: { readonly turn: number; readonly reason?: { readonly kind: string } }
}
export interface RecoveryLayout {
  readonly namespace: string
  readonly root: string
  readonly profile: string
  readonly home: string
  readonly cache: string
  readonly outbox: string
}
export interface RecoveryStoreOptions {
  /** POSIX defaults to mode/uid checks. Windows must supply an independently verified native ACL adapter. */
  readonly verifyWindowsAcl?: (paths: readonly string[]) => void
}

export class EnterpriseRecoveryError extends Error {
  constructor(readonly code: string) { super(code) }
}
const MAX_TEXT = 1_048_576
const MAX_DOCUMENT = 8_388_608
const MAX_DRAFTS = 8
const liveStores = new Set<string>()
const runActions = new Set(['materials.readRevision', 'artifacts.stageUpload', 'artifacts.commitDraft', 'runs.getReceipt', 'models.stream'])
const executionStates = new Set(['local_queued', 'running', 'cancel_requested', 'completed_local', 'failed', 'interrupted', 'cancelled'])
function fail(code: string): never { throw new EnterpriseRecoveryError(`recovery/${code}`) }
function present(path: string): boolean {
  try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-record')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid-record')
}
function id(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-id')
  return value
}
/** Private ownership reference, not a path or an arbitrary retained Session query. */
export function isOwnedSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('invalid-number')
  return value
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-time')
  return value
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('invalid-hash')
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_TEXT) fail('text-size')
  return value
}
function binding(value: unknown): RecoveryBinding {
  const b = object(value)
  keys(b, ['issuer', 'subject', 'organizationId', 'deviceId'])
  const issuer = id(b.issuer, 1024)
  let url: URL
  try { url = new URL(issuer) } catch { fail('invalid-issuer') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) fail('invalid-issuer')
  return Object.freeze({ issuer, subject: id(b.subject), organizationId: id(b.organizationId), deviceId: id(b.deviceId) })
}
function sameBinding(a: RecoveryBinding, b: RecoveryBinding): boolean {
  return a.issuer === b.issuer && a.subject === b.subject && a.organizationId === b.organizationId && a.deviceId === b.deviceId
}
function source(value: unknown, snapshot = false): SourceRef | InputSnapshot {
  const v = object(value)
  keys(v, ['materialId', 'revisionId', 'sha256', ...(snapshot ? ['text'] : [])])
  const ref = { materialId: id(v.materialId), revisionId: id(v.revisionId), sha256: hash(v.sha256) }
  if (!snapshot) return Object.freeze(ref)
  const content = text(v.text)
  if (digest(content) !== ref.sha256) fail('snapshot-integrity')
  return Object.freeze({ ...ref, text: content })
}
function pins(refs: readonly SourceRef[]): string {
  return JSON.stringify(refs.map(ref => [ref.materialId, ref.revisionId, ref.sha256]).sort())
}
function run(value: unknown): RunAuthorization {
  const v = object(value)
  keys(v, ['contractVersion', 'runId', 'attempt', 'binding', 'projectId', 'releaseId', 'policyRevision', 'inputRefs', 'allowedActions', 'issuedAt', 'expiresAt'])
  if (v.contractVersion !== 'afos.run.v1' || !Array.isArray(v.inputRefs) || !v.inputRefs.length || v.inputRefs.length > 32
    || !Array.isArray(v.allowedActions) || !v.allowedActions.length || v.allowedActions.some(action => !runActions.has(String(action)))
    || new Set(v.allowedActions).size !== v.allowedActions.length) fail('invalid-run')
  const inputRefs = v.inputRefs.map(ref => source(ref) as SourceRef)
  if (new Set(inputRefs.map(ref => JSON.stringify([ref.materialId, ref.revisionId]))).size !== inputRefs.length) fail('invalid-run')
  const issuedAt = stamp(v.issuedAt), expiresAt = stamp(v.expiresAt)
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > 30 * 60_000) fail('invalid-run')
  return Object.freeze({ contractVersion: 'afos.run.v1', runId: id(v.runId, 128), attempt: integer(v.attempt, 1), binding: binding(v.binding),
    projectId: id(v.projectId, 128), releaseId: id(v.releaseId, 128), policyRevision: id(v.policyRevision, 128),
    inputRefs: Object.freeze(inputRefs), allowedActions: Object.freeze(v.allowedActions.map(action => id(action))), issuedAt, expiresAt })
}
function sameRun(a: RunAuthorization, b: RunAuthorization): boolean {
  return sameBinding(a.binding, b.binding) && a.runId === b.runId && a.attempt === b.attempt && a.projectId === b.projectId
    && a.releaseId === b.releaseId && a.policyRevision === b.policyRevision && pins(a.inputRefs) === pins(b.inputRefs)
    && JSON.stringify([...a.allowedActions].sort()) === JSON.stringify([...b.allowedActions].sort()) && a.issuedAt === b.issuedAt && a.expiresAt === b.expiresAt
}
function receipt(value: unknown, expected: RunAuthorization, expectedHash: string): ArchiveReceipt {
  const v = object(value)
  keys(v, ['contractVersion', 'receiptId', 'runId', 'attempt', 'artifactId', 'revisionId', 'sha256', 'committedAt'])
  if (v.contractVersion !== 'afos.receipt.v1' || v.runId !== expected.runId || v.attempt !== expected.attempt || hash(v.sha256) !== expectedHash) fail('receipt-mismatch')
  return Object.freeze({ contractVersion: 'afos.receipt.v1', receiptId: id(v.receiptId), runId: expected.runId, attempt: expected.attempt,
    artifactId: id(v.artifactId), revisionId: id(v.revisionId), sha256: expectedHash, committedAt: stamp(v.committedAt) })
}
function record(value: unknown, expected: RecoveryBinding): DraftRecord {
  const v = object(value)
  keys(v, ['draftId', 'run', 'sessionId', 'generatedAt', 'updatedAt', 'content', 'sha256', 'inputSnapshots', 'clientRequestId', 'localExecution', 'lastSessionSeq', 'archive'], ['receipt', 'lastSyncAt', 'predecessor'])
  const authorized = run(v.run), content = text(v.content)
  if (!sameBinding(authorized.binding, expected)) fail('account-mismatch')
  if (digest(content) !== hash(v.sha256) || !Array.isArray(v.inputSnapshots) || v.inputSnapshots.length > 32) fail('draft-integrity')
  const inputSnapshots = v.inputSnapshots.map(ref => source(ref, true) as InputSnapshot)
  if (pins(inputSnapshots) !== pins(authorized.inputRefs)) fail('snapshot-binding')
  if (!executionStates.has(String(v.localExecution)) || !['local-only', 'needs-reconciliation', 'receipt-recorded'].includes(String(v.archive))) fail('invalid-record')
  if ((v.archive === 'receipt-recorded') !== (v.receipt !== undefined)) fail('invalid-receipt-state')
  let predecessor: DraftRecord['predecessor']
  if (v.predecessor !== undefined) {
    const p = object(v.predecessor); keys(p, ['runId', 'attempt', 'draftId'])
    predecessor = Object.freeze({ runId: id(p.runId, 128), attempt: integer(p.attempt, 1), draftId: id(p.draftId, 128) })
  }
  return Object.freeze({ draftId: id(v.draftId, 128), run: authorized, sessionId: id(v.sessionId, 128), generatedAt: stamp(v.generatedAt), updatedAt: stamp(v.updatedAt),
    content, sha256: hash(v.sha256), inputSnapshots: Object.freeze(inputSnapshots), clientRequestId: id(v.clientRequestId), localExecution: v.localExecution as LocalExecutionSummary,
    lastSessionSeq: integer(v.lastSessionSeq, -1), archive: v.archive as DraftRecord['archive'],
    ...(v.receipt !== undefined ? { receipt: receipt(v.receipt, authorized, hash(v.sha256)) } : {}),
    ...(v.lastSyncAt !== undefined ? { lastSyncAt: stamp(v.lastSyncAt) } : {}), ...(predecessor ? { predecessor } : {}) })
}

/** Bounded synchronous atomic publication. Single trusted Main owner; this is not a multi-process store or sandbox. */
export class EnterpriseRecoveryStore {
  readonly layout: RecoveryLayout
  readonly binding: RecoveryBinding
  private readonly statePath: string
  private drafts: readonly DraftRecord[] = []
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly flights = new Set<string>()
  private constructor(private readonly base: string, expected: RecoveryBinding, private readonly transport: RecoveryTransport, private readonly options: RecoveryStoreOptions) {
    this.binding = binding(expected)
    const namespace = accountNamespace(this.binding.issuer, this.binding.subject, this.binding.organizationId, this.binding.deviceId)
    const root = join(base, 'afos-accounts', namespace)
    this.layout = Object.freeze({ namespace, root, profile: join(root, 'profile'), home: join(root, 'home'), cache: join(root, 'cache'), outbox: join(root, 'outbox') })
    this.statePath = join(this.layout.outbox, 'drafts.v1.json')
  }
  static open(base: string, expected: RecoveryBinding, transport: RecoveryTransport, options: RecoveryStoreOptions = {}): EnterpriseRecoveryStore {
    if (!isAbsolute(base) || resolve(base) !== base) fail('invalid-base')
    const store = new EnterpriseRecoveryStore(base, expected, transport, options)
    if (liveStores.has(store.layout.root)) fail('already-open')
    store.prepare()
    store.load()
    liveStores.add(store.layout.root)
    return store
  }
  private checkDirectory(path: string, managed: boolean): void {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-directory')
    if (process.platform !== 'win32' && managed && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('directory-permissions')
  }
  private prepare(): void {
    // Inspect every existing ancestor; do not silently resolve a symlink to a different account root.
    const ancestors: string[] = []
    let at = this.base
    while (at !== parse(at).root) { ancestors.unshift(at); at = dirname(at) }
    for (const path of ancestors) this.checkDirectory(path, false)
    if (realpathSync(this.base) !== this.base) fail('unsafe-directory')
    const paths = [join(this.base, 'afos-accounts'), this.layout.root, this.layout.profile, this.layout.home, this.layout.cache, this.layout.outbox]
    if (process.platform === 'win32' && !this.options.verifyWindowsAcl) fail('platform-acl-unverified')
    for (const path of paths) {
      if (!present(path)) mkdirSync(path, { mode: 0o700 })
      this.checkDirectory(path, true)
      // Sync the entire managed chain, including directories retained after a prior failed startup.
      if (process.platform !== 'win32') { this.syncDirectory(path); this.syncDirectory(dirname(path)) }
    }
    if (process.platform === 'win32') this.options.verifyWindowsAcl!(paths)
  }
  private syncDirectory(path: string): void {
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(fd), named = lstatSync(path)
      if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) fail('directory-changed')
      fsyncSync(fd)
    }
    catch (error) { this.close(); throw error }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  private active(): void { if (this.closed || this.lifetime.signal.aborted) fail('closed') }
  private checkedFile(path: string): void {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_DOCUMENT) fail('unsafe-file')
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('file-permissions')
    if (process.platform === 'win32') this.options.verifyWindowsAcl!([path])
  }
  private load(): void {
    if (!present(this.statePath)) return
    this.checkedFile(this.statePath)
    const fd = openSync(this.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let raw: unknown
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_DOCUMENT) fail('unsafe-file')
      if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('file-permissions')
      const named = lstatSync(this.statePath)
      if (stat.dev !== named.dev || stat.ino !== named.ino || !named.isFile() || named.nlink !== 1) fail('file-changed')
      raw = JSON.parse(readFileSync(fd, 'utf8')) as unknown
    } catch (error) { if (error instanceof EnterpriseRecoveryError) throw error; fail('unreadable-state') } finally { closeSync(fd) }
    const value = object(raw); keys(value, ['contractVersion', 'binding', 'drafts'])
    if (value.contractVersion !== 'afos.recovery.v1') fail('unsupported-version')
    if (!sameBinding(binding(value.binding), this.binding)) fail('account-mismatch')
    if (!Array.isArray(value.drafts) || value.drafts.length > MAX_DRAFTS) fail('draft-limit')
    const drafts = value.drafts.map(value => record(value, this.binding))
    if (new Set(drafts.map(draft => draft.draftId)).size !== drafts.length || new Set(drafts.map(draft => draft.clientRequestId)).size !== drafts.length
      || new Set(drafts.map(draft => JSON.stringify([draft.run.runId, draft.run.attempt]))).size !== drafts.length) fail('duplicate-record')
    this.drafts = Object.freeze(drafts)
    // Restart is interruption evidence, not Session continuation. Cancel requests also remain unconfirmed.
    const interrupted = drafts.map(draft => ['running', 'local_queued', 'cancel_requested'].includes(draft.localExecution)
      ? record({ ...draft, localExecution: 'interrupted', updatedAt: new Date().toISOString() }, this.binding) : draft)
    if (interrupted.some((draft, index) => draft !== drafts[index])) this.publish(interrupted)
  }
  private publish(drafts: readonly DraftRecord[]): void {
    this.active(); this.prepare()
    if (drafts.length > MAX_DRAFTS) fail('draft-limit')
    const validated = Object.freeze(drafts.map(draft => record(draft, this.binding)))
    const bytes = Buffer.from(JSON.stringify({ contractVersion: 'afos.recovery.v1', binding: this.binding, drafts: validated }))
    if (bytes.length > MAX_DOCUMENT) fail('storage-size')
    if (present(this.statePath)) this.checkedFile(this.statePath)
    const temp = join(this.layout.outbox, `.drafts-${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined
      this.prepare()
      if (present(this.statePath)) this.checkedFile(this.statePath)
      renameSync(temp, this.statePath)
      // POSIX directory fsync is required before a write intent authorizes dispatch.
      if (process.platform !== 'win32') this.syncDirectory(this.layout.outbox)
      this.drafts = validated
    } catch (error) {
      // If rename succeeded but durability failed, memory must never overwrite a newer disk generation.
      this.close()
      throw error
    } finally { if (fd !== undefined) closeSync(fd); if (present(temp)) unlinkSync(temp) }
  }
  private draft(draftId: string): DraftRecord {
    this.active()
    const draft = this.drafts.find(draft => draft.draftId === id(draftId, 128))
    if (!draft) fail('draft-not-found')
    return draft
  }
  private replace(draft: DraftRecord): void { this.publish(this.drafts.map(current => current.draftId === draft.draftId ? draft : current)) }
  private latestIntent(expected: DraftRecord): DraftRecord {
    const latest = this.draft(expected.draftId)
    if (latest.content !== expected.content || latest.sha256 !== expected.sha256 || latest.clientRequestId !== expected.clientRequestId || !sameRun(latest.run, expected.run)) fail('commit-intent-changed')
    return latest
  }
  private recordReceipt(expected: DraftRecord, confirmed: ArchiveReceipt): void {
    const latest = this.latestIntent(expected)
    this.replace(record({ ...latest, archive: 'receipt-recorded', receipt: confirmed, lastSyncAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, this.binding))
  }
  private signal(signal?: AbortSignal): AbortSignal { this.active(); return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]) }
  private async current(run: RunAuthorization, signal: AbortSignal): Promise<void> {
    this.active(); signal.throwIfAborted()
    if (!sameBinding(run.binding, this.binding)) fail('account-mismatch')
    await this.transport.assertCurrent(this.binding, run.projectId, signal)
    this.active(); signal.throwIfAborted()
  }
  private async validate(runRef: RunAuthorization, signal: AbortSignal): Promise<RunAuthorization> {
    const fresh = run(await this.transport.validateRun(runRef, signal))
    this.active(); signal.throwIfAborted()
    if (!sameRun(fresh, runRef) || !sameBinding(fresh.binding, this.binding)) fail('run-revalidation-mismatch')
    if (Date.parse(fresh.expiresAt) <= Date.now()) fail('run-expired')
    return fresh
  }
  /** Offline view only. A recorded receipt is cached evidence with lastSyncAt, never a fresh authorization. */
  list(): readonly DraftRecord[] { this.active(); return this.drafts }
  /** Derive read ownership only; preserve v1 records and exclude ambiguity across the whole account namespace. */
  ownedSessionDrafts(projectId: string): readonly { readonly sessionId: string; readonly draftId: string }[] {
    this.active(); id(projectId, 128)
    const counts = new Map<string, number>()
    for (const draft of this.drafts) counts.set(draft.sessionId, (counts.get(draft.sessionId) ?? 0) + 1)
    return Object.freeze(this.drafts.filter(draft => draft.run.projectId === projectId && counts.get(draft.sessionId) === 1 && isOwnedSessionId(draft.sessionId))
      .map(draft => Object.freeze({ sessionId: draft.sessionId, draftId: draft.draftId })))
  }
  async createDraft(input: {
    readonly run: RunAuthorization; readonly sessionId: string; readonly content: string; readonly inputSnapshots: readonly InputSnapshot[];
    readonly clientRequestId: string; readonly generatedAt: string; readonly predecessorDraftId?: string
  }, signal?: AbortSignal): Promise<DraftRecord> {
    const combined = this.signal(signal), candidate = run(input.run)
    await this.current(candidate, combined)
    const fresh = await this.validate(candidate, combined)
    await this.current(fresh, combined)
    if (this.drafts.some(draft => draft.clientRequestId === input.clientRequestId)) fail('idempotency-conflict')
    if (this.drafts.some(draft => draft.run.runId === fresh.runId && draft.run.attempt === fresh.attempt)) fail('run-draft-conflict')
    let predecessor: DraftRecord['predecessor']
    if (input.predecessorDraftId) {
      const previous = this.draft(input.predecessorDraftId)
      if (previous.run.projectId !== fresh.projectId || previous.run.releaseId !== fresh.releaseId || pins(previous.run.inputRefs) !== pins(fresh.inputRefs)
        || previous.run.runId === fresh.runId && fresh.attempt <= previous.run.attempt) fail('rerun-binding')
      predecessor = { runId: previous.run.runId, attempt: previous.run.attempt, draftId: previous.draftId }
    }
    const draft = record({ draftId: randomUUID(), run: fresh, sessionId: input.sessionId, generatedAt: input.generatedAt, updatedAt: new Date().toISOString(),
      content: input.content, sha256: digest(input.content), inputSnapshots: input.inputSnapshots, clientRequestId: input.clientRequestId,
      localExecution: 'local_queued', lastSessionSeq: -1, archive: 'local-only', ...(predecessor ? { predecessor } : {}) }, this.binding)
    this.publish([...this.drafts, draft]); return this.draft(draft.draftId)
  }
  /** Main calls this only after its process owner confirms the Host has stopped. */
  interruptAfterHostStop(): void {
    this.active()
    const interrupted = this.drafts.map(draft => ['running', 'local_queued', 'cancel_requested'].includes(draft.localExecution)
      ? record({ ...draft, localExecution: 'interrupted', updatedAt: new Date().toISOString() }, this.binding) : draft)
    if (interrupted.some((draft, index) => draft !== this.drafts[index])) this.publish(interrupted)
  }
  /** Editing an already-owned local copy is available offline. An unresolved or archived intent is immutable. */
  editDraft(draftId: string, content: string): DraftRecord {
    const draft = this.draft(draftId)
    if (draft.archive !== 'local-only' || this.flights.has(draftId)) fail('immutable-commit-intent')
    const updated = record({ ...draft, content: text(content), sha256: digest(content), updatedAt: new Date().toISOString() }, this.binding)
    this.replace(updated); return updated
  }
  /** Invoke only from the trusted official Session subscription, never UI/model-reported events. */
  projectSessionEvent(draftId: string, sessionId: string, runId: string, attempt: number, event: OfficialSessionSummaryEvent): boolean {
    const draft = this.draft(draftId)
    if (draft.sessionId !== sessionId || draft.run.runId !== runId || draft.run.attempt !== attempt) return false
    if (draft.localExecution === 'cancelled') return false
    integer(event.seq); integer(event.time); integer(event.data.turn)
    if (event.seq <= draft.lastSessionSeq) return false
    let localExecution: LocalExecutionSummary
    if (event.type === 'turn/start') localExecution = 'running'
    else if (event.type === 'turn/end') {
      const kind = event.data.reason?.kind
      if (kind === 'completed') localExecution = 'completed_local'
      else if (kind === 'aborted' || kind === 'interrupted' || kind === 'forked') localExecution = 'interrupted'
      else if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') localExecution = 'failed'
      else fail('unsupported-event-reason')
    } else fail('unsupported-event')
    this.replace(record({ ...draft, localExecution, lastSessionSeq: event.seq, updatedAt: new Date().toISOString() }, this.binding))
    return true
  }
  /** Cancelled means the caller has independently confirmed the actual Host/process stop. */
  markCancellation(draftId: string, stopped: boolean): void {
    const draft = this.draft(draftId)
    if (draft.localExecution === 'cancelled') return
    this.replace(record({ ...draft, localExecution: stopped ? 'cancelled' : 'cancel_requested', updatedAt: new Date().toISOString() }, this.binding))
  }
  /** User-invoked reconciliation only; no automatic background replay and no offline new operations. */
  async archive(draftId: string, signal?: AbortSignal): Promise<ArchiveReceipt> {
    const combined = this.signal(signal), draft = this.draft(draftId)
    if (this.flights.has(draftId)) fail('archive-in-progress')
    this.flights.add(draftId)
    try {
      await this.current(draft.run, combined)
      // Always query first, including restart, expired authorization, lost/malformed response and cached receipt.
      const status = await this.transport.getReceipt(draft.run, combined)
      this.active(); combined.throwIfAborted()
      await this.current(draft.run, combined)
      if (status.status === 'archived') {
        const confirmed = receipt(status.receipt, draft.run, draft.sha256)
        this.recordReceipt(draft, confirmed)
        return confirmed
      }
      if (!['authorized', 'expired'].includes(status.status) || status.runId !== draft.run.runId || status.clientExecution !== 'unknown') fail('invalid-receipt-status')
      if (draft.archive === 'receipt-recorded') fail('receipt-disappeared')
      if (status.status === 'expired') fail('run-expired')
      const fresh = await this.validate(draft.run, combined)
      await this.current(fresh, combined)
      if (!fresh.allowedActions.includes('artifacts.stageUpload') || !fresh.allowedActions.includes('artifacts.commitDraft')) fail('archive-not-authorized')
      const latest = this.latestIntent(draft)
      if (latest.localExecution === 'cancel_requested' || latest.localExecution === 'cancelled') fail('cancellation-requested')
      // Durable intent precedes any network write. Any failure remains query-first, even known denial.
      const intent = record({ ...latest, archive: 'needs-reconciliation', updatedAt: new Date().toISOString() }, this.binding)
      this.replace(intent)
      const result = await this.transport.archiveDraft(fresh, intent.content, intent.clientRequestId, combined)
      this.active(); combined.throwIfAborted()
      const confirmed = receipt(result, fresh, intent.sha256)
      this.recordReceipt(intent, confirmed)
      return confirmed
    } finally { this.flights.delete(draftId) }
  }
  /** Cut off old account capabilities before replacing the Host. Retain its isolated files for explicit later recovery. */
  close(): void {
    if (this.closed) return
    this.closed = true; this.lifetime.abort(); liveStores.delete(this.layout.root)
  }
}
