import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { installEnterpriseOnlineWindow } from './enterprise-online-window.ts'
import { localAssetHandler } from './enterprise-assets.ts'
import { installLocalDraftIpc, LOCAL_DRAFT_DOCUMENT, type LocalDraftCapabilities } from './enterprise-local-ipc.ts'

interface EnterpriseLocalWindowOptions {
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow
  readonly ipc: IpcMain
  readonly appPath: string
  readonly capabilities: () => LocalDraftCapabilities
  readonly projectDraft: (record: unknown) => Promise<unknown>
  readonly closed: () => void
  readonly loadFailed: () => void
  readonly rendererGone?: () => void
  readonly closeRequested?: (event: { preventDefault(): void }) => void
}
const preparedWindows = new WeakSet<object>()
/** Precreate a fresh shell before disposing the old IPC owner; never reuse a detached frame or partition. */
function prepareWindow(createWindow: EnterpriseLocalWindowOptions['createWindow']) {
  const partition = 'afos-enterprise-' + randomUUID()
  const window = createWindow({ width: 1100, height: 760, title: 'AFOS', webPreferences: {
    contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true,
    webSecurity: true, webviewTag: false, partition,
    preload: fileURLToPath(new URL('./enterprise-preload.cjs', import.meta.url)),
  } })
  const prepared = Object.freeze({ window, partition })
  preparedWindows.add(prepared)
  return prepared
}

/** One local face of the existing enterprise window; no second shell or Host transport. */
export function createEnterpriseLocalWindow(options: EnterpriseLocalWindowOptions) {
  return bindWindow(options, prepareWindow(options.createWindow))
}
function bindWindow(options: EnterpriseLocalWindowOptions, prepared: ReturnType<typeof prepareWindow>) {
  if (!preparedWindows.delete(prepared)) throw new Error('enterprise/window-owner-refused')
  const { window, partition } = prepared
  const contents = window.webContents
  const session = contents.session
  const preventDownload = (event: { preventDefault(): void }) => event.preventDefault()
  let documentLifetime = new AbortController()
  const windowLifetime = new AbortController()
  let online: ReturnType<typeof installEnterpriseOnlineWindow> | undefined
  const navigating = (event: { isMainFrame: boolean }) => { if (event.isMainFrame) { documentLifetime.abort(); online?.revokeDocument(); documentLifetime = new AbortController() } }
  const revokeDocument = () => { documentLifetime.abort(); online?.revokeDocument() }
  const rendererGone = () => { revokeDocument(); try { online?.showLocal() } finally { options.rendererGone?.() } }
  const closeRequested = (event: { preventDefault(): void }) => options.closeRequested?.(event)
  contents.on('did-start-navigation', navigating)
  contents.on('render-process-gone', rendererGone)
  let current = true, installed = false
  let owner: ReturnType<typeof installLocalDraftIpc> | undefined
  const close = () => {
    if (!current) return
    current = false; windowLifetime.abort(); documentLifetime.abort(); online?.close(); contents.removeListener('did-start-navigation', navigating); contents.removeListener('render-process-gone', rendererGone); window.removeListener('close', closeRequested); owner?.close(); session.removeListener('will-download', preventDownload); if (installed) session.protocol.unhandle('afos-local')
    options.closed()
  }
  window.on('closed', close)
  window.on('close', closeRequested)
  try {
    const handler = localAssetHandler(join(options.appPath, 'renderer', 'afos-local'))
    session.protocol.handle('afos-local', handler); installed = true
    owner = installLocalDraftIpc({ ipc: options.ipc, owner: () => current ? contents : undefined,
      capabilities: options.capabilities, projectDraft: options.projectDraft, documentSignal: () => documentLifetime.signal })
    online = installEnterpriseOnlineWindow({ window, session, partition, documentSignal: () => documentLifetime.signal, windowSignal: windowLifetime.signal, failed: options.loadFailed })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    contents.on('will-attach-webview', event => event.preventDefault())
    session.on('will-download', preventDownload)
    const ready = window.loadURL(LOCAL_DRAFT_DOCUMENT)
    void ready.catch(() => { if (current) options.loadFailed() })
    return { window, owner, ready, online, revokeDocument, dispose: close }
  } catch (error) { close(); window.destroy(); throw error }
}

