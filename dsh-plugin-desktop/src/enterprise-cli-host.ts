import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CurrentAuthoritySnapshot } from './enterprise-broker.ts'
import type { EnterpriseHostBusinessCapabilities, EnterpriseHostLifecycle } from './enterprise-main.ts'
import type { RecoveryLayout } from './enterprise-recovery.ts'
import { RuntimeLogFilter, runtimeEnvironment, stopRuntimeTree } from './runtime-security.ts'
import type { MainCallerRequest, MainCallerPermit } from './enterprise-caller-proof.ts'

/** Main-private port-zero readiness. Never return this object through Renderer IPC. */
export interface EnterpriseCliReady { readonly host: '127.0.0.1'; readonly port: number; readonly authenticatedUrl: string; readonly signal: AbortSignal }
export interface EnterpriseCallerIssuer { assertRequest(request: MainCallerRequest, signal: AbortSignal): Promise<MainCallerPermit> }

interface ModelPolicy { readonly provider: string; readonly model: string; readonly maxTokens: number; readonly maxRequestBytes?: number }
interface Endpoint {
  send(message: object): Promise<void>
  messages(listener: (message: unknown) => void): () => void
  disconnected(listener: () => void): () => void
}
interface Attachment { readonly generation: string; close(): Promise<void> }
interface PublicProfileExports {
  managedCliProfilePatch(options: { root: string; binding: CurrentAuthoritySnapshot['binding']; model: ModelPolicy; signal: AbortSignal; nativeCaller?: true; frontendIndex?: string }): unknown
}
interface PublicIpcExports {
  attachMainBusinessIpc(endpoint: Endpoint, business: EnterpriseHostBusinessCapabilities, signal: AbortSignal,
    bootstrap: { root: string; model: ModelPolicy }, callerIssuer?: EnterpriseCallerIssuer,
    online?: { frontendIndex: string; onReady(ready: Omit<EnterpriseCliReady, 'signal'>): void }): Promise<Attachment>
}
/** Main-only trusted runtime/configuration, never a Renderer DTO or plugin selector. */
export interface EnterpriseCliHostOptions {
  readonly executable: string
  readonly runtimeProfile: string
  readonly model: ModelPolicy
  readonly writeLog?: (text: string) => void
  /** Main-private notification after real readiness; never a child-reported state. */
  readonly onUnexpectedStop?: () => Promise<void>
  readonly callerIssuer?: EnterpriseCallerIssuer
  readonly online?: { readonly frontendIndex: string; readonly onReady: (ready: EnterpriseCliReady) => Promise<void> }
}
interface OwnedChild {
  readonly lifetime: AbortController
  readonly prepared: Promise<void>
  readonly preparationDone: () => void
  readonly signal: AbortSignal
  home?: string
  child?: ChildProcess
  attachment?: Attachment
  stopping?: Promise<void>
  releaseCutoff?: () => void
  ready?: boolean
  unexpectedReported?: boolean
}
export class EnterpriseCliHostError extends Error {
  constructor() { super('enterprise/cli-host-refused') }
}
function refused(): never { throw new EnterpriseCliHostError() }
function checkPath(path: string): void { if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) refused() }
/** Cancellation stops this assembly from proceeding even if a dependency is non-cooperative. */
async function within<T>(operation: Promise<T>, signal: AbortSignal, late?: (value?: T) => Promise<unknown>): Promise<T> {
  let abandoned = false
  const aborted = Promise.withResolvers<never>()
  const cutoff = () => { abandoned = true; aborted.reject(new EnterpriseCliHostError()) }
  if (signal.aborted) cutoff()
  else signal.addEventListener('abort', cutoff, { once: true })
  void operation.then(value => { if (abandoned && late) void late(value).catch(() => undefined) },
    () => { if (abandoned && late) void late().catch(() => undefined) })
  try { return await Promise.race([operation, aborted.promise]) }
  finally { signal.removeEventListener('abort', cutoff) }
}
function managedEnvironment(home: string): NodeJS.ProcessEnv {
  const previousHomes = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR'])
  const safe = Object.fromEntries(Object.entries(runtimeEnvironment(process.env)).filter(([key]) => !previousHomes.has(key.toUpperCase())))
  return { ...safe, HOME: home, USERPROFILE: home, TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp'), DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1' }
}
async function privateDirectory(path: string): Promise<void> {
  checkPath(path)
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) refused()
}
function sameAuthority(a: CurrentAuthoritySnapshot, b: CurrentAuthoritySnapshot): boolean {
  return a.binding.issuer === b.binding.issuer && a.binding.subject === b.binding.subject
    && a.binding.organizationId === b.binding.organizationId && a.binding.deviceId === b.binding.deviceId
    && a.project.id === b.project.id && a.project.organizationId === b.project.organizationId
}

