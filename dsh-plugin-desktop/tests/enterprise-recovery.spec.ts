import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchiveReceipt, ReceiptStatus, RunAuthorization } from '../src/enterprise-broker.ts'
import { EnterpriseRecoveryStore } from '../src/enterprise-recovery.ts'
import type { RecoveryBinding, RecoveryTransport } from '../src/enterprise-recovery.ts'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})

const roots: string[] = []
const stores: EnterpriseRecoveryStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync).mockClear()
})
const identity: RecoveryBinding = { issuer: 'https://enterprise.example/api', subject: 'alice', organizationId: 'org-a', deviceId: 'device-a' }
const sourceText = 'Approved generic source'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const source = { materialId: 'material-a', revisionId: 'revision-a', sha256: hash(sourceText) }
function authorization(binding = identity, runId = 'run-a', expired = false): RunAuthorization {
  const time = Date.now() - (expired ? 3_600_000 : 0)
  return { contractVersion: 'afos.run.v1', runId, attempt: 1, binding, projectId: 'project-a', releaseId: 'release-a', policyRevision: 'policy-a',
    inputRefs: [source], allowedActions: ['materials.readRevision', 'artifacts.stageUpload', 'artifacts.commitDraft', 'runs.getReceipt'],
    issuedAt: new Date(time).toISOString(), expiresAt: new Date(time + 1_800_000).toISOString() }
}
function received(run: RunAuthorization, content = 'draft-a'): ArchiveReceipt {
  return { contractVersion: 'afos.receipt.v1', receiptId: 'receipt-a', runId: run.runId, attempt: run.attempt,
    artifactId: 'artifact-a', revisionId: 'draft-revision-a', sha256: hash(content), committedAt: new Date().toISOString() }
}
function fixture(binding = identity, suppliedBase?: string) {
  const base = suppliedBase ?? mkdtempSync(join(tmpdir(), 'afos-recovery-'))
  if (!suppliedBase) roots.push(base)
  const calls: string[] = []
  let current = binding, denied = false, stored: ArchiveReceipt | undefined
  const transport: RecoveryTransport = {
    async assertCurrent(expected, project, signal) {
      signal.throwIfAborted(); calls.push('current')
      expect(project).toBe('project-a')
      if (denied || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('fixture/current-denied')
    },
    async validateRun(run, signal) { signal.throwIfAborted(); calls.push('validate'); return run },
    async getReceipt(run, signal) {
      signal.throwIfAborted(); calls.push('query')
      return stored ? { status: 'archived', receipt: stored } : { status: Date.parse(run.expiresAt) <= Date.now() ? 'expired' : 'authorized', runId: run.runId, clientExecution: 'unknown' }
    },
    async archiveDraft(run, content, key, signal) {
      signal.throwIfAborted(); calls.push('archive')
      expect(key).toBe('archive-a')
      stored = received(run, content); return stored
    },
  }
  const open = () => { const store = EnterpriseRecoveryStore.open(base, binding, transport); stores.push(store); return store }
  return { base, calls, transport, open, deny: () => { denied = true }, switch: (next: RecoveryBinding) => { current = next }, receipt: (next: ArchiveReceipt) => { stored = next } }
}
async function create(store: EnterpriseRecoveryStore, run = authorization(), options: { key?: string; predecessor?: string; content?: string } = {}) {
  return store.createDraft({ run, sessionId: `session-${run.runId}`, content: options.content ?? 'draft-a', inputSnapshots: [{ ...source, text: sourceText }],
    clientRequestId: options.key ?? 'archive-a', generatedAt: new Date().toISOString(), ...(options.predecessor ? { predecessorDraftId: options.predecessor } : {}) })
}
function statePath(store: EnterpriseRecoveryStore): string { return join(store.layout.outbox, 'drafts.v1.json') }

describe('protected account storage', () => {
  it('isolates all four namespace fields and preserves unrelated personal files', async () => {
    const f = fixture(), a = f.open(); await create(a)
    writeFileSync(join(f.base, 'personal.txt'), 'personal-state')
    for (const other of [{ ...identity, subject: 'bob' }, { ...identity, organizationId: 'org-b' }, { ...identity, deviceId: 'device-b' }, { ...identity, issuer: 'https://second.example/api' }]) {
      const b = fixture(other, f.base).open()
      expect(b.layout.namespace).not.toBe(a.layout.namespace); expect(b.list()).toEqual([])
    }
    expect(readFileSync(join(f.base, 'personal.txt'), 'utf8')).toBe('personal-state')
    expect(a.list()).toHaveLength(1)
    if (process.platform !== 'win32') {
      for (const path of [a.layout.root, a.layout.profile, a.layout.home, a.layout.cache, a.layout.outbox]) expect(lstatSync(path).mode & 0o777).toBe(0o700)
      expect(lstatSync(statePath(a)).mode & 0o777).toBe(0o600)
    }
  })
  it('requires one Main owner and releases ownership on close', () => {
    const f = fixture(), a = f.open()
    expect(() => f.open()).toThrow('recovery/already-open')
    a.close(); expect(f.open().layout.namespace).toBe(a.layout.namespace)
  })
  it('syncs every newly created directory and its parent before exposing a store', async () => {
    const f = fixture(), sync = await vi.importActual<typeof import('node:fs')>('node:fs'), observed = new Set<number>()
    vi.mocked(fsyncSync).mockImplementation(fd => { const info = fstatSync(fd); if (info.isDirectory()) observed.add(info.ino); sync.fsyncSync(fd) })
    const a = f.open()
    for (const path of [f.base, join(f.base, 'afos-accounts'), a.layout.root, a.layout.profile, a.layout.home, a.layout.cache, a.layout.outbox]) expect(observed.has(lstatSync(path).ino)).toBe(true)
    expect(f.calls).toEqual([])
  })
  it('does not expose a store or call transport after a startup directory sync failure', () => {
    const f = fixture()
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('fixture/startup-fsync-failed') })
    expect(() => f.open()).toThrow('fixture/startup-fsync-failed'); expect(f.calls).toEqual([])
  })
  it('rejects linked account directories and keeps the linked target untouched', () => {
    const f = fixture(), target = join(f.base, 'outside'); mkdirSync(target)
    symlinkSync(target, join(f.base, 'afos-accounts'), 'dir')
    expect(() => f.open()).toThrow('recovery/unsafe-directory')
    expect(readdirSync(target)).toEqual([])
  })
  it('rejects dangling symlink state and hardlinks without touching their targets', async () => {
    const f = fixture(), a = f.open(); const draft = await create(a), state = statePath(a)
    const target = join(f.base, 'outside.json'); copyFileSync(state, target)
    const bytes = readFileSync(target)
    unlinkSync(state); linkSync(target, state)
    expect(() => a.editDraft(draft.draftId, 'other')).toThrow('recovery/unsafe-file')
    expect(readFileSync(target)).toEqual(bytes)
    unlinkSync(state); symlinkSync(join(f.base, 'missing-target'), state)
    expect(() => a.editDraft(draft.draftId, 'other')).toThrow('recovery/unsafe-file')
    expect(lstatSync(state).isSymbolicLink()).toBe(true)
  })
  it('refuses permissive existing managed directories instead of changing their permissions', () => {
    if (process.platform === 'win32') return
    const f = fixture(); mkdirSync(join(f.base, 'afos-accounts'), { mode: 0o755 }); chmodSync(join(f.base, 'afos-accounts'), 0o755)
    expect(() => f.open()).toThrow('recovery/directory-permissions')
    expect(lstatSync(join(f.base, 'afos-accounts')).mode & 0o777).toBe(0o755)
  })
  it('rejects account transplant, corrupted content and newer schema without overwriting data', async () => {
    const f = fixture(), a = f.open(); await create(a); const path = statePath(a), original = readFileSync(path, 'utf8'); a.close()
    const transplanted = JSON.parse(original); transplanted.binding.subject = 'bob'
    writeFileSync(path, JSON.stringify(transplanted), { mode: 0o600 })
    expect(() => f.open()).toThrow('recovery/account-mismatch')
    const corrupted = JSON.parse(original); corrupted.drafts[0].content = 'tampered'
    writeFileSync(path, JSON.stringify(corrupted), { mode: 0o600 })
    expect(() => f.open()).toThrow('recovery/draft-integrity')
    const newer = JSON.parse(original); newer.contractVersion = 'afos.recovery.v2'
    writeFileSync(path, JSON.stringify(newer), { mode: 0o600 })
    const bytes = readFileSync(path)
    expect(() => f.open()).toThrow('recovery/unsupported-version'); expect(readFileSync(path)).toEqual(bytes)
  })
  it('retains only explicit bounded fields, rejects fake input snapshots and oversize edits', async () => {
    const f = fixture(), a = f.open(), draft = await create(a)
    expect(() => a.editDraft(draft.draftId, 'x'.repeat(1_048_577))).toThrow('recovery/text-size')
    await expect(a.createDraft({ run: authorization(identity, 'another'), sessionId: 'session', generatedAt: new Date().toISOString(),
      content: 'draft', clientRequestId: 'new-key', inputSnapshots: [{ ...source, text: 'not-read' }] })).rejects.toThrow('recovery/snapshot-integrity')
    const raw = readFileSync(statePath(a), 'utf8')
    expect(raw).not.toContain('accessToken'); expect(raw).not.toContain('refreshToken'); expect(raw).not.toContain('Authorization')
    expect(readdirSync(a.layout.outbox)).toEqual(['drafts.v1.json'])
  })
  it('rejects duplicate persisted Run/attempt even when draft IDs and archive keys differ', async () => {
    const f = fixture(), a = f.open(); await create(a); const path = statePath(a); a.close()
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.drafts.push({ ...raw.drafts[0], draftId: 'copied-id', clientRequestId: 'copied-key' })
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 })
    expect(() => f.open()).toThrow('recovery/duplicate-record')
  })
  it('keeps a recoverable copy compatible with the unchanged v1 reader', async () => {
    const f = fixture(), a = f.open(); const original = await create(a), backup = join(f.base, 'backup.json')
    copyFileSync(statePath(a), backup); a.editDraft(original.draftId, 'edited'); a.close()
    copyFileSync(backup, statePath(a)); chmodSync(statePath(a), 0o600)
    const restored = f.open().list()[0]
    expect(restored?.content).toBe(original.content); expect(restored?.run).toEqual(original.run)
    expect(restored?.localExecution).toBe('interrupted')
  })
})

