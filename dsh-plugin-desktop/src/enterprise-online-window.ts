import { createHash } from 'node:crypto'
import { net, type BrowserWindow, type Session, type WebContents } from 'electron'
import { MainCallerProofIssuer, MainCallerProofError, type MainCallerPermit, type MainCallerRequest } from './enterprise-caller-proof.ts'
import type { EnterpriseCliReady } from './enterprise-cli-host.ts'
import { LOCAL_DRAFT_DOCUMENT } from './enterprise-local-ipc.ts'

export class EnterpriseOnlineError extends Error { constructor(readonly stage: 'refused' | 'redirect' | 'headers' | 'cookie' | 'cookie-format' | 'cookie-payload' | 'cookie-jar' | 'clean-index' = 'refused') { super('enterprise/online-carrier-refused') } }
function refuse(stage?: EnterpriseOnlineError['stage']): never { throw new EnterpriseOnlineError(stage) }
function active(...signals: readonly AbortSignal[]): void { for (const signal of signals) signal.throwIfAborted() }
/** The public redirect event exposes the original 303 without following an unchecked URL. */
function exchangeIndex(session: Session, ready: EnterpriseCliReady, clean: string): Promise<Headers> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: ready.authenticatedUrl, session, method: 'GET', redirect: 'manual', useSessionCookies: true })
    let settled = false
    let originalHeaders: Headers | undefined
    const timer = setTimeout(() => finish(), 4000); timer.unref()
    const finish = (headers?: Headers) => {
      if (settled) return
      settled = true; clearTimeout(timer); ready.signal.removeEventListener('abort', aborted); session.webRequest.onHeadersReceived(null); request.abort()
      if (headers) resolve(headers); else reject(new EnterpriseOnlineError('redirect'))
    }
    const aborted = () => finish()
    ready.signal.addEventListener('abort', aborted, { once: true })
    session.webRequest.onHeadersReceived((details, callback) => {
      try {
        if (details.url === ready.authenticatedUrl) {
          if (details.method !== 'GET' || details.statusCode !== 303 || !details.responseHeaders) refuse()
          const headers = new Headers()
          for (const [key, value] of Object.entries(details.responseHeaders)) {
            if (!Array.isArray(value) || value.length !== 1) refuse()
            headers.set(key, value[0]!)
          }
          originalHeaders = headers
        }
        callback({})
      } catch { callback({ cancel: true }); finish() }
    })
    request.on('redirect', (status, method, redirectUrl) => {
      try {
        active(ready.signal)
        if (status !== 303 || method !== 'GET' || redirectUrl !== clean || !originalHeaders) refuse()
        finish(originalHeaders)
      } catch { finish() }
    })
    request.on('response', () => finish()); request.on('error', () => finish())
    if (ready.signal.aborted) finish(); else request.end()
  })
}
/** Original index/token exchange, entirely in Main's nonpersistent, owned Session. */
export async function bootstrapEnterpriseOnline(session: Session, ready: EnterpriseCliReady): Promise<string> {
  if (session.isPersistent() || ready.host !== '127.0.0.1' || !Number.isSafeInteger(ready.port) || ready.port < 1 || ready.port > 65535) refuse()
  active(ready.signal)
  const clean = `http://127.0.0.1:${ready.port}/`, url = new URL(ready.authenticatedUrl), token = url.searchParams.get('token')
  if (!token || !/^[A-Za-z0-9_-]{16,256}$/u.test(token) || url.href !== clean + '?token=' + token) refuse()
  await session.clearStorageData({ storages: ['cookies'] }); active(ready.signal)
  const headers = await exchangeIndex(session, ready, clean)
  active(ready.signal)
  if (headers.get('location') !== './' || headers.get('cache-control') !== 'no-store'
    || headers.get('referrer-policy') !== 'no-referrer') refuse('headers')
  const name = 'dsh-auth-' + createHash('sha256').update(url.host).digest('base64url')
  const encoded = headers.get('set-cookie')
  if (!encoded || encoded.length > 4096) refuse('cookie')
  const match = /^([^=;]+)=(v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})); Max-Age=([1-9][0-9]*); Path=\/; Expires=([^;]+); HttpOnly; SameSite=Strict$/u.exec(encoded)
  if (!match || match[1] !== name) refuse('cookie-format')
  let payload: Record<string, unknown>
  try { payload = JSON.parse(Buffer.from(match[3]!, 'base64url').toString('utf8')) as Record<string, unknown> } catch { return refuse('cookie') }
  if (!payload || Object.keys(payload).sort().join() !== 'authority,expiresAt,issuedAt,version' || payload.version !== 1 || payload.authority !== url.host
    || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || (payload.issuedAt as number) > Date.now() + 1000 || (payload.issuedAt as number) < Date.now() - 10000
    || (payload.expiresAt as number) <= Date.now() || (payload.expiresAt as number) - (payload.issuedAt as number) !== Number(match[5]) * 1000
    || Date.parse(match[6]!) !== Math.floor((payload.expiresAt as number) / 1000) * 1000) refuse('cookie-payload')
  const cookies = await session.cookies.get({ url: clean }); active(ready.signal)
  // The original redirect must have persisted the cookie in this real Session.
  if (cookies.length !== 1) refuse('cookie-jar')
  const cookie = cookies[0]!
  if (cookie.name !== name || cookie.value !== match[2] || cookie.domain !== '127.0.0.1' || cookie.path !== '/' || !cookie.hostOnly
    || !cookie.httpOnly || cookie.secure || cookie.sameSite !== 'strict' || cookie.session || !cookie.expirationDate
    || Math.abs(cookie.expirationDate * 1000 - (payload.expiresAt as number)) > 1000) refuse('cookie-jar')
  const index = await session.fetch(clean, { redirect: 'error', credentials: 'include', signal: ready.signal }); active(ready.signal)
  if (index.status !== 200 || !index.headers.get('content-type')?.startsWith('text/html')) refuse('clean-index')
  await index.body?.cancel(); active(ready.signal)
  return clean
}

