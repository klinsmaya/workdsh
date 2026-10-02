import { createHash } from 'node:crypto'
import { accountNamespace } from './desktop-auth.ts'

export interface BrokerCredentials {
  accessToken(signal?: AbortSignal): Promise<string>
}
export interface EnterpriseProject { readonly id: string; readonly organizationId: string; readonly name: string }
export interface SourceRef { readonly materialId: string; readonly revisionId: string; readonly sha256: string }
export interface MaterialRevision extends SourceRef { readonly text: string }
export interface RunAuthorization {
  readonly contractVersion: 'afos.run.v1'
  readonly runId: string
  readonly attempt: number
  readonly binding: { readonly issuer: string; readonly subject: string; readonly organizationId: string; readonly deviceId: string }
  readonly projectId: string
  readonly releaseId: string
  readonly policyRevision: string
  readonly inputRefs: readonly SourceRef[]
  readonly allowedActions: readonly string[]
  readonly issuedAt: string
  readonly expiresAt: string
}
export interface ArchiveReceipt {
  readonly contractVersion: 'afos.receipt.v1'
  readonly receiptId: string
  readonly runId: string
  readonly attempt: number
  readonly artifactId: string
  readonly revisionId: string
  readonly sha256: string
  readonly committedAt: string
}
export type ReceiptStatus = { readonly status: 'archived'; readonly receipt: ArchiveReceipt }
  | { readonly status: 'authorized' | 'expired'; readonly runId: string; readonly clientExecution: 'unknown' }

export class EnterpriseBrokerError extends Error {
  constructor(readonly code: string, readonly outcomeUnknown = false) { super(code) }
}
const MAX_BYTES = 1_048_576
const allowedRunActions = ['materials.readRevision', 'artifacts.stageUpload', 'artifacts.commitDraft', 'runs.getReceipt']
function fail(code: string): never { throw new EnterpriseBrokerError(code) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('broker/invalid-response')
  return value as Record<string, unknown>
}
function id(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f]/u.test(value)) fail('broker/invalid-id')
  return value
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('broker/invalid-hash')
  return value
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('broker/invalid-time')
  return value
}
function source(value: unknown): SourceRef {
  const ref = object(value)
  return Object.freeze({ materialId: id(ref.materialId), revisionId: id(ref.revisionId), sha256: hash(ref.sha256) })
}
function sameSources(left: readonly SourceRef[], right: readonly SourceRef[]): boolean {
  const canonical = (refs: readonly SourceRef[]) => JSON.stringify(refs.map(ref => [ref.materialId, ref.revisionId, ref.sha256]).sort())
  return canonical(left) === canonical(right)
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) fail('broker/empty-response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      // JSON escaping can expand a bounded text revision sixfold.
      if (size > 7 * MAX_BYTES) fail('broker/response-too-large')
      chunks.push(chunk.value)
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
  } finally { await reader.cancel().catch(() => undefined) }
}

