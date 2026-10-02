import { accountNamespace, DesktopAuth, RefreshTokenVault, type EnterpriseAuthConfig } from './desktop-auth.ts'
import { EnterpriseBroker, EnterpriseBrokerError, type CurrentAuthoritySnapshot, type EnterpriseProject, type RunAuthorization, type SourceRef } from './enterprise-broker.ts'
import { EnterpriseRecoveryStore, type DraftRecord, type OfficialSessionSummaryEvent, type RecoveryLayout, type RecoveryStoreOptions, type RecoveryTransport } from './enterprise-recovery.ts'

/** Private trusted Host callback. Only official Agent setup receives a publication lease. */
export interface EnterpriseSessionBindingLease { commit(): void; dispose(): void }
export interface EnterpriseHostBusinessCapabilities {
  currentAuthority(signal: AbortSignal): Promise<CurrentAuthoritySnapshot>
  localState(): { readonly project: EnterpriseProject; readonly authority: 'current' | 'offline'; readonly lastSyncAt: string }
  authorize(refs: readonly SourceRef[], operationId: string, signal: AbortSignal): Promise<RunAuthorization>
  releaseRunAdmission(runId: string): void
  prepareSessionBinding(runId: string, sessionId: string, signal: AbortSignal): Promise<EnterpriseSessionBindingLease>
  sessionRun(sessionId: string, signal: AbortSignal): Promise<RunAuthorization>
  readPinnedSnapshot(sessionId: string, ref: Pick<SourceRef, 'materialId' | 'revisionId'>, signal: AbortSignal): Promise<SourceRef & { readonly text: string }>
  prepareDraft(sessionId: string, content: string, refs: readonly SourceRef[], signal: AbortSignal): Promise<{ readonly text: string; readonly sources: readonly SourceRef[]; readonly status: 'local-draft' }>
  modelBytes(sessionId: string, request: unknown, signal: AbortSignal): AsyncIterable<Uint8Array>
  projectSessionEvent(sessionId: string, event: OfficialSessionSummaryEvent): void
  /** Only the UI RPC owner receives these; never expose them as Agent tools. */
  drafts(): readonly DraftRecord[]
  editDraft(draftId: string, content: string): DraftRecord
  markCancellation(sessionId: string, stopped: boolean): void
  materials(signal: AbortSignal): ReturnType<EnterpriseMainSession['materials']>
  readRevision(ref: SourceRef, signal: AbortSignal): ReturnType<EnterpriseMainSession['readRevision']>
  archiveFromUser(draftId: string, expectedSha256: string, signal: AbortSignal): ReturnType<EnterpriseMainSession['archiveFromUser']>
}

export interface ManagedDesktopConfig {
  readonly contractVersion: 'afos.desktop-config.v1'
  readonly auth: EnterpriseAuthConfig
  readonly releaseId: string
  readonly policyRevision: string
}
export interface EnterpriseHostLifecycle {
  /** The real Host/process owner must confirm exit before a new namespace may start. */
  stop(): Promise<void>
  capabilities(): Promise<{ readonly ingressValidated: boolean; readonly sandbox: 'full' | 'partial' | 'unavailable' }>
  start(layout: RecoveryLayout, authority: CurrentAuthoritySnapshot, signal: AbortSignal, business: EnterpriseHostBusinessCapabilities): Promise<void>
}
export class EnterpriseMainError extends Error {
  constructor(readonly code: string) { super(code) }
}
function fail(code: string): never { throw new EnterpriseMainError(`enterprise/${code}`) }
function sameBinding(a: RunAuthorization['binding'], b: RunAuthorization['binding']): boolean {
  return a.issuer === b.issuer && a.subject === b.subject && a.organizationId === b.organizationId && a.deviceId === b.deviceId
}
function bounded(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/u.test(value) }

