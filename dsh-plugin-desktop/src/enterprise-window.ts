import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localAssetHandler } from './enterprise-assets.ts'
import { installLocalDraftIpc, LOCAL_DRAFT_DOCUMENT, type LocalDraftCapabilities } from './enterprise-local-ipc.ts'

/** One local face of the existing enterprise window; no second shell or Host transport. */
export function createEnterpriseLocalWindow(options: {
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow
  readonly ipc: IpcMain
  readonly appPath: string
  readonly capabilities: () => LocalDraftCapabilities
  readonly projectDraft: (record: unknown) => Promise<unknown>
  readonly closed: () => void
  readonly loadFailed: () => void
}) {
  const handler = localAssetHandler(join(options.appPath, 'renderer', 'afos-local'))
  const window = options.createWindow({ width: 1100, height: 760, title: 'AFOS', webPreferences: {
    contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true,
    webSecurity: true, webviewTag: false, partition: 'afos-local-drafts',
    preload: fileURLToPath(new URL('./enterprise-preload.cjs', import.meta.url)),
  } })
  const contents = window.webContents
  const session = contents.session
  const preventDownload = (event: { preventDefault(): void }) => event.preventDefault()
  let documentLifetime = new AbortController()
  const navigating = (event: { isMainFrame: boolean }) => { if (event.isMainFrame) { documentLifetime.abort(); documentLifetime = new AbortController() } }
  contents.on('did-start-navigation', navigating)
  let current = true, installed = false
  let owner: ReturnType<typeof installLocalDraftIpc> | undefined
  const close = () => {
    if (!current) return
    current = false; documentLifetime.abort(); contents.removeListener('did-start-navigation', navigating); owner?.close(); session.removeListener('will-download', preventDownload); if (installed) session.protocol.unhandle('afos-local')
    options.closed()
  }
  window.on('closed', close)
  try {
    session.protocol.handle('afos-local', handler); installed = true
    owner = installLocalDraftIpc({ ipc: options.ipc, owner: () => current ? contents : undefined,
      capabilities: options.capabilities, projectDraft: options.projectDraft, documentSignal: () => documentLifetime.signal })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    contents.on('will-attach-webview', event => event.preventDefault())
    session.on('will-download', preventDownload)
    const ready = window.loadURL(LOCAL_DRAFT_DOCUMENT)
    void ready.catch(() => options.loadFailed())
    return { window, owner, ready }
  } catch (error) { close(); window.destroy(); throw error }
}
