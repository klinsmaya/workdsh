import { randomBytes } from 'node:crypto'

export const NATIVE_WITNESS_HEADER = 'x-afos-native-witness'
const HTTP_PATHS = new Set([
  '/api/session/list', '/api/session/page', '/api/session/projections',
  '/api/settings/describe',
  ...['state', 'materials', 'snapshot', 'start', 'edit', 'cancel', 'archive'].map(name => '/api/afos/drafts/' + name),
  '/api/afos/createSession', '/api/afos/readSnapshot', '/api/afos/renderDraft',
])
const MUX_PATH = '/api/remote.mux'
interface Frame { readonly detached: boolean; readonly url: string; readonly top: Frame | null }
interface TrustedContents {
  readonly id: number
  readonly session: object
  readonly mainFrame: Frame
  isDestroyed(): boolean
  getURL(): string
}
/** Only real Main object references belong here, never a Renderer DTO. */
export interface MainCallerOwner {
  readonly contents: TrustedContents
  readonly session: object
  readonly partition: string
  readonly authority: string
  readonly uiUrl: string
  readonly accountSignal: AbortSignal
  readonly hostSignal: AbortSignal
  readonly windowSignal: AbortSignal
}
export interface MainCallerRequest {
  readonly witness: string
  readonly method: string
  readonly path: string
  readonly authority: string
}
export interface MainCallerPermit { readonly signal: AbortSignal; readonly expiresAt: number; assertCurrent(): void; close(): void }
/** Public Electron webRequest detail subset; missing identity/frame facts fail closed. */
export interface MainCallerStampDetails {
  readonly id: number
  readonly url: string
  readonly method: string
  readonly resourceType: string
  readonly webContentsId?: number
  readonly webContents?: TrustedContents
  readonly frame?: Frame | null
  readonly requestHeaders: Readonly<Record<string, string>>
}
export class MainCallerProofError extends Error {
  constructor() { super('enterprise/native-caller-refused') }
}
function refuse(): never { throw new MainCallerProofError() }
function canonicalAuthority(value: string): string {
  if (typeof value !== 'string' || !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value)) refuse()
  const parsed = new URL('http://' + value)
  if (parsed.host !== value || Number(parsed.port) > 65535) refuse()
  return value
}
function finite(method: string, path: string): void {
  if (!(method === 'POST' && HTTP_PATHS.has(path) || method === 'GET' && path === MUX_PATH)) refuse()
}
/** Main-private finite issuer. It owns no transport, enterprise identity or permission. */
export class MainCallerProofIssuer {
  private readonly owner: MainCallerOwner
  private readonly lifetime = new AbortController()
  private readonly signal: AbortSignal
  private readonly witnesses = new Map<string, { requestId: number; frame: Frame; method: string; path: string; expiresAt: number }>()
  private readonly pendingRequestIds = new Map<number, string>()
  private readonly permits = new Set<{ abort: AbortController; timer: ReturnType<typeof setTimeout> }>()
  private readonly cutoff: () => void
  constructor(owner: MainCallerOwner) {
    canonicalAuthority(owner.authority)
    if (!owner.contents || owner.contents.session !== owner.session || !owner.session
      || !/^afos-[a-z0-9-]{1,64}$/u.test(owner.partition)
      || ![owner.accountSignal, owner.hostSignal, owner.windowSignal].every(value => value instanceof AbortSignal)
      || ![ 'http://' + owner.authority + '/', 'afos-local://drafts/index.html' ].includes(owner.uiUrl)) refuse()
    this.owner = Object.freeze({ ...owner })
    this.signal = AbortSignal.any([owner.accountSignal, owner.hostSignal, owner.windowSignal, this.lifetime.signal])
    this.cutoff = () => this.close()
    this.current()
    // Retain direct source listeners; AbortSignal.any alone is not an owner.
    for (const source of [owner.accountSignal, owner.hostSignal, owner.windowSignal]) source.addEventListener('abort', this.cutoff, { once: true })
  }
  private current(frame?: Frame): void {
    if (this.signal.aborted || this.owner.contents.isDestroyed() || this.owner.contents.session !== this.owner.session
      || this.owner.contents.getURL() !== this.owner.uiUrl || this.owner.contents.mainFrame.detached
      || this.owner.contents.mainFrame.url !== this.owner.uiUrl || this.owner.contents.mainFrame.top !== this.owner.contents.mainFrame
      || frame && frame !== this.owner.contents.mainFrame) refuse()
  }
  /** Only call from the owned Main webRequest hook. The returned headers never enter a preload/API. */
  stampRequest(details: MainCallerStampDetails): Readonly<Record<string, string>> {
    this.current(details.frame ?? undefined)
    if (!details.frame || details.webContents !== this.owner.contents || details.webContentsId !== this.owner.contents.id
      || !Number.isSafeInteger(details.id) || details.id < 1
      || Object.keys(details.requestHeaders).some(key => key.toLowerCase() === NATIVE_WITNESS_HEADER)) refuse()
    const url = new URL(details.url)
    const websocket = details.resourceType === 'webSocket'
    if (url.host !== this.owner.authority || url.username || url.password || url.search || url.hash
      || url.href !== (websocket ? 'ws://' : 'http://') + this.owner.authority + url.pathname
      || !(websocket ? url.protocol === 'ws:' : url.protocol === 'http:' && details.resourceType === 'xhr')) refuse()
    finite(details.method, url.pathname)
    if (websocket !== (url.pathname === MUX_PATH)) refuse()
    this.prune()
    if (this.witnesses.size >= 32 || this.pendingRequestIds.has(details.id)) refuse()
    const witness = randomBytes(32).toString('base64url')
    this.witnesses.set(witness, { requestId: details.id, frame: details.frame, method: details.method, path: url.pathname, expiresAt: Date.now() + 5000 })
    this.pendingRequestIds.set(details.id, witness)
    return Object.freeze({ ...details.requestHeaders, [NATIVE_WITNESS_HEADER]: witness })
  }
  /** Main network completion/error hook can remove a never-consumed witness. */
  finishRequest(requestId: number): void {
    const witness = this.pendingRequestIds.get(requestId)
    if (witness) { this.witnesses.delete(witness); this.pendingRequestIds.delete(requestId) }
  }
  private prune(): void {
    for (const entry of this.witnesses.values()) if (entry.expiresAt <= Date.now()) this.finishRequest(entry.requestId)
  }
  /** Existing private child IPC may only echo the four bounded request facts. */
  async assertRequest(request: MainCallerRequest, signal: AbortSignal): Promise<MainCallerPermit> {
    signal.throwIfAborted(); this.current()
    if (this.permits.size >= 64) refuse()
    if (!request || Object.getPrototypeOf(request) !== Object.prototype
      || Reflect.ownKeys(request).length !== 4 || Reflect.ownKeys(request).some(key => typeof key !== 'string' || !['witness', 'method', 'path', 'authority'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(request)).some(descriptor => !('value' in descriptor))
      || typeof request.witness !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(request.witness)) refuse()
    const captured = this.witnesses.get(request.witness)
    if (!captured) refuse()
    // A wrong attempt also burns the witness. It cannot be retried as another path.
    this.finishRequest(captured.requestId)
    this.current(captured.frame)
    if (captured.expiresAt <= Date.now() || request.authority !== this.owner.authority
      || request.method !== captured.method || request.path !== captured.path) refuse()
    finite(request.method, request.path)
    const abort = new AbortController(), expiresAt = Date.now() + 60_000
    const combined = AbortSignal.any([this.signal, abort.signal])
    const timer = setTimeout(() => { abort.abort(); this.permits.delete(entry) }, Math.max(1, expiresAt - Date.now())); timer.unref()
    const entry = { abort, timer }; this.permits.add(entry)
    return Object.freeze({ signal: combined, expiresAt,
      assertCurrent: () => { this.current(captured.frame); combined.throwIfAborted(); if (expiresAt <= Date.now()) refuse() },
      close: () => { clearTimeout(timer); abort.abort(); this.permits.delete(entry) },
    })
  }
  close(): void {
    this.lifetime.abort(); this.witnesses.clear(); this.pendingRequestIds.clear()
    for (const entry of this.permits) { clearTimeout(entry.timer); entry.abort.abort() }
    this.permits.clear()
    for (const source of [this.owner.accountSignal, this.owner.hostSignal, this.owner.windowSignal]) source.removeEventListener('abort', this.cutoff)
  }
}
