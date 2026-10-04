import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountNamespace, DesktopAuth, osTokenEncryption, RefreshTokenVault } from '../src/desktop-auth.ts'

const config = { issuer: 'https://enterprise.example/api', clientId: 'desktop', resource: 'https://enterprise.example/api', scope: 'afos offline_access' }
const metadata = { issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, code_challenge_methods_supported: ['S256'] }
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function fixture(options: { invalidGrant?: boolean; malformed?: boolean } = {}) {
  let refreshes = 0
  let challenge = ''
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('openid-configuration')) return Response.json(metadata)
    const body = new URLSearchParams(String(init?.body))
    expect(body.has('client_secret')).toBe(false)
    expect(body.get('resource')).toBe(config.resource)
    if (body.get('grant_type') === 'authorization_code') {
      expect(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')).toBe(challenge)
      return Response.json(options.malformed ? { access_token: 'bad', token_type: 'Bearer', expires_in: 0, scope: 'afos' } : { access_token: 'access-one', refresh_token: 'refresh-one', token_type: 'Bearer', expires_in: 1, scope: 'afos offline_access' })
    }
    refreshes += 1
    if (options.invalidGrant) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    return Response.json({ access_token: 'access-two', refresh_token: 'refresh-two', token_type: 'Bearer', expires_in: 3600, scope: 'afos offline_access' })
  }
  const browser = async (href: string) => {
    const url = new URL(href)
    challenge = url.searchParams.get('code_challenge') ?? ''
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const callback = new URL(url.searchParams.get('redirect_uri') ?? '')
    expect(callback.hostname).toBe('127.0.0.1')
    callback.search = new URLSearchParams({ state: 'wrong', code: 'test-code' }).toString()
    expect((await fetch(callback)).status).toBe(400)
    callback.searchParams.set('state', url.searchParams.get('state') ?? '')
    expect((await fetch(callback)).status).toBe(200)
    expect((await fetch(callback)).status).toBe(400)
  }
  return { auth: new DesktopAuth(config, browser, fetcher), refreshes: () => refreshes }
}

