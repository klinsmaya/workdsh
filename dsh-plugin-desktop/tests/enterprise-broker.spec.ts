import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { EnterpriseBroker, EnterpriseBrokerError } from '../src/enterprise-broker.ts'

const issuer = 'https://enterprise.example/api'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const input = { materialId: 'material-a', revisionId: 'v1', sha256: sha('verified source') }
function fixture(options: { revoked?: boolean; wrongBinding?: boolean; wrongHash?: boolean; lostCommit?: boolean; malformedCommit?: boolean; rawCommit?: 'malformed' | 'denied'; denyCommit?: boolean; credentialFailureBeforeCommit?: boolean; issuedAt?: string; expiresAt?: string; modelBody?: ReadableStream<Uint8Array> } = {}) {
  const calls: string[] = []
  let receipt: Record<string, unknown> | undefined
  let content = ''
  let authorization: Record<string, unknown> | undefined
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(`${issuer}/afos`)
    expect(init?.redirect).toBe('error')
    expect(init?.credentials).toBe('omit')
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer test-access')
    expect(headers.has('X-Role')).toBe(false)
    expect(headers.has('X-Data-Source')).toBe(false)
    const body = JSON.parse(String(init?.body)) as { contractVersion: string; action: string; params: Record<string, unknown> }
    if (body.contractVersion === 'afos.model.v1') return new Response(options.modelBody, { headers: { 'Content-Type': 'text/event-stream' } })
    expect(body.contractVersion).toBe('afos.bridge.v1')
    expect(body.params).not.toHaveProperty('principalId')
    expect(body.params).not.toHaveProperty('organizationId')
    calls.push(body.action)
    if (options.revoked && body.action !== 'projects.listAllowed') return Response.json({ code: 'afos/project-denied' }, { status: 403 })
    if (body.action === 'projects.listAllowed') return Response.json({ contractVersion: 'afos.bridge.v1', principalId: 'user-a', items: [{ id: 'project-a', organizationId: 'org-a', name: 'Allowed', access_token: 'must-not-escape' }], nextCursor: null, refresh_token: 'must-not-escape' })
    if (body.action === 'identity.current') return Response.json({ contractVersion: 'afos.identity.v1',
      binding: { issuer, subject: 'user-a', organizationId: 'org-a', deviceId: 'logical-device-a' },
      project: { id: 'project-a', organizationId: 'org-a', name: 'Allowed' }, permissions: { read: true, archive: true },
      authorizationRevision: sha('current-authority'), expiresAt: new Date(Date.now() + 4_500).toISOString() })
    if (body.action === 'materials.listAllowed') return Response.json({ contractVersion: 'afos.bridge.v1', items: [{ id: input.materialId, revisionId: input.revisionId, sha256: input.sha256, name: 'source' }], nextCursor: null })
    if (body.action === 'materials.readRevision') return Response.json({ contractVersion: 'afos.bridge.v1', ...input, text: options.wrongHash ? 'tampered' : 'verified source' })
    if (body.action === 'runs.authorizeLocal') { authorization = {
      contractVersion: 'afos.run.v1', runId: 'run-a', attempt: 1,
      binding: { issuer, subject: options.wrongBinding ? 'user-b' : 'user-a', organizationId: 'org-a', deviceId: 'logical-device-a' },
      projectId: 'project-a', releaseId: 'release-a', policyRevision: 'policy-v1', inputRefs: [input],
      allowedActions: ['materials.readRevision', 'artifacts.stageUpload', 'artifacts.commitDraft', 'runs.getReceipt', ...(options.modelBody ? ['models.stream'] : [])],
      issuedAt: options.issuedAt ?? new Date().toISOString(), expiresAt: options.expiresAt ?? new Date(Date.now() + 600_000).toISOString(), secret: 'not-returned',
    }; return Response.json(authorization) }
    if (body.action === 'runs.getAuthorization') return Response.json(authorization)
    if (body.action === 'artifacts.stageUpload') return Response.json({ contractVersion: 'afos.bridge.v1', uploadId: 'upload-a', bytes: body.params.bytes, expiresAt: new Date(Date.now() + 300_000).toISOString() })
    if (body.action === 'artifacts.upload') {
      content = String(body.params.content)
      return Response.json({ contractVersion: 'afos.bridge.v1', uploadId: 'upload-a', received: true })
    }
    if (body.action === 'artifacts.commitDraft') {
      if (options.rawCommit) return new Response('<html>fixture</html>', { status: options.rawCommit === 'denied' ? 403 : 200 })
      if (options.denyCommit) return Response.json({ code: 'afos/project-denied' }, { status: 403 })
      receipt = { contractVersion: 'afos.receipt.v1', receiptId: 'receipt-a', runId: 'run-a', attempt: 1, artifactId: 'artifact-a', revisionId: 'draft-v1', sha256: sha(content), committedAt: new Date().toISOString(), hidden: 'not-returned' }
      if (options.lostCommit) throw new Error('network error with private test details')
      if (options.malformedCommit) return Response.json([])
      return Response.json(receipt)
    }
    if (body.action === 'runs.getReceipt') {
      if (body.params.projectId !== 'project-a') return Response.json({ code: 'afos/run-project-mismatch' }, { status: 403 })
      return Response.json(receipt ? { contractVersion: 'afos.bridge.v1', status: 'archived', authorization, receipt } : { contractVersion: 'afos.bridge.v1', status: 'authorized', authorization, runId: 'run-a', clientExecution: 'unknown' })
    }
    throw new Error('Unexpected action')
  }
  const broker = new EnterpriseBroker(issuer, { accessToken: async () => {
    if (options.credentialFailureBeforeCommit && calls.at(-1) === 'artifacts.upload') throw new Error('private credential details')
    return 'test-access'
  } }, fetcher)
  const ready = async () => {
    await broker.selectProject('project-a')
    await broker.readRevision(input)
    return broker.authorize('release-a', [input], 'request-a')
  }
  return { broker, ready, calls, options }
}
function intercept(broker: EnterpriseBroker, after: (action: string) => Promise<void> | void): void {
  const internal = broker as unknown as { request(action: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>> }
  const original = internal.request.bind(internal)
  vi.spyOn(internal, 'request').mockImplementation(async (action, params, signal) => {
    const body = await original(action, params, signal)
    await after(action)
    return body
  })
}

describe('trusted enterprise broker contract', () => {
  it('uses only the fixed gateway, verifies snapshots and returns an actual archive receipt', async () => {
    const f = fixture()
    const projects = await f.broker.projects()
    expect(JSON.stringify(projects)).not.toContain('must-not-escape')
    const run = await f.ready()
    expect(run).not.toHaveProperty('secret')
    expect(f.broker.namespace(run.runId)).toMatch(/^[a-f0-9]{64}$/u)
    expect(await f.broker.getReceipt(run.runId)).toEqual({ status: 'authorized', runId: 'run-a', clientExecution: 'unknown' })
    const receipt = await f.broker.archiveDraft(run.runId, 'editable draft', 'commit-a')
    expect(receipt.sha256).toBe(sha('editable draft'))
    expect(receipt).not.toHaveProperty('hidden')
    expect(await f.broker.getReceipt(run.runId)).toEqual({ status: 'archived', receipt })
    expect(f.calls.slice(-4)).toEqual(['artifacts.stageUpload', 'artifacts.upload', 'artifacts.commitDraft', 'runs.getReceipt'])
  })
  it('requires a verified snapshot and refuses changed identity or source content', async () => {
    const f = fixture()
    await f.broker.selectProject('project-a')
    await expect(f.broker.authorize('release-a', [input], 'request-a')).rejects.toThrow('broker/snapshot-required')
    await expect(fixture({ wrongHash: true }).ready()).rejects.toThrow('broker/input-integrity')
    await expect(fixture({ wrongBinding: true }).ready()).rejects.toThrow('broker/run-binding')
    await expect(f.broker.readRevision({ ...input, materialId: 'forged-other-project' })).rejects.toThrow('broker/input-denied')
  })
  it('rechecks server permissions during archive and distinguishes known rejection from unknown outcome', async () => {
    const f = fixture()
    const run = await f.ready()
    f.options.revoked = true
    await expect(f.broker.archiveDraft(run.runId, 'draft', 'commit-a')).rejects.toThrow('afos/project-denied')
    expect(f.calls).not.toContain('artifacts.commitDraft')
    const rejected = fixture({ denyCommit: true })
    await rejected.ready()
    try { await rejected.broker.archiveDraft('run-a', 'draft', 'commit-a'); throw new Error('must reject') }
    catch (error) { expect(error).toBeInstanceOf(EnterpriseBrokerError); expect((error as EnterpriseBrokerError).outcomeUnknown).toBe(false) }
  })
  it.each([{ lostCommit: true }, { malformedCommit: true }])('queries a durable receipt after an uncertain commit without blind retries: %o', async options => {
    const f = fixture(options)
    await f.ready()
    try { await f.broker.archiveDraft('run-a', 'draft', 'commit-a'); throw new Error('must reject') }
    catch (error) { expect(error).toBeInstanceOf(EnterpriseBrokerError); expect((error as EnterpriseBrokerError).outcomeUnknown).toBe(true) }
    await expect(f.broker.archiveDraft('run-a', 'draft', 'commit-a')).rejects.toThrow('broker/reconcile-required')
    await expect(f.broker.archiveDraft('run-a', 'changed draft', 'commit-a')).rejects.toThrow('broker/commit-intent-conflict')
    const status = await f.broker.getReceipt('run-a')
    expect(status.status).toBe('archived')
    expect((await f.broker.archiveDraft('run-a', 'draft', 'commit-a')).sha256).toBe(sha('draft'))
    expect(f.calls.filter(action => action === 'artifacts.commitDraft')).toHaveLength(1)
  })
  it.each(['denied', 'credential'])('releases a known unsuccessful commit intent before an edited retry: %s', async failure => {
    const f = fixture({ denyCommit: failure === 'denied', credentialFailureBeforeCommit: failure === 'credential' })
    await f.ready()
    try { await f.broker.archiveDraft('run-a', 'draft', 'commit-a'); throw new Error('must reject') }
    catch (error) { expect(error).toBeInstanceOf(EnterpriseBrokerError); expect((error as EnterpriseBrokerError).outcomeUnknown).toBe(false) }
    f.options.denyCommit = false
    f.options.credentialFailureBeforeCommit = false
    expect((await f.broker.archiveDraft('run-a', 'edited draft', 'commit-b')).sha256).toBe(sha('edited draft'))
  })
  it('cuts off old run handles and in-flight results on account/project switch', async () => {
    const f = fixture()
    await f.ready()
    f.broker.close()
    await expect(f.broker.getReceipt('run-a')).rejects.toThrow('broker/run-not-owned')
    let deliver: (response: Response) => void = () => undefined
    const pending = new Promise<Response>(resolve => { deliver = resolve })
    const broker = new EnterpriseBroker(issuer, { accessToken: async () => 'test-access' }, async () => pending)
    const operation = broker.projects()
    await new Promise(resolve => setImmediate(resolve))
    broker.close()
    deliver(Response.json({ contractVersion: 'afos.bridge.v1', principalId: 'user-a', items: [], nextCursor: null }))
    await expect(operation).rejects.toThrow('broker/account-changed')
  })
  it('rejects arbitrary endpoints, unverified run IDs and excessive draft payloads', async () => {
    expect(() => new EnterpriseBroker('http://127.0.0.1/api', { accessToken: async () => 'test' })).toThrow('broker/invalid-managed-issuer')
    const f = fixture()
    await f.ready()
    await expect(f.broker.archiveDraft('forged-run', 'draft', 'key')).rejects.toThrow('broker/run-not-owned')
    await expect(f.broker.archiveDraft('run-a', 'x'.repeat(1_048_577), 'key')).rejects.toThrow('broker/draft-size')
    await expect(f.broker.archiveDraft('run-a', '\u0001'.repeat(200_000), 'key')).rejects.toThrow('broker/draft-transport-size')
    expect(f.calls).not.toContain('artifacts.stageUpload')
  })
  it('rejects non-UTC timestamps and negative authorization duration', async () => {
    await expect(fixture({ issuedAt: '2026-10-02T18:00:00' }).ready()).rejects.toThrow('broker/invalid-time')
    await expect(fixture({ issuedAt: new Date(Date.now() + 10_000).toISOString(), expiresAt: new Date(Date.now() + 5_000).toISOString() }).ready()).rejects.toThrow('broker/run-expired')
  })
  it('cleans credential acquisition errors before they reach a Broker caller', async () => {
    const broker = new EnterpriseBroker(issuer, { accessToken: async () => { throw new Error('private credential details') } })
    try { await broker.projects(); throw new Error('must reject') }
    catch (error) {
      expect(error).toBeInstanceOf(EnterpriseBrokerError)
      expect((error as EnterpriseBrokerError).code).toBe('broker/request-failed')
      expect((error as EnterpriseBrokerError).outcomeUnknown).toBe(false)
      expect(String(error)).not.toContain('private')
    }
  })
  it('cuts off multi-step continuations before old input reads or uploads can resume', async () => {
    const f = fixture()
    await f.broker.selectProject('project-a')
    intercept(f.broker, action => { if (action === 'materials.listAllowed') f.broker.close() })
    await expect(f.broker.readRevision(input)).rejects.toThrow('broker/account-changed')
    expect(f.calls).not.toContain('materials.readRevision')
    const g = fixture()
    await g.ready()
    intercept(g.broker, action => { if (action === 'artifacts.stageUpload') g.broker.close() })
    await expect(g.broker.archiveDraft('run-a', 'draft', 'key')).rejects.toThrow('broker/account-changed')
    expect(g.calls).not.toContain('artifacts.upload')
    const h = fixture()
    await h.ready()
    intercept(h.broker, action => { if (action === 'artifacts.commitDraft') h.broker.close() })
    try { await h.broker.archiveDraft('run-a', 'draft', 'key'); throw new Error('must reject') }
    catch (error) { expect(error).toBeInstanceOf(EnterpriseBrokerError); expect((error as EnterpriseBrokerError).outcomeUnknown).toBe(true) }
  })
  it('locks a run before an asynchronous stage request can accept a second archive intent', async () => {
    const f = fixture()
    await f.ready()
    let release: () => void = () => undefined
    const paused = new Promise<void>(resolve => { release = resolve })
    intercept(f.broker, action => action === 'artifacts.stageUpload' ? paused : undefined)
    const first = f.broker.archiveDraft('run-a', 'draft', 'key')
    await expect(f.broker.archiveDraft('run-a', 'draft', 'key')).rejects.toThrow('broker/archive-in-progress')
    await expect(f.broker.archiveDraft('run-a', 'different', 'other-key')).rejects.toThrow('broker/commit-intent-conflict')
    release()
    expect((await first).sha256).toBe(sha('draft'))
    expect(f.calls.filter(action => action === 'artifacts.stageUpload')).toHaveLength(1)
  })
  it('restores handles only from current server authorization and rejects disk pin forgery', async () => {
    const f = fixture()
    const run = await f.ready()
    await f.broker.selectProject('project-a')
    expect((await f.broker.currentAuthority(run.binding)).binding).toEqual(run.binding)
    await expect(f.broker.restoreRun({ ...run, releaseId: 'different-release' })).rejects.toThrow('broker/run-binding')
    await expect(f.broker.restoreRun({ ...run, binding: { ...run.binding, deviceId: 'other-device' } })).rejects.toThrow('broker/authority-mismatch')
    await expect(f.broker.restoreRun({ ...run, policyRevision: 'changed-policy' })).rejects.toThrow('broker/recovery-binding')
    await expect(f.broker.recoverReceipt({ ...run, policyRevision: 'changed-policy' })).rejects.toThrow('broker/recovery-binding')
    await expect(f.broker.recoverReceipt({ ...run, inputRefs: [{ ...input, sha256: 'a'.repeat(64) }] })).rejects.toThrow('broker/run-binding')
    expect(await f.broker.restoreRun(run)).toEqual(run)
    expect(f.broker.namespace(run.runId)).toMatch(/^[a-f0-9]{64}$/u)
    f.options.revoked = true
    await expect(f.broker.restoreRun(run)).rejects.toThrow('afos/project-denied')
  })
  it('recovers an expired durable receipt without minting a write handle, and returns prior successful archive after expiry', async () => {
    const f = fixture()
    const run = await f.ready()
    const receipt = await f.broker.archiveDraft(run.runId, 'draft', 'key')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(run.expiresAt) + 1)
    try {
      expect(await f.broker.archiveDraft(run.runId, 'draft', 'key')).toEqual(receipt)
      expect(f.calls.filter(action => action === 'artifacts.commitDraft')).toHaveLength(1)
      await f.broker.selectProject('project-a')
      expect(await f.broker.recoverReceipt(run)).toEqual({ status: 'archived', receipt })
      await expect(f.broker.archiveDraft(run.runId, 'draft', 'key')).rejects.toThrow('broker/run-not-owned')
      await expect(f.broker.restoreRun(run)).rejects.toThrow('broker/run-expired')
    } finally { vi.useRealTimers() }
  })
})


