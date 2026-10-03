import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEnterpriseWindowOwner } from '../src/enterprise-window.ts'
import { LOCAL_DRAFT_CHANNELS, LOCAL_DRAFT_DOCUMENT } from '../src/enterprise-local-ipc.ts'

vi.mock('electron', () => ({ net: { request: vi.fn() } }))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

class Contents extends EventEmitter {
  readonly mainFrame: { detached: boolean; url: string; top?: unknown } = { detached: false, url: LOCAL_DRAFT_DOCUMENT }
  readonly session = Object.assign(new EventEmitter(), {
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    webRequest: { onBeforeSendHeaders: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() },
  })
  destroyed = false
  constructor() { super(); this.mainFrame.top = this.mainFrame }
  isDestroyed() { return this.destroyed }
  getURL() { return this.mainFrame.url }
  setWindowOpenHandler() {}
  send() {}
}
class Window extends EventEmitter {
  readonly webContents = new Contents()
  destroyed = false
  constructor(readonly id: number, readonly options: BrowserWindowConstructorOptions, readonly load: (window: Window) => Promise<void>) { super() }
  isDestroyed() { return this.destroyed }
  loadURL(url: string) { this.webContents.emit('did-start-navigation', { isMainFrame: true }); this.webContents.mainFrame.url = url; return this.load(this) }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.destroyed = true; this.emit('closed') }
  close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true } }); if (!prevented) this.destroy() }
  crash() { this.webContents.mainFrame.detached = true; this.webContents.emit('render-process-gone') }
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'afos-fresh-window-')); roots.push(base)
  const directory = join(base, 'renderer', 'afos-local'); mkdirSync(directory, { recursive: true })
  const html = Buffer.from('<p>Owned local fixture</p>'); writeFileSync(join(directory, 'index.html'), html)
  writeFileSync(join(directory, 'assets.json'), JSON.stringify({ contractVersion: 'afos.local-assets.v1', files: [{ file: 'index.html', bytes: html.length, sha256: createHash('sha256').update(html).digest('hex'), type: 'text/html' }] }))
  const windows: Window[] = [], handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>(), trace: string[] = []
  let starts = 0, stops = 0, closed = 0, failures = 0, creationFailure = false, ipcFailure = false, active: Window | undefined
  let load: (window: Window) => Promise<void> = async () => {}, start: () => Promise<void> = async () => {}
  let stop: () => Promise<void> = async () => {}
  let projection: (record: unknown) => Promise<unknown> = async record => record
  const account = new AbortController()
  const ipc = { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    trace.push('handle:' + channel); if (ipcFailure && windows.length > 1) throw new Error('fixture/ipc-bind-failed')
    if (handlers.has(channel)) throw new Error('fixture/duplicate-handler'); handlers.set(channel, handler)
  }, removeHandler: (channel: string) => { trace.push('remove:' + channel); handlers.delete(channel) } }
  const owner = createEnterpriseWindowOwner({
    createWindow: options => { if (creationFailure && windows.length) throw new Error('fixture/window-create-failed'); const window = new Window(windows.length + 1, options, w => load(w)); trace.push('create:' + window.id); windows.push(window); return window as unknown as BrowserWindow },
    ipc: ipc as unknown as IpcMain, appPath: base,
    capabilities: () => ({ accountSignal: account.signal, localState: () => ({ project: { id: 'p1', name: 'P1' }, authority: 'offline', lastSyncAt: new Date().toISOString() }), drafts: () => [{}], editDraft: () => ({}) }),
    projectDraft: record => projection(record), activated: face => { active = face.window as unknown as Window; trace.push('active:' + active.id) },
    startHost: async () => { starts++; trace.push('start:' + active?.id); await start() },
    stopHost: async () => { stops++; trace.push('stop:' + active?.id); await stop() }, closed: () => { closed++; active = undefined },
    loadFailed: () => { failures++ }, cleanupFailed: () => { failures++ },
  })
  return { owner, windows, handlers, trace, state: () => ({ starts, stops, closed, failures, active }),
    creationFailure: (value: boolean) => { creationFailure = value }, ipcFailure: (value: boolean) => { ipcFailure = value },
    load: (value: typeof load) => { load = value }, start: (value: typeof start) => { start = value }, stop: (value: typeof stop) => { stop = value }, projection: (value: typeof projection) => { projection = value } }
}

