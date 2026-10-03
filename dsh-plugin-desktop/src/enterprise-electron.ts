import { constants, openSync, closeSync, readFileSync, fstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EnterpriseCliHost } from './enterprise-cli-host.ts'
import type { EnterpriseHostLifecycle, ManagedDesktopConfig } from './enterprise-main.ts'

export interface EnterpriseRuntimePolicy {
  readonly contractVersion: 'afos.host-runtime.v1'
  readonly releaseId: string
  readonly policyRevision: string
  readonly model: { readonly provider: string; readonly model: string; readonly maxTokens: number; readonly maxRequestBytes?: number }
}
export class EnterpriseCarrierError extends Error { constructor() { super('enterprise/carrier-refused') } }
function refuse(): never { throw new EnterpriseCarrierError() }
/** Enterprise paths are release-owned; personal development environment overrides do not apply. */
export function enterpriseRuntimePaths(appPath: string, resourcesPath: string, packaged: boolean, platform: NodeJS.Platform = process.platform) {
  const root = packaged ? join(resourcesPath, 'workdsh-runtime') : join(appPath, 'build', 'workdsh-runtime')
  return Object.freeze({ runtimeProfile: join(root, 'profiles', 'workdsh'), executable: join(root, 'primary-runtime', 'dependencies', 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node') })
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) refuse()
  return value as Record<string, unknown>
}
/** Distribution-owned model policy, rechecked by the existing Main/Broker on use. */
export function loadEnterpriseRuntimePolicy(path: string, expected: Pick<ManagedDesktopConfig, 'releaseId' | 'policyRevision'>): EnterpriseRuntimePolicy {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) refuse()
    const value = record(JSON.parse(readFileSync(fd, 'utf8')), ['contractVersion', 'releaseId', 'policyRevision', 'model'])
    if (value.contractVersion !== 'afos.host-runtime.v1' || value.releaseId !== expected.releaseId || value.policyRevision !== expected.policyRevision) refuse()
    const model = record(value.model, ['provider', 'model', 'maxTokens'], ['maxRequestBytes'])
    for (const key of ['provider', 'model']) if (typeof model[key] !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(model[key])) refuse()
    if (!Number.isSafeInteger(model.maxTokens) || (model.maxTokens as number) < 1 || (model.maxTokens as number) > 1000000) refuse()
    if (model.maxRequestBytes !== undefined && (!Number.isSafeInteger(model.maxRequestBytes) || (model.maxRequestBytes as number) < 1 || (model.maxRequestBytes as number) > 1048576)) refuse()
    return Object.freeze({ contractVersion: 'afos.host-runtime.v1', releaseId: expected.releaseId, policyRevision: expected.policyRevision,
      model: Object.freeze({ provider: model.provider as string, model: model.model as string, maxTokens: model.maxTokens as number,
        ...(model.maxRequestBytes === undefined ? {} : { maxRequestBytes: model.maxRequestBytes as number }) }) })
  } catch { return refuse() } finally { if (fd !== undefined) closeSync(fd) }
}
/** Existing CLI owner only. Main's sandbox/admission gate still prevents production start. */
export function createEnterpriseElectronHost(options: { readonly appPath: string; readonly runtimeProfile: string; readonly executable: string;
  readonly config: Pick<ManagedDesktopConfig, 'releaseId' | 'policyRevision'>; readonly writeLog: (text: string) => void;
  readonly onUnexpectedStop?: () => Promise<void>;
  readonly createHost?: (policy: EnterpriseRuntimePolicy) => EnterpriseHostLifecycle }): EnterpriseHostLifecycle {
  let owner: EnterpriseHostLifecycle | undefined
  return {
    capabilities: async () => ({ ingressValidated: false, sandbox: 'unavailable' }),
    stop: async () => { await owner?.stop() },
    start: async (...args) => {
      if (!owner) {
        const policy = loadEnterpriseRuntimePolicy(join(options.appPath, 'afos-host-runtime.json'), options.config)
        owner = options.createHost?.(policy) ?? new EnterpriseCliHost({ executable: options.executable, runtimeProfile: options.runtimeProfile, model: policy.model, writeLog: options.writeLog,
          ...(options.onUnexpectedStop ? { onUnexpectedStop: options.onUnexpectedStop } : {}) })
      }
      await owner.start(...args)
    },
  }
}
/** No copied business projection and no second DSH installation inside the carrier. */
export function runtimeDraftProjection(runtimeProfile: string): (record: unknown) => Promise<unknown> {
  let projection: Promise<{ draftView(record: unknown): unknown }> | undefined
  return async record => {
    const require = createRequire(join(runtimeProfile, 'package.json'))
    projection ??= import(pathToFileURL(require.resolve('workdsh-provider-enterprise-profile/local-drafts')).href) as Promise<{ draftView(record: unknown): unknown }>
    const loaded = await projection
    if (typeof loaded.draftView !== 'function') refuse()
    return loaded.draftView(record)
  }
}