/** Trusted Desktop Main caller only. Never expose this instance or tokens to IPC/tools. */
export class EnterpriseBroker {
  private readonly endpoint: string
  private generation = 0
  private lifetime = new AbortController()
  private subject: string | undefined
  private project: EnterpriseProject | undefined
  private readonly revisions = new Map<string, MaterialRevision>()
  private readonly runs = new Map<string, RunAuthorization>()
  private readonly pendingCommits = new Map<string, { sha256: string; clientRequestId: string; reconciled: boolean }>()
  private readonly archiveFlights = new Map<string, { sha256: string; clientRequestId: string }>()
  constructor(
    private readonly issuer: string,
    private readonly credentials: BrokerCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    let url: URL
    try { url = new URL(issuer) } catch { fail('broker/invalid-managed-issuer') }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || issuer.length > 1024) fail('broker/invalid-managed-issuer')
    url.pathname = `${url.pathname.replace(/\/$/u, '')}/afos`
    this.endpoint = url.href
  }
  /** Cut off requests/results before switching accounts; the caller also stops the DSH Host. */
  close(): void {
    this.generation += 1
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.subject = undefined
    this.project = undefined
    this.revisions.clear()
    this.runs.clear()
    this.pendingCommits.clear()
    this.archiveFlights.clear()
  }
  private current(generation: number): void {
    if (generation !== this.generation) fail('broker/account-changed')
  }
  private async request(action: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const generation = this.generation
    const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])])
    let dispatched = false
    let knownDenial = false
    try {
      combined.throwIfAborted()
      const token = await this.credentials.accessToken(combined)
      if (generation !== this.generation || combined.aborted) fail('broker/account-changed')
      dispatched = true
      const response = await this.fetcher(this.endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: combined,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ contractVersion: 'afos.bridge.v1', action, params }),
      })
      const body = await json(response)
      if (generation !== this.generation || combined.aborted) fail('broker/account-changed')
      if (!response.ok) {
        knownDenial = response.status >= 400 && response.status < 500
        const code = typeof body.code === 'string' && /^afos\/[a-z-]{1,80}$/u.test(body.code) ? body.code : 'broker/request-denied'
        throw new EnterpriseBrokerError(code, response.status >= 500 && action === 'artifacts.commitDraft')
      }
      return body
    } catch (error) {
      // A commit might have succeeded before a response, cancellation or account cutover.
      if (action === 'artifacts.commitDraft' && dispatched && !knownDenial) {
        throw new EnterpriseBrokerError('broker/reconcile-required', true)
      }
      if (error instanceof EnterpriseBrokerError) throw error
      throw new EnterpriseBrokerError('broker/request-failed')
    }
  }
  async projects(signal?: AbortSignal): Promise<readonly EnterpriseProject[]> {
    const generation = this.generation
    const result: EnterpriseProject[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const body = await this.request('projects.listAllowed', cursor ? { cursor } : {}, signal)
      this.current(generation)
      if (body.contractVersion !== 'afos.bridge.v1' || !Array.isArray(body.items) || body.items.length > 50) fail('broker/invalid-projects')
      const subject = id(body.principalId)
      if (this.subject && this.subject !== subject) { this.close(); fail('broker/account-changed') }
      this.subject = subject
      for (const value of body.items) {
        const project = object(value)
        result.push(Object.freeze({ id: id(project.id, 128), organizationId: id(project.organizationId), name: id(project.name, 1024) }))
      }
      if (result.length > 2500) fail('broker/project-limit')
      cursor = body.nextCursor === null || body.nextCursor === undefined ? undefined : id(body.nextCursor, 16_384)
      if (cursor && cursors.has(cursor)) fail('broker/repeated-cursor')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return Object.freeze(result)
  }
  async selectProject(projectId: string, signal?: AbortSignal): Promise<EnterpriseProject> {
    this.close()
    const generation = this.generation
    const project = (await this.projects(signal)).find(project => project.id === id(projectId, 128))
    this.current(generation)
    if (!project) fail('broker/project-denied')
    // Changing project discards the previous sources and run handles.
    this.project = project
    this.revisions.clear()
    this.runs.clear()
    return project
  }
  async materials(signal?: AbortSignal): Promise<readonly (SourceRef & { readonly name: string })[]> {
    const generation = this.generation
    if (!this.project) fail('broker/select-project-required')
    const projectId = this.project.id
    const result: (SourceRef & { readonly name: string })[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const body = await this.request('materials.listAllowed', { projectId, ...(cursor ? { cursor } : {}) }, signal)
      this.current(generation)
      if (body.contractVersion !== 'afos.bridge.v1' || !Array.isArray(body.items) || body.items.length > 50) fail('broker/invalid-materials')
      result.push(...body.items.map(value => Object.freeze({ ...source({ ...object(value), materialId: object(value).id }), name: id(object(value).name, 1024) })))
      if (result.length > 2500) fail('broker/material-limit')
      cursor = body.nextCursor === null || body.nextCursor === undefined ? undefined : id(body.nextCursor, 16_384)
      if (cursor && cursors.has(cursor)) fail('broker/repeated-cursor')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return Object.freeze(result)
  }
  async readRevision(ref: SourceRef, signal?: AbortSignal): Promise<MaterialRevision> {
    const generation = this.generation
    const expected = source(ref)
    const available = await this.materials(signal)
    this.current(generation)
    if (!available.some(value => sameSources([value], [expected]))) fail('broker/input-denied')
    const body = await this.request('materials.readRevision', { materialId: expected.materialId, revisionId: expected.revisionId }, signal)
    this.current(generation)
    if (body.contractVersion !== 'afos.bridge.v1' || !sameSources([source(body)], [expected])
      || typeof body.text !== 'string' || Buffer.byteLength(body.text) > MAX_BYTES || digest(body.text) !== expected.sha256) fail('broker/input-integrity')
    const revision = Object.freeze({ ...expected, text: body.text })
    this.revisions.set(JSON.stringify([expected.materialId, expected.revisionId]), revision)
    return revision
  }
  async authorize(releaseId: string, refs: readonly SourceRef[], clientRequestId: string, signal?: AbortSignal): Promise<RunAuthorization> {
    const generation = this.generation
    if (!this.project || !this.subject) fail('broker/select-project-required')
    const inputRefs = refs.map(source)
    if (!inputRefs.length || inputRefs.length > 32 || new Set(inputRefs.map(ref => JSON.stringify([ref.materialId, ref.revisionId]))).size !== inputRefs.length) fail('broker/invalid-inputs')
    for (const ref of inputRefs) {
      const revision = this.revisions.get(JSON.stringify([ref.materialId, ref.revisionId]))
      if (!revision || !sameSources([revision], [ref])) fail('broker/snapshot-required')
    }
    const project = this.project
    const body = await this.request('runs.authorizeLocal', { projectId: project.id, releaseId: id(releaseId, 128), inputRefs, clientRequestId: id(clientRequestId) }, signal)
    this.current(generation)
    const binding = object(body.binding)
    if (body.contractVersion !== 'afos.run.v1' || binding.issuer !== this.issuer || binding.subject !== this.subject || binding.organizationId !== project.organizationId
      || body.projectId !== project.id || body.releaseId !== releaseId || body.attempt !== 1 || !Array.isArray(body.inputRefs)
      || !sameSources(body.inputRefs.map(source), inputRefs) || !Array.isArray(body.allowedActions)
      || body.allowedActions.length < 1 || new Set(body.allowedActions).size !== body.allowedActions.length
      || body.allowedActions.some(value => typeof value !== 'string' || !allowedRunActions.includes(value))) fail('broker/run-binding')
    const issuedAt = timestamp(body.issuedAt)
    const expiresAt = timestamp(body.expiresAt)
    const duration = Date.parse(expiresAt) - Date.parse(issuedAt)
    if (Date.parse(expiresAt) <= Date.now() || Date.parse(issuedAt) > Date.now() + 30_000 || duration <= 0 || duration > 30 * 60_000) fail('broker/run-expired')
    const run: RunAuthorization = Object.freeze({
      contractVersion: 'afos.run.v1', runId: id(body.runId, 128), attempt: 1,
      binding: Object.freeze({ issuer: this.issuer, subject: this.subject, organizationId: project.organizationId, deviceId: id(binding.deviceId) }),
      projectId: project.id, releaseId, policyRevision: id(body.policyRevision, 128), inputRefs: Object.freeze(inputRefs),
      allowedActions: Object.freeze(body.allowedActions as string[]), issuedAt, expiresAt,
    })
    this.runs.set(run.runId, run)
    return run
  }
  namespace(runId: string): string {
    const run = this.run(runId)
    return accountNamespace(run.binding.issuer, run.binding.subject, run.binding.organizationId, run.binding.deviceId)
  }
  private run(runId: string, action?: string): RunAuthorization {
    const run = this.runs.get(id(runId, 128))
    if (!run || !this.project || run.projectId !== this.project.id || run.binding.subject !== this.subject) fail('broker/run-not-owned')
    if (action && (!run.allowedActions.includes(action) || Date.parse(run.expiresAt) <= Date.now())) fail('broker/run-action-denied')
    return run
  }
  private receipt(value: unknown, run: RunAuthorization, expectedHash?: string): ArchiveReceipt {
    const body = object(value)
    if (body.contractVersion !== 'afos.receipt.v1' || body.runId !== run.runId || body.attempt !== run.attempt || expectedHash && body.sha256 !== expectedHash) fail('broker/receipt-mismatch')
    return Object.freeze({ contractVersion: 'afos.receipt.v1', receiptId: id(body.receiptId), runId: run.runId, attempt: run.attempt,
      artifactId: id(body.artifactId), revisionId: id(body.revisionId), sha256: hash(body.sha256), committedAt: timestamp(body.committedAt) })
  }
  async getReceipt(runId: string, signal?: AbortSignal): Promise<ReceiptStatus> {
    const generation = this.generation
    const run = this.run(runId)
    const body = await this.request('runs.getReceipt', { runId: run.runId }, signal)
    this.current(generation)
    if (body.contractVersion !== 'afos.bridge.v1') fail('broker/invalid-receipt-status')
    const pending = this.pendingCommits.get(runId)
    if (body.status === 'archived') {
      const receipt = this.receipt(body.receipt, run, pending?.sha256)
      if (pending) pending.reconciled = true
      return Object.freeze({ status: 'archived', receipt })
    }
    if (!['authorized', 'expired'].includes(String(body.status)) || body.runId !== run.runId || body.clientExecution !== 'unknown') fail('broker/invalid-receipt-status')
    if (pending) pending.reconciled = true
    return Object.freeze({ status: body.status as 'authorized' | 'expired', runId: run.runId, clientExecution: 'unknown' })
  }
  async archiveDraft(runId: string, content: string, clientRequestId: string, signal?: AbortSignal): Promise<ArchiveReceipt> {
    const generation = this.generation
    const run = this.run(runId, 'artifacts.stageUpload')
    this.run(runId, 'artifacts.commitDraft')
    const bytes = Buffer.byteLength(content)
    if (bytes < 1 || bytes > MAX_BYTES) fail('broker/draft-size')
    const sha256 = digest(content)
    const requestId = id(clientRequestId)
    const flight = this.archiveFlights.get(runId)
    if (flight) fail(flight.sha256 === sha256 && flight.clientRequestId === requestId ? 'broker/archive-in-progress' : 'broker/commit-intent-conflict')
    // Preserve the server's whole-envelope limit even for sixfold JSON escaping.
    if (Buffer.byteLength(JSON.stringify({ contractVersion: 'afos.bridge.v1', action: 'artifacts.upload',
      params: { runId, attempt: run.attempt, uploadId: 'x'.repeat(256), content } })) > 1_100_000) fail('broker/draft-transport-size')
    const currentFlight = { sha256, clientRequestId: requestId }
    this.archiveFlights.set(runId, currentFlight)
    try {
      const pending = this.pendingCommits.get(runId)
      if (pending) {
        if (pending.sha256 !== sha256 || pending.clientRequestId !== requestId) fail('broker/commit-intent-conflict')
        if (!pending.reconciled) throw new EnterpriseBrokerError('broker/reconcile-required', true)
        const status = await this.getReceipt(runId, signal)
        this.current(generation)
        if (status.status === 'archived') return status.receipt
      }
      const stage = await this.request('artifacts.stageUpload', { runId, attempt: run.attempt, mime: 'text/plain', bytes, sha256 }, signal)
      this.current(generation)
      if (stage.contractVersion !== 'afos.bridge.v1' || stage.bytes !== bytes || Date.parse(timestamp(stage.expiresAt)) <= Date.now()) fail('broker/invalid-upload')
      const uploadId = id(stage.uploadId)
      const upload = await this.request('artifacts.upload', { runId, attempt: run.attempt, uploadId, content }, signal)
      this.current(generation)
      if (upload.contractVersion !== 'afos.bridge.v1' || upload.uploadId !== uploadId || upload.received !== true) fail('broker/upload-not-received')
      const intent = { sha256, clientRequestId: requestId, reconciled: false }
      this.pendingCommits.set(runId, intent)
      let receipt: Record<string, unknown>
      try {
        receipt = await this.request('artifacts.commitDraft', { runId, attempt: run.attempt, uploadId, inputRefs: run.inputRefs, clientRequestId: requestId }, signal)
      } catch (error) {
        if (error instanceof EnterpriseBrokerError && !error.outcomeUnknown && generation === this.generation && this.pendingCommits.get(runId) === intent) {
          this.pendingCommits.delete(runId)
        }
        throw error
      }
      try {
        this.current(generation)
        const result = this.receipt(receipt, run, sha256)
        this.pendingCommits.get(runId)!.reconciled = true
        return result
      } catch { throw new EnterpriseBrokerError('broker/reconcile-required', true) }
    } finally {
      if (this.archiveFlights.get(runId) === currentFlight) this.archiveFlights.delete(runId)
    }
  }
}