describe('owned fresh window lifecycle', () => {
  it('synchronously refuses old in-flight document state and stops before any explicit restart', async () => {
    const f = fixture(), first = f.windows[0]!, entered = Promise.withResolvers<void>(), result = Promise.withResolvers<unknown>()
    f.projection(async () => { entered.resolve(); return result.promise })
    const pending = f.handlers.get(LOCAL_DRAFT_CHANNELS.state)!({ sender: first.webContents, senderFrame: first.webContents.mainFrame })
    const refused = expect(pending).rejects.toThrow('enterprise/local-draft-refused'); await entered.promise
    first.crash(); expect(f.state().stops).toBe(1); expect(f.state().starts).toBe(0); expect(f.windows).toHaveLength(1)
    await refused; result.resolve({}); expect(f.owner.current()!.online.ownerFacts().frameAlive).toBe(false)
  })
  it('precreates a new partition and frame, disposes old IPC before bind, then starts the existing Host', async () => {
    const f = fixture(), old = f.windows[0]!, oldFace = f.owner.current()!, late = [...old.listeners('closed')]
    old.crash(); await f.owner.startHost(); const fresh = f.windows[1]!
    expect(f.state()).toMatchObject({ starts: 1, stops: 1, closed: 0, active: fresh })
    expect(old.destroyed).toBe(true); expect(fresh.destroyed).toBe(false); expect(fresh.webContents.mainFrame).not.toBe(old.webContents.mainFrame)
    expect(fresh.options.webPreferences!.partition).not.toBe(old.options.webPreferences!.partition)
    const secondCreate = f.trace.indexOf('create:2'), firstRemove = f.trace.indexOf('remove:' + LOCAL_DRAFT_CHANNELS.state), secondHandle = f.trace.lastIndexOf('handle:' + LOCAL_DRAFT_CHANNELS.state)
    expect(secondCreate).toBeLessThan(firstRemove); expect(firstRemove).toBeLessThan(secondHandle)
    expect(f.trace.indexOf('active:2')).toBeLessThan(f.trace.indexOf('start:2'))
    for (const callback of late) callback(); oldFace.dispose(); old.webContents.emit('render-process-gone')
    expect(f.state()).toMatchObject({ starts: 1, stops: 1, closed: 0, active: fresh }); expect(f.handlers.size).toBe(2)
  })
  it('ordinary document reload keeps the owner and never triggers a Host restart', async () => {
    const f = fixture(), old = f.windows[0]!
    await old.loadURL(LOCAL_DRAFT_DOCUMENT); expect(f.state()).toMatchObject({ starts: 0, stops: 0 }); await f.owner.startHost()
    expect(f.windows).toHaveLength(1); expect(f.state().starts).toBe(1)
  })
  it('native Close revokes immediately and retains the last physical window until Host drain', async () => {
    const f = fixture(), window = f.windows[0]!, drained = Promise.withResolvers<void>(); f.stop(() => drained.promise)
    window.close(); window.close(); expect(window.destroyed).toBe(false); expect(f.state()).toMatchObject({ stops: 1, closed: 0, active: window })
    expect(f.owner.current()!.online.ownerFacts().documentActive).toBe(false)
    window.crash(); window.close(); const closeStops = f.state().stops
    await expect(f.owner.startHost()).rejects.toThrow('enterprise/window-owner-closing')
    drained.resolve(); await new Promise(resolve => setTimeout(resolve,0)); expect(window.destroyed).toBe(true); expect(f.owner.current()).toBeUndefined(); expect(closeStops).toBe(1); expect(f.state()).toMatchObject({ closed: 1, stops: 1, failures: 0 })
  })
  it('failed native Close drain retains the local physical shell and refuses online Start', async () => {
    const f = fixture(), window = f.windows[0]!; f.stop(async () => { throw new Error('fixture/drain-refused') })
    window.close(); await new Promise(resolve => setTimeout(resolve,0)); expect(window.destroyed).toBe(false); expect(f.state().failures).toBe(1)
    await expect(f.owner.startHost()).rejects.toThrow('fixture/drain-refused'); expect(f.state().starts).toBe(0)
  })
  it('retains the old physical shell when fresh construction fails and accepts a later explicit retry', async () => {
    const f = fixture(), old = f.windows[0]!; old.crash(); f.creationFailure(true)
    await expect(f.owner.startHost()).rejects.toThrow('fixture/window-create-failed'); expect(old.destroyed).toBe(false); expect(f.state().starts).toBe(0)
    f.creationFailure(false); await f.owner.startHost(); expect(f.state().starts).toBe(1); expect(old.destroyed).toBe(true)
  })
  it('cleans failed IPC installation without touching a future owner or starting a Host', async () => {
    const f = fixture(), old = f.windows[0]!; old.crash(); f.ipcFailure(true)
    await expect(f.owner.startHost()).rejects.toThrow('fixture/ipc-bind-failed'); expect(old.destroyed).toBe(false); expect(f.windows[1]!.destroyed).toBe(true); expect(f.state().starts).toBe(0)
    f.ipcFailure(false); await f.owner.startHost(); expect(f.state().starts).toBe(1); expect(f.handlers.size).toBe(2); expect(f.state().active).toBe(f.windows[2])
  })
  it('retains local shell and stops when replacement document load fails', async () => {
    const f = fixture(), old = f.windows[0]!; old.crash(); f.load(async w => { if (w.id === 2) throw new Error('fixture/load-failed') })
    await expect(f.owner.startHost()).rejects.toThrow('fixture/load-failed'); expect(f.state().starts).toBe(0); expect(old.destroyed).toBe(false); expect(f.windows[1]!.destroyed).toBe(true)
    f.load(async () => {}); await f.owner.startHost(); expect(f.state().starts).toBe(1)
  })
  for (const first of ['ready', 'drain']) it(`Close during preparation rolls back and retries when ${first} completes first`, async () => {
    const f = fixture(), previous = f.windows[0]!, entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>()
    previous.crash(); await new Promise(resolve => setTimeout(resolve, 0))
    f.stop(() => drained.promise); f.load(async window => { if (window.id === 2) { entered.resolve(); await ready.promise } })
    const pending = f.owner.startHost(), refused = expect(pending).rejects.toThrow('enterprise/window-start-stopped'); await entered.promise
    const replacement = f.windows[1]!, failedFace = f.owner.current()!; replacement.close(); replacement.close()
    expect(replacement.destroyed).toBe(false); expect(failedFace.online.ownerFacts().documentActive).toBe(false)
    if (first === 'ready') ready.resolve(); else drained.resolve()
    await new Promise(resolve => setTimeout(resolve, 0)); expect(replacement.destroyed).toBe(true); expect(previous.destroyed).toBe(false)
    if (first === 'ready') drained.resolve(); else ready.resolve()
    await refused; expect(f.owner.current()!.window).toBe(previous); expect(f.state().starts).toBe(0)
    f.stop(async () => {}); f.load(async () => {}); await f.owner.startHost()
    const future = f.owner.current()!, stops = f.state().stops, trace = f.trace.length
    failedFace.dispose(); replacement.webContents.emit('render-process-gone')
    expect(f.owner.current()).toBe(future); expect(future.window.isDestroyed()).toBe(false); expect(f.handlers.size).toBe(2)
    expect(f.trace).toHaveLength(trace); expect(f.state()).toMatchObject({ starts: 1, stops, failures: 0 })
  })
  it('a late disposed Close drain cannot destroy a future owner or clear its pending Close', async () => {
    const f = fixture(), previous = f.windows[0]!, entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), oldDrain = Promise.withResolvers<void>()
    previous.crash(); await new Promise(resolve => setTimeout(resolve, 0))
    let calls = 0; f.stop(() => ++calls === 1 ? oldDrain.promise : Promise.resolve())
    f.load(async window => { if (window.id === 2) { entered.resolve(); await ready.promise } })
    const pending = f.owner.startHost(), refused = expect(pending).rejects.toThrow('enterprise/window-start-stopped'); await entered.promise
    f.windows[1]!.close(); ready.resolve(); await refused
    expect(f.windows[1]!.destroyed).toBe(true); expect(f.owner.current()!.window).toBe(previous)
    f.load(async () => {}); await f.owner.startHost(); const future = f.owner.current()!, futureWindow = f.windows[2]!
    expect(f.state().starts).toBe(1); expect(f.handlers.size).toBe(2)
    const futureDrain = Promise.withResolvers<void>(); f.stop(() => futureDrain.promise); futureWindow.close()
    const stops = f.state().stops; oldDrain.resolve(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.owner.current()).toBe(future); expect(futureWindow.destroyed).toBe(false); expect(f.state().stops).toBe(stops)
    await expect(f.owner.startHost()).rejects.toThrow('enterprise/window-owner-closing')
    futureDrain.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); expect(futureWindow.destroyed).toBe(true)
    expect(f.owner.current()).toBeUndefined(); expect(f.state().failures).toBe(0)
  })
  it('a preparation load failure during Close shares its stop and preserves explicit retry', async () => {
    const f = fixture(), previous = f.windows[0]!, entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>()
    previous.crash(); await new Promise(resolve => setTimeout(resolve, 0)); const priorStops = f.state().stops
    f.stop(() => drained.promise); f.load(async window => { if (window.id === 2) { entered.resolve(); await ready.promise } })
    const pending = f.owner.startHost(), refused = expect(pending).rejects.toThrow('fixture/preparation-load-failed'); await entered.promise
    f.windows[1]!.close(); ready.reject(new Error('fixture/preparation-load-failed')); await new Promise(resolve => setTimeout(resolve, 0))
    const closeStops = f.state().stops
    drained.resolve(); await refused; expect(closeStops).toBe(priorStops + 2) // Close drain and failed Start rollback only.
    expect(f.owner.current()!.window).toBe(previous); expect(previous.destroyed).toBe(false)
    f.stop(async () => {}); f.load(async () => {}); await f.owner.startHost(); expect(f.state().starts).toBe(1); expect(f.state().failures).toBe(0)
  })
  for (const action of ['stop', 'account-project-suspend-cutoff']) it(`a ${action} during preparation cancels Start before Host admission`, async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); f.windows[0]!.crash()
    f.load(async w => { if (w.id === 2) { entered.resolve(); await ready.promise } })
    const pending = f.owner.startHost(), refused = expect(pending).rejects.toThrow('enterprise/window-start-stopped'); await entered.promise
    if (action === 'stop') await f.owner.stopHost(); else f.owner.cancelStart()
    ready.resolve(); await refused; expect(f.state().starts).toBe(0); expect(f.windows[0]!.destroyed).toBe(false)
  })
  it('concurrent explicit Start refuses duplicate admission without stopping the pending Start', async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); f.start(async () => { entered.resolve(); await ready.promise })
    const pending = f.owner.startHost(); await entered.promise
    await expect(f.owner.startHost()).rejects.toThrow('enterprise/window-start-pending'); expect(f.state().stops).toBe(0)
    ready.resolve(); await pending; expect(f.state().starts).toBe(1)
  })
  it('repeated crashes own exactly one active window and late close cannot clear the current owner', async () => {
    const f = fixture(), partitions = new Set<string>()
    for (let i = 0; i < 3; i++) { const previous = f.state().active!; partitions.add(previous.options.webPreferences!.partition!); previous.crash(); await f.owner.startHost(); expect(f.windows.filter(w => !w.destroyed)).toHaveLength(1); expect(f.state().closed).toBe(0) }
    expect(partitions.size).toBe(3); expect(f.state().starts).toBe(3)
    const current = f.state().active!; current.destroy(); expect(f.owner.current()).toBeUndefined(); expect(f.state().closed).toBe(1); expect(f.state().stops).toBe(4)
    await expect(f.owner.startHost()).rejects.toThrow('enterprise/window-owner-refused')
  })
})