/** Main-native Start is the sole trigger for replacing a crashed owner and starting the existing Host. */
export function createEnterpriseWindowOwner(options: Omit<EnterpriseLocalWindowOptions, 'closed' | 'rendererGone' | 'closeRequested'> & {
  readonly startHost: () => Promise<void>
  readonly stopHost: () => Promise<void>
  readonly activated: (face: ReturnType<typeof createEnterpriseLocalWindow>) => void
  readonly closed: () => void
  readonly cleanupFailed: () => void
}) {
  type Face = ReturnType<typeof createEnterpriseLocalWindow>
  let current: Face | undefined, freshRequired = false, starting = false, startEpoch = 0
  let closing: Face | undefined
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    ++startEpoch
    // The Main stop action aborts execution synchronously, before any process-exit await.
    const work = options.stopHost()
    stopping = work
    void work.catch(options.cleanupFailed)
    return work
  }
  const bind = (prepared: ReturnType<typeof prepareWindow>): Face => {
    let face: Face | undefined
    face = bindWindow({ ...options,
      rendererGone: () => { if (!face || current !== face) return; freshRequired = true; if (closing !== face) void stop() },
      closeRequested: event => {
        if (!face || current !== face) return
        event.preventDefault()
        if (closing === face) return
        const owned = face; closing = owned; freshRequired = true; owned.revokeDocument()
        // Keep the last physical window alive while the existing Host drains. No quit/renderer loop.
        void stop().then(() => { if (current === owned && closing === owned && !owned.window.isDestroyed()) owned.window.destroy() })
          .catch(() => { if (closing === owned) closing = undefined })
      },
      closed: () => {
        if (!face || current !== face) return
        const stopAlreadyOwned = closing === face
        closing = undefined; current = undefined; freshRequired = true
        // Native Close already owns the stop; repeating it here races the existing quit/suspend cutoff.
        if (!stopAlreadyOwned) void stop()
        options.closed()
      },
      loadFailed: () => { if (!face || current !== face || closing === face) return; freshRequired = true; void stop(); options.loadFailed() },
    }, prepared)
    return face
  }
  current = bind(prepareWindow(options.createWindow)); options.activated(current)
  const startHost = async (): Promise<void> => {
    if (starting) throw new Error('enterprise/window-start-pending')
    if (closing) throw new Error('enterprise/window-owner-closing')
    starting = true
    const epoch = ++startEpoch
    const activeStart = () => { if (epoch !== startEpoch) throw new Error('enterprise/window-start-stopped') }
    try {
      if (stopping) await stopping
      activeStart()
      const previous = current
      if (!previous) throw new Error('enterprise/window-owner-refused')
      if (freshRequired || previous.window.isDestroyed() || previous.window.webContents.isDestroyed() || previous.window.webContents.mainFrame.detached) {
        const prepared = prepareWindow(options.createWindow)
        // Keep the old physical window alive until its replacement is installed and ready.
        // Its callbacks can no longer clear globals, stop a later Host or remove new IPC handlers.
        current = undefined; previous.dispose()
        let replacement: Face
        try {
          replacement = bind(prepared); current = replacement; options.activated(replacement); await replacement.ready
          activeStart()
          if (current !== replacement || replacement.window.isDestroyed() || replacement.window.webContents.mainFrame.detached) throw new Error('enterprise/window-owner-refused')
        }
        catch (error) {
          const failed = current
          // Discard only this failed owner's Close state; its delayed drain cannot own a later window.
          if (failed && closing === failed) closing = undefined
          current = undefined; failed?.dispose()
          if (!prepared.window.isDestroyed()) prepared.window.destroy()
          // The old shell remains available for a later explicit fresh-window retry.
          current = previous; freshRequired = true; options.activated(previous)
          throw error
        }
        freshRequired = false
        if (!previous.window.isDestroyed()) previous.window.destroy()
      }
      const owned = current
      if (!owned) throw new Error('enterprise/window-owner-refused')
      await owned.ready
      activeStart()
      if (current !== owned || freshRequired || owned.window.isDestroyed() || owned.window.webContents.mainFrame.detached) throw new Error('enterprise/window-owner-refused')
      await options.startHost()
      activeStart()
      if (current !== owned || freshRequired || owned.window.isDestroyed() || owned.window.webContents.mainFrame.detached) throw new Error('enterprise/window-owner-refused')
    } catch (error) { await stop(); throw error }
    finally { starting = false }
  }
  return Object.freeze({ current: () => current, startHost, stopHost: stop, cancelStart: () => { ++startEpoch } })
}
