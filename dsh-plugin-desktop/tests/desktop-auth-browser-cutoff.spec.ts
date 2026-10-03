import { Server as HttpServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { DesktopAuth } from '../src/desktop-auth.ts'

const config = { issuer: 'https://enterprise.example/api', clientId: 'desktop', resource: 'https://enterprise.example/api', scope: 'afos' }
const metadata = { issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, code_challenge_methods_supported: ['S256'] }

it('cancels a login and releases its real callback while browser opening remains pending', async () => {
  const browserStarted = Promise.withResolvers<string>()
  const browserGate = Promise.withResolvers<void>()
  const cutoff = new AbortController()
  const auth = new DesktopAuth(config, async href => {
    browserStarted.resolve(new URL(href).searchParams.get('redirect_uri') ?? '')
    await browserGate.promise
  }, async () => Response.json(metadata))
  const login = auth.login(cutoff.signal)
  const outcome = login.then(() => 'unexpected success', error => error instanceof Error ? error.message : 'unknown failure')
  const callback = await browserStarted.promise
  cutoff.abort()
  try {
    const bounded = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve('browser wait was not cancelled'), 300))])
    expect(bounded).toBe('auth/login-cancelled')
    await expect(fetch(callback, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
    expect(auth.signedIn).toBe(false)
    await expect(auth.accessToken()).rejects.toThrow('auth/sign-in-required')
  } finally {
    browserGate.resolve()
    auth.logout()
    await outcome
  }
})

it('cannot revive cancelled authentication after a late browser failure', async () => {
  const browserStarted = Promise.withResolvers<void>()
  const browserGate = Promise.withResolvers<void>()
  const auth = new DesktopAuth(config, async () => { browserStarted.resolve(); await browserGate.promise }, async () => Response.json(metadata))
  const outcome = auth.login().then(() => 'unexpected success', error => error instanceof Error ? error.message : 'unknown failure')
  await browserStarted.promise
  auth.logout()
  try {
    const bounded = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve('browser wait was not cancelled'), 300))])
    expect(bounded).toBe('auth/login-cancelled')
    browserGate.reject(new Error('late test browser failure'))
    await new Promise(resolve => setImmediate(resolve))
    expect(auth.signedIn).toBe(false)
    await expect(auth.accessToken()).rejects.toThrow('auth/sign-in-required')
  } finally {
    browserGate.resolve()
    auth.logout()
    await outcome
  }
})

it('never opens the browser when cancellation arrives during real loopback listen', async () => {
  const cutoff = new AbortController()
  const realListen = HttpServer.prototype.listen
  let browserCalls = 0
  let callback = ''
  const listen = vi.spyOn(HttpServer.prototype, 'listen').mockImplementation(function (this: HttpServer, ...args: Parameters<HttpServer['listen']>) {
    this.once('listening', () => {
      const address = this.address()
      if (address && typeof address !== 'string') callback = `http://127.0.0.1:${address.port}/oauth/callback`
    })
    const result = Reflect.apply(realListen, this, args)
    cutoff.abort()
    return result
  })
  const auth = new DesktopAuth(config, async () => { browserCalls++ }, async () => Response.json(metadata))
  try {
    await expect(auth.login(cutoff.signal)).rejects.toThrow('auth/login-cancelled')
    expect(browserCalls).toBe(0)
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u)
    await expect(fetch(callback, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
    expect(auth.signedIn).toBe(false)
  } finally { listen.mockRestore(); auth.logout() }
})

it('cannot install a late token response after the caller cancels', async () => {
  const cutoff = new AbortController()
  const tokenStarted = Promise.withResolvers<void>()
  const tokenGate = Promise.withResolvers<void>()
  let callback = ''
  const auth = new DesktopAuth(config, async href => {
    const url = new URL(href), target = new URL(url.searchParams.get('redirect_uri') ?? '')
    target.search = new URLSearchParams({ state: url.searchParams.get('state') ?? '', code: 'isolated-test-code' }).toString()
    callback = target.href
    expect((await fetch(target)).status).toBe(200)
  }, async url => {
    if (String(url).endsWith('openid-configuration')) return Response.json(metadata)
    tokenStarted.resolve()
    await tokenGate.promise
    return Response.json({ access_token: 'isolated-test-token', token_type: 'Bearer', expires_in: 3600, scope: 'afos' })
  })
  const outcome = auth.login(cutoff.signal).then(() => 'unexpected success', error => error instanceof Error ? error.message : 'unknown failure')
  await tokenStarted.promise
  cutoff.abort()
  tokenGate.resolve()
  try {
    expect(await outcome).toBe('auth/login-cancelled')
    expect(auth.signedIn).toBe(false)
    await expect(auth.accessToken()).rejects.toThrow('auth/sign-in-required')
    await expect(fetch(callback, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
  } finally { tokenGate.resolve(); await outcome; auth.logout() }
})