/** Hooks use the actual owned Session/WebContents/mainFrame. No Renderer caller API exists. */
export function installEnterpriseOnlineWindow(options: {
  readonly window: BrowserWindow; readonly session: Session; readonly partition: string
  readonly documentSignal: () => AbortSignal; readonly windowSignal: AbortSignal
  readonly failed: () => void
}) {
  const contents: WebContents = options.window.webContents
  let issuer: MainCallerProofIssuer | undefined
  const consumed = new WeakSet<AbortSignal>()
  let entry: { readonly ready: EnterpriseCliReady; readonly accountSignal: AbortSignal; readonly lifetime: AbortController; readonly release: () => void; url: string | undefined } | undefined
  const revokeDocument = () => { issuer?.close(); issuer = undefined }
  const detach = () => { revokeDocument(); const previous = entry; entry = undefined; previous?.lifetime.abort(); previous?.release() }
  const local = () => { detach(); if (!contents.isDestroyed() && !options.windowSignal.aborted) void options.window.loadURL(LOCAL_DRAFT_DOCUMENT).catch(options.failed) }
  const currentIssuer = (): MainCallerProofIssuer => {
    const owned = entry
    if (!owned?.url) throw new MainCallerProofError()
    active(owned.ready.signal, owned.accountSignal, owned.lifetime.signal, options.windowSignal, options.documentSignal())
    return issuer ??= new MainCallerProofIssuer({ contents, session: options.session, partition: options.partition,
      authority: new URL(owned.url).host, uiUrl: owned.url, accountSignal: owned.accountSignal, hostSignal: owned.ready.signal,
      windowSignal: AbortSignal.any([options.windowSignal, options.documentSignal(), owned.lifetime.signal]) })
  }
  options.session.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const url = new URL(details.url)
      if (!url.pathname.startsWith('/api/')) { callback({}); return }
      if (Object.values(details.requestHeaders).some(value => typeof value !== 'string')) throw new MainCallerProofError()
      const headers = currentIssuer().stampRequest({ ...details, requestHeaders: details.requestHeaders as Record<string, string> })
      callback({ requestHeaders: { ...headers } })
    } catch { callback({ cancel: true }) }
  })
  options.session.webRequest.onCompleted(details => issuer?.finishRequest(details.id))
  options.session.webRequest.onErrorOccurred(details => issuer?.finishRequest(details.id))
  const callerIssuer = Object.freeze({ assertRequest: async (request: MainCallerRequest, signal: AbortSignal): Promise<MainCallerPermit> => currentIssuer().assertRequest(request, signal) })
  const showOnline = async (ready: EnterpriseCliReady, accountSignal: AbortSignal): Promise<void> => {
    active(ready.signal, accountSignal, options.windowSignal)
    if (consumed.has(ready.signal)) refuse()
    consumed.add(ready.signal); detach()
    const lifetime = new AbortController(), cutoff = () => { if (entry === owned) local() }
    const owned = { ready, accountSignal, lifetime, release: () => { ready.signal.removeEventListener('abort', cutoff); accountSignal.removeEventListener('abort', cutoff) }, url: undefined as string | undefined }
    entry = owned
    ready.signal.addEventListener('abort', cutoff, { once: true }); accountSignal.addEventListener('abort', cutoff, { once: true })
    try {
      const url = await bootstrapEnterpriseOnline(options.session, Object.freeze({ ...ready, signal: AbortSignal.any([ready.signal, accountSignal, lifetime.signal, options.windowSignal]) }))
      active(ready.signal, accountSignal, lifetime.signal, options.windowSignal)
      if (entry !== owned) refuse()
      owned.url = url
      await options.window.loadURL(url)
      active(ready.signal, accountSignal, lifetime.signal, options.windowSignal)
      if (entry !== owned || contents.getURL() !== url || contents.mainFrame.detached
        || contents.mainFrame.url !== url || contents.mainFrame.top !== contents.mainFrame) refuse()
    } catch { if (entry === owned) local(); throw new EnterpriseOnlineError() }
  }
  /** Bounded Main-local facts only; no URL, credential, witness or object handle is returned. */
  const ownerFacts = () => Object.freeze({ online: !!entry?.url, documentActive: !options.documentSignal().aborted,
    windowActive: !options.windowSignal.aborted, hostActive: !!entry && !entry.ready.signal.aborted,
    accountActive: !!entry && !entry.accountSignal.aborted, frameAlive: !contents.isDestroyed() && !contents.mainFrame.detached,
    topIdentity: !contents.isDestroyed() && contents.mainFrame.top === contents.mainFrame,
    documentMatches: !!entry?.url && contents.getURL() === entry.url && contents.mainFrame.url === entry.url })
  return Object.freeze({ callerIssuer, showOnline, showLocal: local, revokeDocument, ownerFacts, close: () => {
    detach(); options.session.webRequest.onBeforeSendHeaders(null); options.session.webRequest.onCompleted(null); options.session.webRequest.onErrorOccurred(null)
  } })
}