describe('official Session projection and safe rerun', () => {
  it('deduplicates sequence and rejects another Session/run/attempt without changing state', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    const event = { type: 'turn/start' as const, seq: 5, time: Date.now(), data: { turn: 1 } }
    expect(a.projectSessionEvent(d.draftId, d.sessionId, 'old-run', 1, event)).toBe(false)
    expect(a.projectSessionEvent(d.draftId, 'wrong-session', d.run.runId, 1, event)).toBe(false)
    expect(a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 2, event)).toBe(false)
    expect(a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, event)).toBe(true)
    const done = { type: 'turn/end' as const, seq: 9, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }
    expect(a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, done)).toBe(true)
    expect(a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, event)).toBe(false)
    expect(a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, done)).toBe(false)
    expect(a.list()[0]?.localExecution).toBe('completed_local'); expect(a.list()[0]?.archive).toBe('local-only')
    expect(f.calls.filter(call => call === 'archive')).toHaveLength(0)
  })
  it('shows cancellation request/interruption until actual stop is confirmed', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    a.markCancellation(d.draftId, false); expect(a.list()[0]?.localExecution).toBe('cancel_requested')
    a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted' } } })
    expect(a.list()[0]?.localExecution).toBe('interrupted')
    a.markCancellation(d.draftId, true); expect(a.list()[0]?.localExecution).toBe('cancelled')
    expect(a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, { type: 'turn/start', seq: 20, time: Date.now(), data: { turn: 2 } })).toBe(false)
    expect(a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, { type: 'turn/end', seq: 21, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } })).toBe(false)
    a.markCancellation(d.draftId, false); expect(a.list()[0]?.localExecution).toBe('cancelled'); expect(a.list()[0]?.lastSessionSeq).toBe(1)
  })
  it('restarts as interrupted without scheduling work and links a freshly authorized rerun', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
    a.close(); f.calls.length = 0
    const b = f.open(); expect(b.list()[0]?.localExecution).toBe('interrupted'); expect(f.calls).toEqual([])
    const next = await create(b, authorization(identity, 'successor'), { key: 'archive-next', predecessor: d.draftId })
    expect(next.predecessor).toEqual({ runId: d.run.runId, attempt: d.run.attempt, draftId: d.draftId })
    await expect(create(b, { ...authorization(identity, 'invalid-rerun'), releaseId: 'different-release' }, { key: 'invalid-key', predecessor: d.draftId })).rejects.toThrow('recovery/rerun-binding')
    expect(next.archive).toBe('local-only')
  })
})