/** Main owns credentials and account lifetime. Host receives only fixed business capabilities. */
export class EnterpriseMainSession {
  private readonly auth: DesktopAuth
  private readonly broker: EnterpriseBroker
  private generation = 0
  private hostGeneration = 0
  private lifetime = new AbortController()
  private execution = new AbortController()
  private mutationTail: Promise<unknown> = Promise.resolve()
  private hostStop: Promise<void> | undefined
  private recovery: EnterpriseRecoveryStore | undefined
  private authority: CurrentAuthoritySnapshot | undefined
  private authoritySyncedAt: string | undefined
  private offline = false
  private selectedProject: EnterpriseProject | undefined
  private namespace: string | undefined
  private readonly currentLoginVaults = new Set<string>()
  private readonly pendingVaultDeletions = new Set<string>()
  private authorizing = false
  private ready = false
  private readonly runs = new Map<string, RunAuthorization>()
  private activeRunId: string | undefined
  private readonly snapshots = new Map<string, { readonly text: string } & SourceRef>()
  private readonly sessionRuns = new Map<string, string>()
  private readonly sessionDrafts = new Map<string, string>()
  private readonly sessionLeases = new Map<string, symbol>()
  constructor(
    private readonly config: ManagedDesktopConfig,
    private readonly base: string,
    private readonly vault: RefreshTokenVault,
    private readonly host: EnterpriseHostLifecycle,
    openBrowser: (url: string) => Promise<void>,
    fetcher: typeof fetch = fetch,
    private readonly recoveryOptions: RecoveryStoreOptions = {},
  ) {
    this.config = Object.freeze({ ...config, auth: Object.freeze({ ...config.auth }) })
    if (config.contractVersion !== 'afos.desktop-config.v1' || !bounded(config.releaseId) || !bounded(config.policyRevision)) fail('managed-config-required')
    const issuer = new URL(config.auth.issuer)
    issuer.pathname = `${issuer.pathname.replace(/\/$/u, '')}/afos`
    if (config.auth.resource !== issuer.href || !/^afos(?: offline_access)?$/u.test(config.auth.scope)) fail('restricted-resource-required')
    this.auth = new DesktopAuth(Object.freeze({ ...config.auth }), openBrowser, fetcher)
    this.broker = new EnterpriseBroker(config.auth.issuer, this.auth, fetcher)
  }
  private cutoff(): void {
    ++this.generation
    ++this.hostGeneration
    this.execution.abort()
    this.execution = new AbortController()
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.broker.close()
    this.recovery?.close()
    this.recovery = undefined
    this.authority = undefined
    this.authoritySyncedAt = undefined
    this.offline = false
    this.selectedProject = undefined
    this.namespace = undefined
    this.runs.clear()
    this.activeRunId = undefined
    this.authorizing = false
    this.ready = false
    this.snapshots.clear()
    this.sessionRuns.clear()
    this.sessionDrafts.clear()
    this.sessionLeases.clear()
  }
  private current(generation: number): void { if (generation !== this.generation) fail('account-changed') }
  private mutate<T>(generation: number, work: () => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(async () => { this.current(generation); return work() })
    this.mutationTail = operation.catch(() => undefined)
    return operation
  }
  private stopHost(): Promise<void> {
    if (this.hostStop) return this.hostStop
    const stop = Promise.resolve().then(() => this.host.stop())
    this.hostStop = stop
    void stop.finally(() => { if (this.hostStop === stop) this.hostStop = undefined }).catch(() => undefined)
    return stop
  }
  private signal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]) }
  private enterprise(): void {
    if (this.offline || this.execution.signal.aborted) fail('offline-restart-required')
  }
  private enterpriseSignal(signal?: AbortSignal): AbortSignal {
    this.enterprise()
    return AbortSignal.any([this.lifetime.signal, this.execution.signal, ...(signal ? [signal] : [])])
  }
  private markOffline(): void {
    this.offline = true
    this.execution.abort(new EnterpriseMainError('enterprise/offline-restart-required'))
  }
  private async prepareVaultNamespace(namespace: string, generation: number, signal: AbortSignal): Promise<void> {
    // A failed old logout must finish before a new credential can reuse this name.
    if (!this.pendingVaultDeletions.has(namespace)) return
    await this.auth.settleCredentialWrites()
    this.current(generation)
    signal.throwIfAborted()
    try { await this.vault.clear(namespace) }
    catch { fail('credential-cleanup-failed') }
    this.current(generation)
    signal.throwIfAborted()
    this.pendingVaultDeletions.delete(namespace)
  }
  /** Native trusted user action only; no Renderer/Agent login IPC. */
  signIn(signal?: AbortSignal): Promise<readonly EnterpriseProject[]> {
    this.cutoff()
    this.auth.logout()
    this.currentLoginVaults.clear()
    const generation = this.generation
    const combined = this.signal(signal)
    return this.mutate(generation, async () => {
      await this.stopHost()
      this.current(generation)
      await this.auth.login(combined)
      this.current(generation)
      const projects = await this.broker.projects(combined)
      this.current(generation)
      return projects
    })
  }
  /** Stop first; never mutate the identity of a running Host. */
  selectProject(projectId: string, signal?: AbortSignal): Promise<CurrentAuthoritySnapshot> {
    this.cutoff()
    const generation = this.generation
    const combined = this.signal(signal)
    return this.mutate(generation, async () => {
      await this.stopHost()
      this.current(generation)
      const project = await this.broker.selectProject(projectId, combined)
      this.current(generation)
      const authority = await this.broker.currentAuthority(undefined, combined)
      this.current(generation)
      this.selectedProject = project
      this.authority = authority
      this.namespace = accountNamespace(authority.binding.issuer, authority.binding.subject, authority.binding.organizationId, authority.binding.deviceId)
      await this.prepareVaultNamespace(this.namespace, generation, combined)
      this.current(generation)
      this.currentLoginVaults.add(this.namespace)
      this.recovery = EnterpriseRecoveryStore.open(this.base, authority.binding, this.recoveryTransport(), this.recoveryOptions)
      await this.auth.persistRefresh(this.vault, this.namespace)
      this.current(generation)
      this.ready = true
      return authority
    })
  }
  /** Restore is explicit and verifies the old binding before opening any namespace. */
  restoreAccount(binding: RunAuthorization['binding'], projectId: string, signal?: AbortSignal): Promise<CurrentAuthoritySnapshot> {
    this.cutoff()
    this.auth.logout()
    this.currentLoginVaults.clear()
    const generation = this.generation
    const combined = this.signal(signal)
    return this.mutate(generation, async () => {
      await this.stopHost()
      this.current(generation)
      if (binding.issuer !== this.config.auth.issuer) fail('account-mismatch')
      const namespace = accountNamespace(binding.issuer, binding.subject, binding.organizationId, binding.deviceId)
      await this.prepareVaultNamespace(namespace, generation, combined)
      this.current(generation)
      if (!await this.auth.restoreRefresh(this.vault, namespace, combined)) fail('sign-in-required')
      this.current(generation)
      try {
        const project = await this.broker.selectProject(projectId, combined)
        const authority = await this.broker.currentAuthority(binding, combined)
        this.current(generation)
        this.selectedProject = project
        this.authority = authority
        this.namespace = namespace
        this.currentLoginVaults.add(namespace)
        this.recovery = EnterpriseRecoveryStore.open(this.base, binding, this.recoveryTransport(), this.recoveryOptions)
        await this.auth.persistRefresh(this.vault, namespace)
        this.current(generation)
        this.ready = true
        return authority
      } catch (error) {
        if (generation === this.generation) { this.cutoff(); this.auth.logout() }
        throw error
      }
    })
  }
  async currentAuthority(signal?: AbortSignal): Promise<CurrentAuthoritySnapshot> {
    return this.readAuthority(signal, false)
  }
  /** Only trusted Main restart may revalidate while old Host capabilities stay offline. */
  private async readAuthority(signal: AbortSignal | undefined, restart: boolean): Promise<CurrentAuthoritySnapshot> {
    const generation = this.generation
    if (!this.ready || !this.authority || !this.selectedProject) fail('select-project-required')
    const combined = restart ? this.signal(signal) : this.enterpriseSignal(signal)
    try {
      const authority = await this.broker.currentAuthority(this.authority.binding, combined)
      this.current(generation); combined.throwIfAborted()
      if (!restart) this.enterprise()
      if (this.namespace) await this.auth.persistRefresh(this.vault, this.namespace)
      this.current(generation); combined.throwIfAborted()
      if (!restart) this.enterprise()
      if (Date.parse(authority.expiresAt) <= Date.now()) fail('authority-expired')
      if (!restart) {
        this.authority = authority
        this.authoritySyncedAt = new Date().toISOString()
      }
      return authority
    } catch (error) {
      // A definite server/credential denial still revokes the account when a
      // concurrent network failure has aborted execution while its body drains.
      // Account generation protects a newly selected subject from old results.
      const definite = error instanceof EnterpriseBrokerError && !['broker/request-failed', 'broker/account-changed'].includes(error.code)
      if (generation === this.generation && (definite || !combined.aborted)) {
        if (error instanceof EnterpriseBrokerError && error.code === 'broker/request-failed') {
          // Keep verified local copies, but synchronously cut off every enterprise
          // execution. Network recovery alone cannot reactivate an old Host.
          this.markOffline()
          throw error
        }
        this.cutoff()
        // Disposal can drain the same Agent task that made this request.
        void this.stopHost().catch(() => undefined)
      }
      throw error
    }
  }
  startHost(signal?: AbortSignal): Promise<void> {
    const generation = this.generation
    const combined = this.signal(signal)
    return this.mutate(generation, async () => {
      const authority = await this.readAuthority(combined, true)
      const capability = await this.host.capabilities()
      this.current(generation)
      combined.throwIfAborted()
      if (Date.parse(authority.expiresAt) <= Date.now()) fail('authority-expired')
      if (!capability.ingressValidated || capability.sandbox !== 'full') fail('profile-or-sandbox-unverified')
      await this.stopHost()
      this.current(generation); combined.throwIfAborted()
      if (Date.parse(authority.expiresAt) <= Date.now()) fail('authority-expired')
      ++this.hostGeneration
      this.execution.abort()
      this.execution = new AbortController()
      this.offline = false
      this.authority = authority
      this.authoritySyncedAt = new Date().toISOString()
      if (!this.recovery) fail('select-project-required')
      // This owner must publish its process handle before awaiting readiness.
      // Serialize completion/cleanup before a switch can start another Host.
      try { await this.host.start(this.recovery.layout, authority, combined, this.hostBusiness(generation)); this.current(generation) }
      catch (error) { await this.stopHost(); throw error }
    })
  }
  async materials(signal?: AbortSignal) {
    const generation = this.generation
    const combined = this.enterpriseSignal(signal)
    await this.currentAuthority(combined)
    this.current(generation); this.enterprise(); combined.throwIfAborted()
    const materials = await this.broker.materials(combined)
    this.current(generation); this.enterprise(); combined.throwIfAborted()
    return materials
  }
  async readRevision(ref: SourceRef, signal?: AbortSignal) {
    const generation = this.generation
    const combined = this.enterpriseSignal(signal)
    await this.currentAuthority(combined)
    this.current(generation); this.enterprise(); combined.throwIfAborted()
    const snapshot = await this.broker.readRevision(ref, combined)
    this.current(generation); this.enterprise(); combined.throwIfAborted()
    this.snapshots.set(JSON.stringify([snapshot.materialId, snapshot.revisionId]), snapshot)
    return snapshot
  }
  async authorize(refs: readonly SourceRef[], clientRequestId: string, signal?: AbortSignal): Promise<RunAuthorization> {
    const generation = this.generation
    const combined = this.enterpriseSignal(signal)
    await this.currentAuthority(combined)
    this.current(generation); this.enterprise(); combined.throwIfAborted()
    if (this.activeRunId || this.authorizing) fail('one-run-at-a-time')
    if (this.runs.size >= 8) fail('run-limit')
    this.authorizing = true
    try {
      const run = await this.broker.authorize(this.config.releaseId, refs, clientRequestId, combined)
      this.current(generation); this.enterprise(); combined.throwIfAborted()
      if (run.policyRevision !== this.config.policyRevision) fail('policy-changed')
      this.runs.set(run.runId, run)
      this.activeRunId = run.runId
      return run
    } finally { if (generation === this.generation) this.authorizing = false }
  }
  async* modelBytes(request: unknown, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const generation = this.generation
    const combined = this.enterpriseSignal(signal)
    await this.currentAuthority(combined)
    this.current(generation); this.enterprise(); combined.throwIfAborted()
    // Broker verifies its private owned run/action map, fixed schema and endpoint again.
    for await (const bytes of this.broker.modelBytes(request, combined)) { this.current(generation); combined.throwIfAborted(); yield bytes }
  }
  async createDraft(runId: string, sessionId: string, content: string, clientRequestId: string, signal?: AbortSignal): Promise<DraftRecord> {
    const combined = this.enterpriseSignal(signal)
    if (this.sessionRuns.get(sessionId) !== runId) fail('session-run-unowned')
    const run = this.runs.get(runId)
    if (!run || !this.recovery) fail('run-not-owned')
    const inputSnapshots = run.inputRefs.map(ref => {
      const snapshot = this.snapshots.get(JSON.stringify([ref.materialId, ref.revisionId]))
      if (!snapshot || snapshot.sha256 !== ref.sha256) fail('snapshot-required')
      return snapshot
    })
    const generation = this.generation
    const draft = await this.recovery.createDraft({ run, sessionId, content, clientRequestId, inputSnapshots, generatedAt: new Date().toISOString() }, combined)
    this.current(generation); this.enterprise(); combined.throwIfAborted()
    this.sessionDrafts.set(sessionId, draft.draftId)
    return draft
  }
  /** A captured account lifetime; Main never exports OAuth or a caller-selected endpoint. */
  private hostBusiness(generation: number): EnterpriseHostBusinessCapabilities {
    const hostGeneration = this.hostGeneration
    const active = () => { this.current(generation); if (hostGeneration !== this.hostGeneration) fail('host-changed'); if (!this.ready || !this.recovery || !this.selectedProject) fail('select-project-required') }
    const activeEnterprise = () => { active(); this.enterprise() }
    const ownDraft = (draftId: string): DraftRecord => {
      active()
      const draft = this.recovery!.list().find(item => item.draftId === draftId && item.run.projectId === this.selectedProject!.id)
      if (!draft) fail('draft-not-owned')
      return draft
    }
    const sessionRun = async (sessionId: string, signal: AbortSignal): Promise<RunAuthorization> => {
      activeEnterprise()
      await this.currentAuthority(this.enterpriseSignal(signal)); activeEnterprise()
      const run = this.runs.get(this.sessionRuns.get(sessionId) ?? '')
      if (!run || run.projectId !== this.selectedProject!.id || Date.parse(run.expiresAt) <= Date.now()) fail('session-run-unowned')
      await this.broker.restoreRun(run, this.enterpriseSignal(signal)); activeEnterprise()
      return run
    }
    return Object.freeze({
      currentAuthority: async (signal: AbortSignal) => { activeEnterprise(); const value = await this.currentAuthority(this.enterpriseSignal(signal)); activeEnterprise(); return value },
      localState: () => {
        active()
        if (!this.authoritySyncedAt) fail('local-state-unavailable')
        return Object.freeze({ project: Object.freeze({ ...this.selectedProject! }), authority: this.offline ? 'offline' as const : 'current' as const, lastSyncAt: this.authoritySyncedAt })
      },
      authorize: async (refs: readonly SourceRef[], operationId: string, signal: AbortSignal) => { activeEnterprise(); const value = await this.authorize(refs, operationId, this.enterpriseSignal(signal)); activeEnterprise(); return value },
      releaseRunAdmission: (runId: string) => {
        active()
        if (!this.runs.has(runId) || this.sessionLeases.has(runId) || [...this.sessionRuns.values()].includes(runId)) fail('run-release-denied')
        if (this.activeRunId === runId) this.activeRunId = undefined
      },
      prepareSessionBinding: async (runId: string, sessionId: string, signal: AbortSignal): Promise<EnterpriseSessionBindingLease> => {
        activeEnterprise()
        if (!bounded(sessionId) || this.sessionRuns.has(sessionId) || this.sessionLeases.has(runId)) fail('session-run-conflict')
        const leaseId = Symbol('afos-session-publication')
        this.sessionLeases.set(runId, leaseId)
        let authority: CurrentAuthoritySnapshot
        try { authority = await this.currentAuthority(this.enterpriseSignal(signal)); activeEnterprise() }
        catch (error) { if (this.sessionLeases.get(runId) === leaseId) this.sessionLeases.delete(runId); throw error }
        const run = this.runs.get(runId)
        if (!run || this.activeRunId !== runId || this.sessionRuns.size || run.projectId !== this.selectedProject!.id) {
          this.sessionLeases.delete(runId); fail('run-not-owned')
        }
        let committed = false, disposed = false
        return Object.freeze({
          commit: () => {
            activeEnterprise(); signal.throwIfAborted()
            if (disposed || committed || this.sessionLeases.get(runId) !== leaseId || this.sessionRuns.size || this.sessionRuns.has(sessionId)
              || this.runs.get(runId) !== run || Date.parse(authority.expiresAt) <= Date.now() || Date.parse(run.expiresAt) <= Date.now()) fail('session-publication-denied')
            this.sessionRuns.set(sessionId, runId); committed = true
          },
          dispose: () => {
            disposed = true
            if (generation === this.generation && this.sessionLeases.get(runId) === leaseId) {
              this.sessionLeases.delete(runId)
              if (this.sessionRuns.get(sessionId) === runId) this.sessionRuns.delete(sessionId)
              if (this.activeRunId === runId) this.activeRunId = undefined
            }
          },
        })
      },
      sessionRun,
      readPinnedSnapshot: async (sessionId: string, ref: Pick<SourceRef, 'materialId' | 'revisionId'>, signal: AbortSignal) => {
        const run = await sessionRun(sessionId, signal)
        const pin = run.inputRefs.find(item => item.materialId === ref.materialId && item.revisionId === ref.revisionId)
        if (!pin) fail('source-not-owned')
        const snapshot = await this.readRevision(pin, this.enterpriseSignal(signal)); activeEnterprise()
        return snapshot
      },
      prepareDraft: async (sessionId: string, content: string, refs: readonly SourceRef[], signal: AbortSignal) => {
        const run = await sessionRun(sessionId, signal)
        if (refs.length !== run.inputRefs.length || refs.some((ref, index) => {
          const pin = run.inputRefs[index]
          return !pin || ref.materialId !== pin.materialId || ref.revisionId !== pin.revisionId || ref.sha256 !== pin.sha256
        })) fail('source-pins-mismatch')
        activeEnterprise(); signal.throwIfAborted()
        const draftId = this.sessionDrafts.get(sessionId)
        if (draftId) { ownDraft(draftId); this.recovery!.editDraft(draftId, content) }
        else await this.createDraft(run.runId, sessionId, content, `draft-${run.runId}-${run.attempt}`, this.enterpriseSignal(signal))
        activeEnterprise(); signal.throwIfAborted()
        return Object.freeze({ text: content, sources: run.inputRefs, status: 'local-draft' as const })
      },
      modelBytes: async function* (this: EnterpriseMainSession, sessionId: string, request: unknown, signal: AbortSignal) {
        const run = await sessionRun(sessionId, signal)
        if (!request || typeof request !== 'object' || Array.isArray(request)) fail('model-run-mismatch')
        const reference = (request as { run?: { runId?: unknown; attempt?: unknown } }).run
        if (reference?.runId !== run.runId || reference.attempt !== run.attempt) fail('model-run-mismatch')
        yield* this.modelBytes(request, this.enterpriseSignal(signal))
      }.bind(this),
      projectSessionEvent: (sessionId: string, event: OfficialSessionSummaryEvent) => {
        active()
        const draftId = this.sessionDrafts.get(sessionId), run = this.runs.get(this.sessionRuns.get(sessionId) ?? '')
        if (draftId && run) this.recovery!.projectSessionEvent(draftId, sessionId, run.runId, run.attempt, event)
      },
      drafts: () => { active(); return this.recovery!.list().filter(item => item.run.projectId === this.selectedProject!.id) },
      editDraft: (draftId: string, content: string) => { ownDraft(draftId); return this.recovery!.editDraft(draftId, content) },
      markCancellation: (sessionId: string, stopped: boolean) => {
        active(); const draftId = this.sessionDrafts.get(sessionId)
        if (!draftId) fail('draft-not-owned')
        ownDraft(draftId); this.recovery!.markCancellation(draftId, stopped)
      },
      materials: async (signal: AbortSignal) => { activeEnterprise(); const value = await this.materials(this.enterpriseSignal(signal)); activeEnterprise(); return value },
      readRevision: async (ref: SourceRef, signal: AbortSignal) => { activeEnterprise(); const value = await this.readRevision(ref, this.enterpriseSignal(signal)); activeEnterprise(); return value },
      archiveFromUser: async (draftId: string, expectedSha256: string, signal: AbortSignal) => {
        activeEnterprise()
        if (!/^[a-f0-9]{64}$/u.test(expectedSha256) || ownDraft(draftId).sha256 !== expectedSha256) fail('draft-confirmation-changed')
        // Recovery captures synchronously, then verifies the same intent again
        // after each authorization/receipt await before dispatching a write.
        const value = await this.archiveFromUser(draftId, this.enterpriseSignal(signal)); activeEnterprise(); return value
      },
    })
  }
  /** Explicit trusted user archive; not exported by the model/Host read capability facade. */
  async archiveFromUser(draftId: string, signal?: AbortSignal) {
    if (!this.recovery) fail('select-project-required')
    return this.recovery.archive(draftId, this.enterpriseSignal(signal))
  }
  private recoveryTransport(): RecoveryTransport {
    return {
      assertCurrent: async (binding, projectId, signal) => {
        this.enterprise()
        if (!this.authority || !this.selectedProject || !sameBinding(binding, this.authority.binding) || projectId !== this.selectedProject.id) fail('account-or-project-mismatch')
        await this.currentAuthority(this.enterpriseSignal(signal)); this.enterprise()
      },
      validateRun: async (run, signal) => {
        this.enterprise()
        if (run.releaseId !== this.config.releaseId || run.policyRevision !== this.config.policyRevision) fail('release-or-policy-changed')
        const value = await this.broker.restoreRun(run, this.enterpriseSignal(signal)); this.enterprise(); return value
      },
      getReceipt: (run, signal) => this.broker.recoverReceipt(run, this.enterpriseSignal(signal)),
      archiveDraft: (run, content, key, signal) => this.broker.archiveDraft(run.runId, content, key, this.enterpriseSignal(signal)),
    }
  }
  /** Synchronous cutoff precedes asynchronous cleanup; preserve drafts and other account vaults. */
  logout(): Promise<void> {
    const namespaces = [...new Set([...this.currentLoginVaults, ...this.pendingVaultDeletions])]
    for (const namespace of namespaces) this.pendingVaultDeletions.add(namespace)
    this.currentLoginVaults.clear()
    this.cutoff()
    this.auth.logout()
    this.namespace = undefined
    // Explicit credential deletion survives a later sign-in request. The queue keeps
    // it before all new Host/login work, so it cannot erase a newly saved credential.
    const cleanup = this.mutationTail.then(async () => {
      await this.auth.settleCredentialWrites()
      let stopFailed = false
      try { await this.stopHost() } catch { stopFailed = true }
      let vaultFailed = false
      for (const namespace of namespaces) {
        try { await this.vault.clear(namespace); this.pendingVaultDeletions.delete(namespace) }
        catch { vaultFailed = true }
      }
      if (stopFailed || vaultFailed) fail(stopFailed && vaultFailed ? 'cleanup-incomplete' : stopFailed ? 'host-stop-failed' : 'credential-cleanup-failed')
    })
    this.mutationTail = cleanup.catch(() => undefined)
    return cleanup
  }
  suspend(): Promise<void> { this.cutoff(); return this.mutate(this.generation, () => this.stopHost()) }
}
