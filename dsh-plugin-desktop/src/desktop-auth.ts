import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface EnterpriseAuthConfig {
  readonly issuer: string
  readonly clientId: string
  readonly resource: string
  readonly scope: string
}
interface Metadata { issuer: string; authorization_endpoint: string; token_endpoint: string; code_challenge_methods_supported: string[] }
interface Tokens { access_token: string; refresh_token?: string; token_type: string; expires_in: number; scope: string }
export interface TokenEncryption {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(bytes: Buffer): string
}
interface OsSafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(text: string): Buffer
  decryptString(bytes: Buffer): string
}
/** Electron safeStorage adapter; Linux basic_text must never persist a token. */
export function osTokenEncryption(storage: OsSafeStorage, platform: NodeJS.Platform = process.platform): TokenEncryption {
  const available = (): boolean => storage.isEncryptionAvailable()
    && (platform !== 'linux' || Boolean(storage.getSelectedStorageBackend?.() && storage.getSelectedStorageBackend() !== 'basic_text'))
  return {
    available,
    encrypt: text => { if (!available()) throw new Error('auth/encryption-unavailable'); return storage.encryptString(text) },
    decrypt: bytes => { if (!available()) throw new Error('auth/encryption-unavailable'); return storage.decryptString(bytes) },
  }
}

function endpoint(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('auth/invalid-managed-endpoint')
  return url
}
function scopes(value: string): string[] { return value.split(/\s+/u).filter(Boolean) }
function secret(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\r\n]/u.test(value) }