describe('model byte lifetime', () => {
  it('ends a pending noncooperative read on broker close even when body cancel never resolves', async () => {
    const modelBody = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => undefined) })
    const f = fixture({ modelBody })
    await f.ready()
    const iterator = f.broker.modelBytes({ contractVersion: 'afos.model.v1', run: { runId: 'run-a', attempt: 1 }, callId: 'call-a', request: { messages: [], maxTokens: 1 } })
    const next = iterator.next()
    await new Promise(resolve => setImmediate(resolve))
    f.broker.close()
    await expect(next).rejects.toThrow('broker/model-cancelled')
  })
  it('ends a pending model read on ordinary caller cancellation', async () => {
    const f = fixture({ modelBody: new ReadableStream<Uint8Array>() })
    await f.ready()
    const controller = new AbortController()
    const next = f.broker.modelBytes({ contractVersion: 'afos.model.v1', run: { runId: 'run-a', attempt: 1 }, callId: 'call-a', request: { messages: [], maxTokens: 1 } }, controller.signal).next()
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await expect(next).rejects.toThrow('broker/model-cancelled')
  })
})


it('cancels noncooperative model fetch admission and disposes a late body', async () => {
  const f = fixture({ modelBody: new ReadableStream<Uint8Array>() })
  await f.ready()
  let deliver: (response: Response) => void = () => undefined
  let disposed = false
  const pending = new Promise<Response>(resolve => { deliver = resolve })
  const internal = f.broker as unknown as { fetcher: typeof fetch }
  internal.fetcher = async () => pending
  const next = f.broker.modelBytes({ contractVersion: 'afos.model.v1', run: { runId: 'run-a', attempt: 1 }, callId: 'call-a', request: { messages: [], maxTokens: 1 } }).next()
  await new Promise(resolve => setImmediate(resolve))
  f.broker.close()
  await expect(next).rejects.toThrow('broker/model-cancelled')
  deliver(new Response(new ReadableStream<Uint8Array>({ cancel: () => { disposed = true } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await new Promise(resolve => setImmediate(resolve))
  expect(disposed).toBe(true)
})

it('cancels noncooperative credential admission without dispatching model fetch', async () => {
  const f = fixture({ modelBody: new ReadableStream<Uint8Array>() })
  await f.ready()
  const internal = f.broker as unknown as { credentials: { accessToken: (signal?: AbortSignal) => Promise<string> } }
  internal.credentials.accessToken = async () => new Promise<string>(() => undefined)
  const next = f.broker.modelBytes({ contractVersion: 'afos.model.v1', run: { runId: 'run-a', attempt: 1 }, callId: 'call-a', request: { messages: [], maxTokens: 1 } }).next()
  await new Promise(resolve => setImmediate(resolve))
  f.broker.close()
  await expect(next).rejects.toThrow('broker/model-cancelled')
})

it.each([
  { status: 200, body: '<html>invalid</html>', expected: 'broker/invalid-response' },
  { status: 200, body: new Uint8Array([0xff]), expected: 'broker/invalid-response' },
  { status: 401, body: '<html>denied</html>', expected: 'broker/request-denied' },
  { status: 403, body: '<html>denied</html>', expected: 'broker/request-denied' },
])('classifies a completed malformed response and known denial: $status / $expected', async ({ status, body, expected }) => {
  const broker = new EnterpriseBroker(issuer, { accessToken: async () => 'test-access' }, async () => new Response(body, { status }))
  await expect(broker.projects()).rejects.toThrow(expected)
})
it('keeps a genuine response body transport failure distinct from completed invalid JSON', async () => {
  const broker = new EnterpriseBroker(issuer, { accessToken: async () => 'test-access' }, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); controller.error(new TypeError('fixture body IO lost')) },
  })))
  await expect(broker.projects()).rejects.toThrow('broker/request-failed')
})

it.each(['malformed', 'denied'] as const)('classifies dispatched commit with malformed body: %s', async rawCommit => {
  const f = fixture({ rawCommit }); await f.ready()
  try { await f.broker.archiveDraft('run-a', 'draft', 'commit-a'); throw new Error('must reject') }
  catch (error) {
    expect(error).toBeInstanceOf(EnterpriseBrokerError)
    expect((error as EnterpriseBrokerError).code).toBe(rawCommit === 'denied' ? 'broker/request-denied' : 'broker/reconcile-required')
    expect((error as EnterpriseBrokerError).outcomeUnknown).toBe(rawCommit !== 'denied')
  }
})