describe('durable query-first archive', () => {
  it('publishes intent before dispatch and records only a verified server receipt', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    const original = f.transport.archiveDraft
    f.transport.archiveDraft = async (...args) => {
      expect(JSON.parse(readFileSync(statePath(a), 'utf8')).drafts[0].archive).toBe('needs-reconciliation')
      return original(...args)
    }
    f.calls.length = 0; const result = await a.archive(d.draftId)
    expect(f.calls).toEqual(['current', 'query', 'current', 'validate', 'current', 'archive'])
    expect(a.list()[0]?.archive).toBe('receipt-recorded'); expect(a.list()[0]?.receipt).toEqual(result)
    expect(() => a.editDraft(d.draftId, 'changed')).toThrow('recovery/immutable-commit-intent')
  })
  it('refuses dispatch if the write intent cannot be durably published', async () => {
    const f = fixture(), a = f.open(), d = await create(a), previous = readFileSync(statePath(a))
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('fixture/disk-fsync-failed') })
    await expect(a.archive(d.draftId)).rejects.toThrow('fixture/disk-fsync-failed')
    expect(f.calls).not.toContain('archive'); expect(readFileSync(statePath(a))).toEqual(previous)
    expect(readdirSync(a.layout.outbox)).toEqual(['drafts.v1.json']); expect(() => a.list()).toThrow('recovery/closed')
  })
  it('requires reopening after a post-rename durability failure instead of overwriting newer state', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    const sync = await vi.importActual<typeof import('node:fs')>('node:fs')
    let failed = false
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (!failed && fstatSync(fd).isDirectory() && JSON.parse(readFileSync(statePath(a), 'utf8')).drafts[0].archive === 'needs-reconciliation') {
        failed = true; throw new Error('fixture/directory-fsync-failed')
      }
      sync.fsyncSync(fd)
    })
    await expect(a.archive(d.draftId)).rejects.toThrow('fixture/directory-fsync-failed')
    expect(f.calls).not.toContain('archive'); expect(() => a.editDraft(d.draftId, 'unsafe overwrite')).toThrow('recovery/closed')
    expect(JSON.parse(readFileSync(statePath(a), 'utf8')).drafts[0].archive).toBe('needs-reconciliation')
    expect(f.open().list()[0]?.archive).toBe('needs-reconciliation')
  })
  it('merges query and commit responses into the latest official event projection', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    let query: ((status: ReceiptStatus) => void) | undefined, commit: ((receipt: ArchiveReceipt) => void) | undefined
    f.transport.getReceipt = async () => new Promise(resolve => { query = resolve })
    f.transport.archiveDraft = async () => new Promise(resolve => { commit = resolve })
    const pending = a.archive(d.draftId)
    for (let i = 0; i < 10 && !query; i += 1) await Promise.resolve()
    expect(query).toBeDefined()
    a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, { type: 'turn/start', seq: 5, time: Date.now(), data: { turn: 1 } })
    query!({ status: 'authorized', runId: d.run.runId, clientExecution: 'unknown' })
    for (let i = 0; i < 10 && !commit; i += 1) await Promise.resolve()
    expect(commit).toBeDefined(); expect(a.list()[0]?.lastSessionSeq).toBe(5)
    a.projectSessionEvent(d.draftId, d.sessionId, d.run.runId, 1, { type: 'turn/end', seq: 9, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
    commit!(received(d.run)); await pending
    expect(a.list()[0]?.lastSessionSeq).toBe(9); expect(a.list()[0]?.localExecution).toBe('completed_local'); expect(a.list()[0]?.archive).toBe('receipt-recorded')
  })
  it('preserves confirmed cancellation alongside a server commit that already happened', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    let finish: ((receipt: ArchiveReceipt) => void) | undefined
    f.transport.archiveDraft = async () => new Promise(resolve => { finish = resolve })
    const pending = a.archive(d.draftId)
    for (let i = 0; i < 10 && !finish; i += 1) await Promise.resolve()
    expect(finish).toBeDefined(); a.markCancellation(d.draftId, true)
    finish!(received(d.run)); await pending
    expect(a.list()[0]?.localExecution).toBe('cancelled'); expect(a.list()[0]?.archive).toBe('receipt-recorded')
  })
  it('refuses a new archive when cancellation is confirmed while receipt query is pending', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    let query: ((status: ReceiptStatus) => void) | undefined
    f.transport.getReceipt = async () => new Promise(resolve => { query = resolve })
    const pending = a.archive(d.draftId)
    for (let i = 0; i < 10 && !query; i += 1) await Promise.resolve()
    a.markCancellation(d.draftId, true)
    query!({ status: 'authorized', runId: d.run.runId, clientExecution: 'unknown' })
    await expect(pending).rejects.toThrow('recovery/cancellation-requested'); expect(f.calls).not.toContain('archive')
    expect(a.list()[0]?.localExecution).toBe('cancelled'); expect(a.list()[0]?.archive).toBe('local-only')
  })
  it('after a lost response and restart queries the receipt without repeating upload/commit', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    f.transport.archiveDraft = async (run, content) => { f.calls.push('archive'); f.receipt(received(run, content)); throw new Error('fixture/lost-response') }
    await expect(a.archive(d.draftId)).rejects.toThrow('fixture/lost-response')
    expect(a.list()[0]?.archive).toBe('needs-reconciliation'); a.close()
    const b = f.open(); f.calls.length = 0
    const result = await b.archive(d.draftId)
    expect(result.receiptId).toBe('receipt-a'); expect(f.calls).toEqual(['current', 'query', 'current'])
  })
  it('revalidates and uses the same content/key after query confirms no receipt', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    f.transport.archiveDraft = async () => { throw new Error('fixture/network-down') }
    await expect(a.archive(d.draftId)).rejects.toThrow('fixture/network-down'); a.close()
    const b = f.open(); f.calls.length = 0
    f.transport.archiveDraft = async (run, content, key) => { f.calls.push('archive'); expect(content).toBe(d.content); expect(key).toBe(d.clientRequestId); return received(run, content) }
    await b.archive(d.draftId)
    expect(f.calls).toEqual(['current', 'query', 'current', 'validate', 'current', 'archive'])
  })
  it('rejects mismatched receipt and keeps reconciliation intent durable', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    f.transport.archiveDraft = async run => ({ ...received(run), sha256: hash('different') })
    await expect(a.archive(d.draftId)).rejects.toThrow('recovery/receipt-mismatch')
    expect(a.list()[0]?.archive).toBe('needs-reconciliation'); a.close()
    expect(f.open().list()[0]?.archive).toBe('needs-reconciliation')
  })
  it('queries archived receipt for an expired run but refuses an expired new write', async () => {
    const f = fixture(), a = f.open(), d = await create(a), expired = authorization(identity, d.run.runId, true)
    a.close(); const raw = JSON.parse(readFileSync(statePath(a), 'utf8')); raw.drafts[0].run = expired
    writeFileSync(statePath(a), JSON.stringify(raw), { mode: 0o600 }); const b = f.open()
    await expect(b.archive(d.draftId)).rejects.toThrow('recovery/run-expired')
    f.receipt(received(expired)); f.calls.length = 0
    await b.archive(d.draftId); expect(f.calls).toEqual(['current', 'query', 'current'])
  })
  it('refuses server-revalidated changed immutable pins before any upload', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    f.transport.validateRun = async run => ({ ...run, policyRevision: 'new-policy' })
    await expect(a.archive(d.draftId)).rejects.toThrow('recovery/run-revalidation-mismatch')
    expect(a.list()[0]?.archive).toBe('local-only'); expect(f.calls).not.toContain('archive')
  })
  it('denies revoked/current changed identity and allows only already-local editing', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    f.deny(); expect(a.editDraft(d.draftId, 'offline edit').content).toBe('offline edit')
    f.calls.length = 0; await expect(a.archive(d.draftId)).rejects.toThrow('fixture/current-denied')
    await expect(create(a, authorization(identity, 'new-offline'), { key: 'new-offline-key' })).rejects.toThrow('fixture/current-denied')
    expect(f.calls).not.toContain('query'); expect(f.calls).not.toContain('archive')
  })
  it('account cutover aborts an in-flight old operation and never persists its late result', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    let finish: ((receipt: ArchiveReceipt) => void) | undefined
    f.transport.archiveDraft = async (_run, _content, _key, signal) => { expect(signal.aborted).toBe(false); return new Promise(resolve => { finish = resolve }) }
    const pending = a.archive(d.draftId)
    for (let i = 0; i < 10 && !finish; i += 1) await Promise.resolve()
    expect(finish).toBeDefined(); a.close(); f.switch({ ...identity, subject: 'bob' })
    finish!(received(d.run)); await expect(pending).rejects.toThrow('recovery/closed')
    const bob = fixture({ ...identity, subject: 'bob' }, f.base).open(); expect(bob.list()).toEqual([])
    const raw = JSON.parse(readFileSync(statePath(a), 'utf8')); expect(raw.drafts[0].archive).toBe('needs-reconciliation')
  })
  it('coalesces no parallel archive and rejects duplicate run drafts', async () => {
    const f = fixture(), a = f.open(), d = await create(a)
    await expect(create(a, d.run, { key: 'different-key' })).rejects.toThrow('recovery/run-draft-conflict')
    let finish: ((receipt: ArchiveReceipt) => void) | undefined
    f.transport.archiveDraft = async () => new Promise(resolve => { finish = resolve })
    const pending = a.archive(d.draftId)
    for (let i = 0; i < 10 && !finish; i += 1) await Promise.resolve()
    await expect(a.archive(d.draftId)).rejects.toThrow('recovery/archive-in-progress')
    finish!(received(d.run)); await pending
  })
})
