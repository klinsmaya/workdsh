import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { osTokenEncryption, RefreshTokenVault } from './desktop-auth.ts'
import { EnterpriseMainSession, type EnterpriseHostLifecycle, type ManagedDesktopConfig } from './enterprise-main.ts'

/** Distribution-owned configuration only; no environment, Renderer or token fields. */
export function loadManagedDesktopConfig(path: string): ManagedDesktopConfig | undefined {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('enterprise/invalid-managed-config') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let raw: unknown
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new Error('enterprise/invalid-managed-config')
    try { raw = JSON.parse(readFileSync(descriptor, 'utf8')) }
    catch { throw new Error('enterprise/invalid-managed-config') }
  } finally { closeSync(descriptor) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('enterprise/invalid-managed-config')
  const config = raw as Record<string, unknown>
  if (Object.keys(config).some(key => !['contractVersion', 'auth', 'releaseId', 'policyRevision'].includes(key))
    || config.contractVersion !== 'afos.desktop-config.v1' || !config.auth || typeof config.auth !== 'object' || Array.isArray(config.auth)) throw new Error('enterprise/invalid-managed-config')
  const auth = config.auth as Record<string, unknown>
  if (Object.keys(auth).some(key => !['issuer', 'clientId', 'resource', 'scope'].includes(key))
    || [config.releaseId, config.policyRevision, auth.issuer, auth.clientId, auth.resource, auth.scope].some(value => typeof value !== 'string' || !value || value.length > 2_048 || /[\u0000-\u001f]/u.test(value))) throw new Error('enterprise/invalid-managed-config')
  let issuer: URL
  try { issuer = new URL(auth.issuer as string) }
  catch { throw new Error('enterprise/invalid-managed-config') }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error('enterprise/invalid-managed-config')
  const resource = new URL(issuer)
  resource.pathname = `${resource.pathname.replace(/\/$/u, '')}/afos`
  if (resource.href !== auth.resource || !/^afos(?: offline_access)?$/u.test(auth.scope as string)) throw new Error('enterprise/invalid-managed-config')
  return Object.freeze({ ...config, auth: Object.freeze({ ...auth }) }) as unknown as ManagedDesktopConfig
}

export interface EnterpriseEntryOptions {
  readonly configPath: string
  readonly dataDirectory: string
  readonly storage: Parameters<typeof osTokenEncryption>[0]
  readonly host: EnterpriseHostLifecycle
  readonly openBrowser: (url: string) => Promise<void>
}
export function createEnterpriseEntry(options: EnterpriseEntryOptions): EnterpriseMainSession | undefined {
  const config = loadManagedDesktopConfig(options.configPath)
  if (!config) return undefined
  return new EnterpriseMainSession(config, options.dataDirectory,
    new RefreshTokenVault(join(options.dataDirectory, 'credentials'), osTokenEncryption(options.storage)),
    options.host, options.openBrowser)
}