/** Optional component assembly. Default carrier/OS validation is deliberately not activated. */
export class EnterpriseCliHost implements EnterpriseHostLifecycle {
  private readonly options: EnterpriseCliHostOptions
  private owned: OwnedChild | undefined
  constructor(options: EnterpriseCliHostOptions) {
    checkPath(options.executable); checkPath(options.runtimeProfile)
    if (options.online) { checkPath(options.online.frontendIndex); if (!options.callerIssuer || typeof options.online.onReady !== 'function') refused() }
    if (!options.model || ![options.model.provider, options.model.model].every(value =>
      typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value))
      || !Number.isSafeInteger(options.model.maxTokens) || options.model.maxTokens < 1 || options.model.maxTokens > 1_000_000
      || options.model.maxRequestBytes !== undefined && (!Number.isSafeInteger(options.model.maxRequestBytes)
        || options.model.maxRequestBytes < 1 || options.model.maxRequestBytes > 1_048_576)) refused()
    this.options = Object.freeze({ ...options, model: Object.freeze({ provider: options.model.provider,
      model: options.model.model, maxTokens: options.model.maxTokens,
      ...(options.model.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.model.maxRequestBytes }) }) })
  }
  capabilities(): Promise<{ readonly ingressValidated: false; readonly sandbox: 'unavailable' }> {
    return Promise.resolve(Object.freeze({ ingressValidated: false, sandbox: 'unavailable' }))
  }
  /** Main-local observability; no process/control handle is exported to the Renderer. */
  processId(): number | undefined { return this.owned?.child?.pid }
  stop(): Promise<void> { return this.owned ? this.stopOwned(this.owned) : Promise.resolve() }
  private stopOwned(owned: OwnedChild): Promise<void> {
    // Revoke the document/network owner synchronously, before waiting for the child.
    owned.lifetime.abort()
    return owned.stopping ??= Promise.resolve().then(async () => {
      owned.releaseCutoff?.()
      await within(owned.prepared, AbortSignal.timeout(12_000))
      let closeFailed = false
      try { if (owned.attachment) await within(owned.attachment.close(), AbortSignal.timeout(4_000)) } catch { closeFailed = true }
      if (owned.child) await within(stopRuntimeTree(owned.child, 3_000), AbortSignal.timeout(5_000))
      if (closeFailed) refused()
      // Exclusive ephemeral home only. Main Recovery/profile/user state is retained.
      if (owned.home) await within(rm(owned.home, { recursive: true, force: true }), AbortSignal.timeout(5_000))
      if (this.owned === owned) this.owned = undefined
    }).catch(() => { throw new EnterpriseCliHostError() })
  }
  async start(layout: RecoveryLayout, authority: CurrentAuthoritySnapshot, startSignal: AbortSignal,
    business: EnterpriseHostBusinessCapabilities): Promise<void> {
    if (this.owned || !(business.hostSignal instanceof AbortSignal)) refused()
    const prepared = Promise.withResolvers<void>(), lifetime = new AbortController()
    const signal = AbortSignal.any([startSignal, business.hostSignal, lifetime.signal])
    const owned: OwnedChild = { lifetime, signal, prepared: prepared.promise, preparationDone: () => prepared.resolve() }
    this.owned = owned // Own failed-start cleanup before the first async operation.
    const startDeadline = setTimeout(() => lifetime.abort(), 10_000); startDeadline.unref()
    const cutoff = () => { void this.stopOwned(owned).catch(() => { this.options.writeLog?.('Enterprise CLI cleanup was refused.\n') }) }
    signal.addEventListener('abort', cutoff, { once: true }); owned.releaseCutoff = () => signal.removeEventListener('abort', cutoff)
    try {
      signal.throwIfAborted(); await within(privateDirectory(layout.cache), signal); signal.throwIfAborted()
      await within(privateDirectory(layout.profile), signal); signal.throwIfAborted()
      const runtime = await within(lstat(this.options.runtimeProfile), signal); signal.throwIfAborted()
      const manifest = await within(lstat(join(this.options.runtimeProfile, 'package.json')), signal); signal.throwIfAborted()
      if (!runtime.isDirectory() || runtime.isSymbolicLink() || !manifest.isFile() || manifest.isSymbolicLink() || manifest.size > 1_048_576) refused()
      const fresh = await within(business.currentAuthority(signal), signal); signal.throwIfAborted()
      if (!sameAuthority(authority, fresh) || !Number.isFinite(Date.parse(fresh.expiresAt)) || Date.parse(fresh.expiresAt) <= Date.now()) refused()
      const require = createRequire(join(this.options.runtimeProfile, 'package.json'))
      const cli = require.resolve('@deepseek-ai/dsh/lib/bin.js')
      const profileModule: PublicProfileExports = await within(import(pathToFileURL(require.resolve('workdsh-provider-enterprise-profile/cli-profile')).href), signal)
      const ipcModule: PublicIpcExports = await within(import(pathToFileURL(require.resolve('workdsh-provider-enterprise-profile/main-ipc')).href), signal)
      signal.throwIfAborted()
      if (typeof profileModule.managedCliProfilePatch !== 'function' || typeof ipcModule.attachMainBusinessIpc !== 'function') refused()
      owned.home = await within(mkdtemp(join(layout.cache, 'cli-')), signal,
        async home => { if (home) await rm(home, { recursive: true, force: true }) }); signal.throwIfAborted()
      await within(privateDirectory(owned.home), signal); signal.throwIfAborted()
      const removeAbandonedHome = async () => { if (owned.home) await rm(owned.home, { recursive: true, force: true }) }
      await within(mkdir(join(owned.home, 'tmp'), { mode: 0o700 }), signal, removeAbandonedHome); signal.throwIfAborted()
      await within(mkdir(join(owned.home, 'agents'), { mode: 0o700 }), signal, removeAbandonedHome); signal.throwIfAborted()
      const profile = join(owned.home, 'profiles', 'afos-managed')
      await within(mkdir(profile, { recursive: true, mode: 0o700 }), signal, removeAbandonedHome); signal.throwIfAborted()
      const patch = profileModule.managedCliProfilePatch({ root: layout.profile, binding: fresh.binding, model: this.options.model, signal,
        ...(this.options.callerIssuer ? { nativeCaller: true as const } : {}), ...(this.options.online ? { frontendIndex: this.options.online.frontendIndex } : {}) })
      const encoded = JSON.stringify(patch)
      if (Buffer.byteLength(encoded) > 65_536) refused()
      await within(writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'afos-managed-profile', private: true, type: 'module', dsh: { profile: { bundles: [] } } }) + '\n', { flag: 'wx', mode: 0o600 }), signal, removeAbandonedHome); signal.throwIfAborted()
      await within(writeFile(join(profile, 'cordis.patch.yml'), encoded + '\n', { flag: 'wx', mode: 0o600 }), signal, removeAbandonedHome); signal.throwIfAborted()
      await within(symlink(join(this.options.runtimeProfile, 'node_modules'), join(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'), signal, removeAbandonedHome); signal.throwIfAborted()
      const ready = Promise.withResolvers<void>(); let sawWelcome = false
      let onlineReady: Omit<EnterpriseCliReady, 'signal'> | undefined
      const child = spawn(this.options.executable, [cli, '--profile', 'afos-managed'], {
        cwd: owned.home, env: managedEnvironment(owned.home),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', windowsHide: true, detached: process.platform !== 'win32',
      })
      owned.child = child; owned.preparationDone()
      const unexpected = () => {
        if (this.owned !== owned || !owned.ready || owned.stopping || owned.signal.aborted || owned.unexpectedReported) return
        owned.unexpectedReported = true
        owned.lifetime.abort()
        void Promise.resolve().then(() => this.options.onUnexpectedStop?.()).catch(() => { this.options.writeLog?.('Enterprise CLI unexpected-stop handling was refused.\n') })
      }
      ready.promise.catch(() => undefined)
      const failReady = () => ready.reject(new EnterpriseCliHostError())
      child.once('error', failReady); child.once('exit', () => { unexpected(); failReady() })
      child.once('disconnect', () => { unexpected(); failReady(); cutoff() })
      const readyCutoff = () => failReady(); signal.addEventListener('abort', readyCutoff, { once: true })
      const output = new RuntimeLogFilter(text => {
        if (text === 'AFOS_CLI_READY v1\n') { if (!this.options.online) ready.resolve(); return }
        this.options.writeLog?.(text)
      }), errors = new RuntimeLogFilter(text => this.options.writeLog?.(text))
      child.stdout?.on('data', value => output.consume(value)); child.stderr?.on('data', value => errors.consume(value))
      child.once('exit', () => { output.flush(); errors.flush() })
      const endpoint: Endpoint = {
        send: message => new Promise<void>((resolve, reject) => {
          if (!child.connected) { reject(new EnterpriseCliHostError()); return }
          const timer = setTimeout(() => reject(new EnterpriseCliHostError()), 3_000); timer.unref()
          child.send(message, error => { clearTimeout(timer); if (error) reject(new EnterpriseCliHostError())
            else { if ('kind' in message && message.kind === 'welcome') sawWelcome = true; resolve() } })
        }),
        messages: listener => { child.on('message', listener); return () => { child.off('message', listener) } },
        disconnected: listener => { child.on('disconnect', listener); return () => { child.off('disconnect', listener) } },
      }
      try {
        owned.attachment = await within(ipcModule.attachMainBusinessIpc(endpoint, business, signal, { root: layout.profile, model: this.options.model }, this.options.callerIssuer,
          this.options.online ? { frontendIndex: this.options.online.frontendIndex, onReady: value => { if (!signal.aborted) { onlineReady = value; ready.resolve() } } } : undefined), signal,
          async attachment => { await attachment?.close() })
        signal.throwIfAborted(); await within(ready.promise, signal); signal.throwIfAborted()
        if (!sawWelcome || !child.connected || child.exitCode !== null || child.signalCode !== null) refused()
        const current = await within(business.currentAuthority(signal), signal); signal.throwIfAborted()
        if (!sameAuthority(fresh, current) || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) refused()
        if (this.options.online) { if (!onlineReady) refused(); await within(this.options.online.onReady(Object.freeze({ ...onlineReady, signal })), signal); signal.throwIfAborted() }
        owned.ready = true
      } finally { signal.removeEventListener('abort', readyCutoff) }
    } catch {
      owned.preparationDone()
      try { await this.stopOwned(owned) } catch { /* Stable failure; callers retain the cleanup rejection from stop(). */ }
      throw new EnterpriseCliHostError()
    } finally { clearTimeout(startDeadline) }
  }
}
