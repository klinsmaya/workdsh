import { accountNamespace, DesktopAuth, RefreshTokenVault, type EnterpriseAuthConfig } from './desktop-auth.ts'
import { EnterpriseBroker, type CurrentAuthoritySnapshot, type EnterpriseProject, type RunAuthorization, type SourceRef } from './enterprise-broker.ts'
import { EnterpriseRecoveryStore, type DraftRecord, type RecoveryLayout, type RecoveryStoreOptions, type RecoveryTransport } from './enterprise-recovery.ts'

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
  start(layout: RecoveryLayout, authority: CurrentAuthoritySnapshot, signal: AbortSignal): Promise<void>
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
  private lifetime = new AbortController()
  private mutationTail: Promise<unknown> = Promise.resolve()
  private recovery: EnterpriseRecoveryStore | undefined
  private authority: CurrentAuthoritySnapshot | undefined
  private selectedProject: EnterpriseProject | undefined
  private namespace: string | undefined
  private readonly currentLoginVaults = new Set<string>()
  private readonly pendingVaultDeletions = new Set<string>()
  private authorizing = false
  private ready = false
  private readonly runs = new Map<string, RunAuthorization>()
  private readonly snapshots = new Map<string, { readonly text: string } & SourceRef>()
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
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.broker.close()
    this.recovery?.close()
    this.recovery = undefined
    this.authority = undefined
    this.selectedProject = undefined
    this.namespace = undefined
    this.runs.clear()
    this.authorizing = false
    this.ready = false
    this.snapshots.clear()
  }
  private current(generation: number): void { if (generation !== this.generation) fail('account-changed') }
  private mutate<T>(generation: number, work: () => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(async () => { this.current(generation); return work() })
    this.mutationTail = operation.catch(() => undefined)
    return operation
  }
  private signal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]) }
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
      await this.host.stop()
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
      await this.host.stop()
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
      await this.host.stop()
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
    const generation = this.generation
    if (!this.ready || !this.authority || !this.selectedProject) fail('select-project-required')
    try {
      const authority = await this.broker.currentAuthority(this.authority.binding, this.signal(signal))
      this.current(generation)
      if (this.namespace) await this.auth.persistRefresh(this.vault, this.namespace)
      this.current(generation)
      if (Date.parse(authority.expiresAt) <= Date.now()) fail('authority-expired')
      this.authority = authority
      return authority
    } catch (error) {
      if (generation === this.generation && !signal?.aborted) {
        this.cutoff()
        await this.host.stop()
      }
      throw error
    }
  }
  startHost(signal?: AbortSignal): Promise<void> {
    const generation = this.generation
    const combined = this.signal(signal)
    return this.mutate(generation, async () => {
      const authority = await this.currentAuthority(combined)
      const capability = await this.host.capabilities()
      this.current(generation)
      combined.throwIfAborted()
      if (Date.parse(authority.expiresAt) <= Date.now()) fail('authority-expired')
      if (!capability.ingressValidated || capability.sandbox !== 'full') fail('profile-or-sandbox-unverified')
      if (!this.recovery) fail('select-project-required')
      // This owner must publish its process handle before awaiting readiness.
      // Serialize completion/cleanup before a switch can start another Host.
      try { await this.host.start(this.recovery.layout, authority, combined); this.current(generation) }
      catch (error) { await this.host.stop(); throw error }
    })
  }
  async materials(signal?: AbortSignal) {
    const generation = this.generation
    const combined = this.signal(signal)
    await this.currentAuthority(combined)
    this.current(generation)
    const materials = await this.broker.materials(combined)
    this.current(generation)
    return materials
  }
  async readRevision(ref: SourceRef, signal?: AbortSignal) {
    const generation = this.generation
    const combined = this.signal(signal)
    await this.currentAuthority(combined)
    this.current(generation)
    const snapshot = await this.broker.readRevision(ref, combined)
    this.current(generation)
    this.snapshots.set(JSON.stringify([snapshot.materialId, snapshot.revisionId]), snapshot)
    return snapshot
  }
  async authorize(refs: readonly SourceRef[], clientRequestId: string, signal?: AbortSignal): Promise<RunAuthorization> {
    const generation = this.generation
    const combined = this.signal(signal)
    await this.currentAuthority(combined)
    this.current(generation)
    if (this.runs.size || this.authorizing) fail('one-run-at-a-time')
    this.authorizing = true
    try {
      const run = await this.broker.authorize(this.config.releaseId, refs, clientRequestId, combined)
      this.current(generation)
      if (run.policyRevision !== this.config.policyRevision) fail('policy-changed')
      this.runs.set(run.runId, run)
      return run
    } finally { if (generation === this.generation) this.authorizing = false }
  }
  async* modelBytes(request: unknown, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const generation = this.generation
    const combined = this.signal(signal)
    await this.currentAuthority(combined)
    this.current(generation)
    // Broker verifies its private owned run/action map, fixed schema and endpoint again.
    for await (const bytes of this.broker.modelBytes(request, combined)) { this.current(generation); combined.throwIfAborted(); yield bytes }
  }
  async createDraft(runId: string, sessionId: string, content: string, clientRequestId: string, signal?: AbortSignal): Promise<DraftRecord> {
    const run = this.runs.get(runId)
    if (!run || !this.recovery) fail('run-not-owned')
    const inputSnapshots = run.inputRefs.map(ref => {
      const snapshot = this.snapshots.get(JSON.stringify([ref.materialId, ref.revisionId]))
      if (!snapshot || snapshot.sha256 !== ref.sha256) fail('snapshot-required')
      return snapshot
    })
    return this.recovery.createDraft({ run, sessionId, content, clientRequestId, inputSnapshots, generatedAt: new Date().toISOString() }, this.signal(signal))
  }
  /** Explicit trusted user archive; not exported by the model/Host read capability facade. */
  async archiveFromUser(draftId: string, signal?: AbortSignal) {
    if (!this.recovery) fail('select-project-required')
    return this.recovery.archive(draftId, this.signal(signal))
  }
  private recoveryTransport(): RecoveryTransport {
    return {
      assertCurrent: async (binding, projectId, signal) => {
        if (!this.authority || !this.selectedProject || !sameBinding(binding, this.authority.binding) || projectId !== this.selectedProject.id) fail('account-or-project-mismatch')
        await this.currentAuthority(signal)
      },
      validateRun: async (run, signal) => {
        if (run.releaseId !== this.config.releaseId || run.policyRevision !== this.config.policyRevision) fail('release-or-policy-changed')
        return this.broker.restoreRun(run, this.signal(signal))
      },
      getReceipt: (run, signal) => this.broker.recoverReceipt(run, this.signal(signal)),
      archiveDraft: (run, content, key, signal) => this.broker.archiveDraft(run.runId, content, key, this.signal(signal)),
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
      try { await this.host.stop() } catch { stopFailed = true }
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
  suspend(): Promise<void> { this.cutoff(); return this.mutate(this.generation, () => this.host.stop()) }
}