/** Refresh tokens are encrypted atomically; unavailable OS encryption means memory only. */
export class RefreshTokenVault {
  constructor(private readonly directory: string, private readonly encryption: TokenEncryption) {}
  private path(namespace: string): string { return join(this.directory, `${createHash('sha256').update(namespace).digest('hex')}.enc`) }
  async save(namespace: string, token: string): Promise<boolean> {
    if (!this.encryption.available()) return false
    if (!secret(token)) throw new Error('auth/invalid-token')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('auth/invalid-vault-directory')
    await chmod(this.directory, 0o700)
    const destination = this.path(namespace)
    const temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`
    try {
      await writeFile(temporary, this.encryption.encrypt(token), { mode: 0o600, flag: 'wx' })
      await rename(temporary, destination)
    } finally { await rm(temporary, { force: true }) }
    return true
  }
  async load(namespace: string): Promise<string | undefined> {
    if (!this.encryption.available()) return undefined
    try {
      const file = await open(this.path(namespace), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536
          || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('auth/invalid-vault-file')
        bytes = await file.readFile()
      } finally { await file.close() }
      const token = this.encryption.decrypt(bytes)
      if (!secret(token)) throw new Error('auth/invalid-stored-token')
      return token
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new Error('auth/vault-read-failed')
    }
  }
  async clear(namespace: string): Promise<void> { await rm(this.path(namespace), { force: true }) }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('auth/empty-response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 65_536) throw new Error('auth/response-too-large')
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { await reader.cancel().catch(() => undefined) }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('auth/invalid-response')
  return value as Record<string, unknown>
}

/** Main-process-only OAuth client. No renderer IPC exposes tokens or arbitrary URLs. */
export class DesktopAuth {
  private tokens: Tokens | undefined
  private generation = 0
  private refreshFlight: Promise<string> | undefined
  private loginFlight: Promise<void> | undefined
  private loginAbort: AbortController | undefined
  private expiresAt = 0
  private persistedRefresh: { namespace: string; token: string } | undefined
  private restoreFlight: { namespace: string; operation: Promise<boolean>; abort: AbortController } | undefined
  private credentialWriteTail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly config: EnterpriseAuthConfig,
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    endpoint(config.issuer)
    endpoint(config.resource)
    if (!config.clientId || !scopes(config.scope).includes('afos')) throw new Error('auth/invalid-client-config')
  }
  get signedIn(): boolean { return this.tokens !== undefined }
  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
    const body = record(await readJson(response))
    if (!response.ok) throw new Error(body.error === 'invalid_grant' ? 'auth/invalid-grant' : 'auth/request-failed')
    return body
  }
  private async metadata(signal?: AbortSignal): Promise<Metadata> {
    const issuer = this.config.issuer.replace(/\/$/u, '')
    const body = await this.request(`${issuer}/.well-known/openid-configuration`, {}, signal)
    if (body.issuer !== this.config.issuer || typeof body.authorization_endpoint !== 'string' || typeof body.token_endpoint !== 'string'
      || !Array.isArray(body.code_challenge_methods_supported) || !body.code_challenge_methods_supported.includes('S256')) throw new Error('auth/invalid-metadata')
    const origin = endpoint(issuer).origin
    if (endpoint(body.authorization_endpoint).origin !== origin || endpoint(body.token_endpoint).origin !== origin) throw new Error('auth/unapproved-endpoint')
    return body as unknown as Metadata
  }
  login(signal?: AbortSignal): Promise<void> {
    if (this.restoreFlight) return Promise.reject(new Error('auth/session-already-active'))
    if (this.loginFlight) return this.loginFlight
    const generation = this.generation
    const controller = new AbortController()
    this.loginAbort = controller
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const operation = this.authorize(generation, combined).finally(() => {
      if (this.loginFlight === operation) this.loginFlight = undefined
      if (this.loginAbort === controller) this.loginAbort = undefined
    })
    this.loginFlight = operation
    return operation
  }
  private async authorize(generation: number, signal?: AbortSignal): Promise<void> {
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
    const metadata = await this.metadata(deadline)
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    // The path must match registered metadata; RFC 8252 permits a dynamic port.
    const callbackPath = '/oauth/callback'
    let settle: (code: string) => void = () => undefined
    let reject: (cause: Error) => void = () => undefined
    const callback = new Promise<string>((resolve, fail) => { settle = resolve; reject = fail })
    // Attach rejection handling before opening the browser or awaiting network work.
    callback.catch(() => undefined)
    let consumed = false
    const server = createServer((request, response) => {
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1') } catch { response.statusCode = 400; response.end(); return }
      const received = url.searchParams.get('state') ?? ''
      const sameState = Buffer.byteLength(received) === Buffer.byteLength(state) && timingSafeEqual(Buffer.from(received), Buffer.from(state))
      const valid = request.method === 'GET' && url.pathname === callbackPath && !consumed && sameState
        && url.searchParams.getAll('state').length === 1 && url.searchParams.getAll('code').length === 1 && secret(url.searchParams.get('code'))
        && !url.searchParams.has('error') && (!url.searchParams.has('iss') || url.searchParams.get('iss') === metadata.issuer)
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'")
      response.statusCode = valid ? 200 : 400
      response.end(valid ? 'Sign-in received. Return to WorkDSH.' : 'Invalid sign-in callback.')
      if (valid) { consumed = true; settle(url.searchParams.get('code') ?? '') }
    })
    const abort = () => reject(new Error('auth/login-cancelled'))
    deadline.addEventListener('abort', abort, { once: true })
    try {
      deadline.throwIfAborted()
      await new Promise<void>((resolve, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('auth/callback-unavailable')
      const redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`
      const authorization = new URL(metadata.authorization_endpoint)
      authorization.search = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: redirectUri, scope: this.config.scope, resource: this.config.resource, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
      await this.openBrowser(authorization.href)
      const code = await callback
      const body = await this.request(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.clientId, redirect_uri: redirectUri, code, code_verifier: verifier, resource: this.config.resource }) }, deadline)
      this.install(body, generation)
    } finally {
      deadline.removeEventListener('abort', abort)
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
  private install(body: Record<string, unknown>, generation: number): string {
    if (generation !== this.generation) throw new Error('auth/account-changed')
    if (!secret(body.access_token) || body.token_type !== 'Bearer' || typeof body.expires_in !== 'number'
      || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86_400
      || typeof body.scope !== 'string' || !scopes(this.config.scope).filter(s => s !== 'offline_access').every(s => scopes(body.scope as string).includes(s))
      || body.refresh_token !== undefined && !secret(body.refresh_token)) throw new Error('auth/invalid-token-response')
    this.tokens = body as unknown as Tokens
    this.expiresAt = Date.now() + body.expires_in * 1_000
    return body.access_token
  }
  /** Trusted Broker caller only; must never be registered as renderer/Agent API. */
  async accessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (!this.tokens) throw new Error('auth/sign-in-required')
    if (this.expiresAt > Date.now() + 30_000) return this.tokens.access_token
    if (!this.tokens.refresh_token) { this.logout(); throw new Error('auth/sign-in-required') }
    if (!this.refreshFlight) {
      const generation = this.generation
      const refresh = this.tokens.refresh_token
      const operation = this.metadata(signal).then(metadata => this.request(metadata.token_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: refresh, resource: this.config.resource }),
      }, signal)).then(body => this.install(body, generation)).catch(error => {
        if (generation === this.generation) this.logout()
        throw error
      }).finally(() => { if (this.refreshFlight === operation) this.refreshFlight = undefined })
      this.refreshFlight = operation
    }
    return this.refreshFlight
  }
  /** Main only; persist only after the Broker has confirmed this exact account namespace. */
  persistRefresh(vault: RefreshTokenVault, namespace: string): Promise<boolean> {
    const generation = this.generation
    const operation = this.credentialWriteTail.then(async () => {
      if (generation !== this.generation) throw new Error('auth/account-changed')
      // Read the latest rotated token at publication time, not when the write was queued.
      const token = this.tokens?.refresh_token
      if (!token) return false
      if (this.persistedRefresh?.namespace === namespace && this.persistedRefresh.token === token) return true
      const saved = await vault.save(namespace, token)
      if (generation !== this.generation) throw new Error('auth/account-changed')
      if (saved) this.persistedRefresh = { namespace, token }
      return saved
    })
    this.credentialWriteTail = operation.catch(() => undefined)
    return operation
  }
  /** Main logout waits for old publication before deleting its namespace files. */
  async settleCredentialWrites(): Promise<void> { await this.credentialWriteTail }
  /** Restore encrypted refresh state only; the caller must verify the account before Host start. */
  restoreRefresh(vault: RefreshTokenVault, namespace: string, signal?: AbortSignal): Promise<boolean> {
    if (this.restoreFlight) return this.restoreFlight.namespace === namespace ? this.restoreFlight.operation : Promise.reject(new Error('auth/session-already-active'))
    if (this.signedIn || this.loginFlight || this.refreshFlight) return Promise.reject(new Error('auth/session-already-active'))
    const generation = this.generation
    const abort = new AbortController()
    const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])])
    const operation = (async () => {
      await this.settleCredentialWrites()
      const refresh = await vault.load(namespace)
      combined.throwIfAborted()
      if (generation !== this.generation) throw new Error('auth/account-changed')
      if (!refresh) return false
      const metadata = await this.metadata(combined)
      const body = await this.request(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: refresh, resource: this.config.resource }) }, combined)
      combined.throwIfAborted()
      this.install(body, generation)
      return true
    })().finally(() => { if (this.restoreFlight?.operation === operation) this.restoreFlight = undefined })
    this.restoreFlight = { namespace, operation, abort }
    return operation
  }
  logout(): void {
    this.restoreFlight?.abort.abort()
    this.restoreFlight = undefined
    this.loginAbort?.abort()
    this.loginAbort = undefined
    this.loginFlight = undefined
    this.generation += 1
    this.tokens = undefined
    this.expiresAt = 0
    this.refreshFlight = undefined
    this.persistedRefresh = undefined
  }
}

export function accountNamespace(issuer: string, sub: string, organizationId: string, deviceId: string): string {
  if (![issuer, sub, organizationId, deviceId].every(secret)) throw new Error('auth/invalid-namespace')
  return createHash('sha256').update(JSON.stringify([issuer, sub, organizationId, deviceId])).digest('hex')
}
