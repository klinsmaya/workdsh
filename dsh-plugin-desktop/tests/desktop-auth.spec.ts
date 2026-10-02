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
})