describe('main process OAuth', () => {
  for (const outcome of ['success', 'invalid_grant'] as const) for (const successor of ['signed-out', 'new-account'] as const) {
    it(`AT10 late refresh ${outcome} cannot revive tokens or disturb ${successor}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'afos-auth-late-')); roots.push(root)
      const vault = new RefreshTokenVault(root, { available: () => true,
        encrypt: text => Buffer.from(text.split('').reverse().join('')), decrypt: bytes => bytes.toString().split('').reverse().join('') })
      const alice = accountNamespace(config.issuer, 'alice', 'org1', 'device1'), bob = accountNamespace(config.issuer, 'bob', 'org1', 'device1')
      await vault.save(alice, 'alice-seed')
      let release: (response: Response) => void = () => undefined, entered: () => void = () => undefined, refreshes = 0
      const waiting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<Response>(resolve => { release = resolve })
      const token = (access: string, refresh: string, expires: number) => Response.json({ access_token: access,
        refresh_token: refresh, token_type: 'Bearer', expires_in: expires, scope: 'afos offline_access' })
      const fetcher: typeof fetch = async (url, init) => {
        if (String(url).endsWith('openid-configuration')) return Response.json(metadata)
        expect(String(url)).toBe(metadata.token_endpoint)
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('grant_type')).toBe('refresh_token'); expect(body.has('client_secret')).toBe(false)
        if (body.get('refresh_token') === 'alice-seed') return token('alice-access', 'alice-current', 1)
        if (body.get('refresh_token') === 'bob-seed') return token('bob-access', 'bob-current', 3600)
        expect(body.get('refresh_token')).toBe('alice-current'); refreshes++; entered(); return held
      }
      const state: boolean[] = []
      const auth: DesktopAuth = new DesktopAuth(config, async () => { throw new Error('restore must not open a browser') }, fetcher, () => state.push(auth.signedIn))
      let pending: Promise<PromiseSettledResult<string>[]> | undefined
      const bytes = async () => Promise.all((await readdir(root)).sort().map(async file => ({ file, bytes: await readFile(join(root, file)) })))
      try {
        expect(await auth.restoreRefresh(vault, alice)).toBe(true)
        expect(await auth.persistRefresh(vault, alice)).toBe(true)
        pending = Promise.allSettled([auth.accessToken(), auth.accessToken(), auth.accessToken()])
        await waiting; expect(refreshes).toBe(1)
        auth.logout(); await auth.settleCredentialWrites()
        // Auth owns memory; explicit Main-style cleanup owns the old vault namespace.
        await vault.clear(alice)
        if (successor === 'new-account') {
          await vault.save(bob, 'bob-seed'); expect(await auth.restoreRefresh(vault, bob)).toBe(true)
          expect(await auth.persistRefresh(vault, bob)).toBe(true)
        }
        const before = await bytes(), observed = [...state]
        release(outcome === 'success' ? token('late-alice-access', 'late-alice-refresh', 3600)
          : Response.json({ error: 'invalid_grant' }, { status: 400 }))
        const results = await pending
        for (const result of results) {
          expect(result.status).toBe('rejected')
          if (result.status === 'rejected') expect(result.reason.code).toBe(outcome === 'success' ? 'auth/account-changed' : 'auth/invalid-grant')
        }
        expect(refreshes).toBe(1); expect(state).toEqual(observed); expect(await bytes()).toEqual(before)
        expect(await vault.load(alice)).toBeUndefined()
        if (successor === 'new-account') {
          expect(auth.signedIn).toBe(true); expect(await auth.accessToken()).toBe('bob-access')
          expect(await vault.load(bob)).toBe('bob-current')
        } else {
          expect(auth.signedIn).toBe(false); await expect(auth.accessToken()).rejects.toThrow('auth/sign-in-required')
          expect(await auth.persistRefresh(vault, alice)).toBe(false)
        }
      } finally {
        release(token('cleanup-access', 'cleanup-refresh', 3600)); await pending; auth.logout()
      }
    })
  }
  it('uses a real one-use loopback callback, PKCE and single-flight refresh', async () => {
    const f = fixture()
    await f.auth.login()
    expect(f.auth.signedIn).toBe(true)
    expect(await Promise.all([f.auth.accessToken(), f.auth.accessToken(), f.auth.accessToken()])).toEqual(['access-two', 'access-two', 'access-two'])
    expect(f.refreshes()).toBe(1)
    f.auth.logout()
    await expect(f.auth.accessToken()).rejects.toThrow('auth/sign-in-required')
  })
  it('invalid_grant clears the account without falling back', async () => {
    const f = fixture({ invalidGrant: true })
    await f.auth.login()
    await expect(f.auth.accessToken()).rejects.toThrow('auth/invalid-grant')
    expect(f.auth.signedIn).toBe(false)
    await expect(f.auth.accessToken()).rejects.toThrow('auth/sign-in-required')
    expect(f.refreshes()).toBe(1)
  })
  it('rejects invalid token responses', async () => {
    const f = fixture({ malformed: true })
    await expect(f.auth.login()).rejects.toThrow('auth/invalid-token-response')
    expect(f.auth.signedIn).toBe(false)
  })
  it('rejects metadata that redirects to an unapproved endpoint', async () => {
    const auth = new DesktopAuth(config, async () => { throw new Error('browser must not open') }, async () => Response.json({ ...metadata, token_endpoint: 'https://other.example/token' }))
    await expect(auth.login()).rejects.toThrow('auth/unapproved-endpoint')
  })
  it('logout cancels an open browser login and closes its listening socket', async () => {
    let callbackUrl = ''
    const auth = new DesktopAuth(config, async href => {
      callbackUrl = new URL(href).searchParams.get('redirect_uri') ?? ''
      auth.logout()
    }, async () => Response.json(metadata))
    await expect(auth.login()).rejects.toThrow('auth/login-cancelled')
    await expect(fetch(callbackUrl)).rejects.toThrow()
    expect(auth.signedIn).toBe(false)
  })
})

describe('credential namespace and storage', () => {
  it('isolates issuer, subject, organization and device independently', () => {
    const baseline = accountNamespace(config.issuer, 'alice', 'org1', 'device1')
    for (const tuple of [[`${config.issuer}/other`, 'alice', 'org1', 'device1'], [config.issuer, 'bob', 'org1', 'device1'], [config.issuer, 'alice', 'org2', 'device1'], [config.issuer, 'alice', 'org1', 'device2']]) {
      expect(accountNamespace(tuple[0] ?? '', tuple[1] ?? '', tuple[2] ?? '', tuple[3] ?? '')).not.toBe(baseline)
    }
  })
  it('does not persist when OS encryption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afos-auth-')); roots.push(root)
    const vault = new RefreshTokenVault(root, { available: () => false, encrypt: () => { throw new Error('must not encrypt') }, decrypt: () => '' })
    expect(await vault.save('account', 'refresh-secret')).toBe(false)
    expect(await readdir(root)).toEqual([])
  })
  it('atomically stores only encrypted bytes and removes only the selected account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afos-auth-')); roots.push(root)
    const vault = new RefreshTokenVault(root, { available: () => true, encrypt: text => Buffer.from(text.split('').reverse().join('')), decrypt: bytes => bytes.toString().split('').reverse().join('') })
    await vault.save('alice', 'refresh-secret')
    await vault.save('bob', 'bob-secret')
    const files = await readdir(root)
    for (const file of files) expect((await readFile(join(root, file))).toString()).not.toContain('refresh-secret')
    expect(await vault.load('alice')).toBe('refresh-secret')
    await vault.clear('alice')
    expect(await vault.load('alice')).toBeUndefined()
    expect(await vault.load('bob')).toBe('bob-secret')
  })
  it('treats Electron basic_text as memory-only even when its availability flag is true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afos-basic-text-')); roots.push(root)
    const encryption = osTokenEncryption({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw new Error('must not encrypt') }, decryptString: () => { throw new Error('must not decrypt') } }, 'linux')
    expect(encryption.available()).toBe(false)
    const vault = new RefreshTokenVault(join(root,'credentials'), encryption)
    expect(await vault.save('account','test-refresh-secret')).toBe(false)
    expect(await readdir(root)).toEqual([])
  })
  it('restores encrypted refresh state in a single flight without exposing refresh bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afos-restore-')); roots.push(root)
    const vault = new RefreshTokenVault(root, { available: () => true, encrypt: text => Buffer.from(text.split('').reverse().join('')), decrypt: bytes => bytes.toString().split('').reverse().join('') })
    const first = fixture(); await first.auth.login(); await first.auth.accessToken()
    expect(await first.auth.persistRefresh(vault, 'verified-account')).toBe(true)
    first.auth.logout()
    const second = fixture()
    expect(await Promise.all([second.auth.restoreRefresh(vault, 'verified-account'), second.auth.restoreRefresh(vault, 'verified-account')])).toEqual([true, true])
    expect(second.refreshes()).toBe(1)
    expect(await second.auth.accessToken()).toBe('access-two')
    await expect(second.auth.restoreRefresh(vault, 'other-account')).rejects.toThrow('auth/session-already-active')
    second.auth.logout()
    expect(await second.auth.restoreRefresh(vault, 'missing-account')).toBe(false)
    expect(second.auth.signedIn).toBe(false)
  })
  it('serializes refresh publication and retains the latest rotated token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afos-rotation-')); roots.push(root)
    const vault = new RefreshTokenVault(root, { available: () => true, encrypt: text => Buffer.from(text.split('').reverse().join('')), decrypt: bytes => bytes.toString().split('').reverse().join('') })
    const f = fixture(); await f.auth.login()
    const save = vault.save.bind(vault)
    let release: () => void = () => undefined
    let entered: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    let writes = 0
    vault.save = async (namespace, token) => { if (++writes === 1) { entered(); await gate } return save(namespace, token) }
    const old = f.auth.persistRefresh(vault, 'verified-account'); await waiting
    await f.auth.accessToken()
    const rotated = f.auth.persistRefresh(vault, 'verified-account')
    release(); await Promise.all([old, rotated])
    expect(await vault.load('verified-account')).toBe('refresh-two')
    expect(writes).toBe(2)
  })
})
