import { contextBridge, ipcRenderer } from 'electron'
import { LOCAL_DRAFT_CHANNELS, LOCAL_DRAFT_DOCUMENT } from './enterprise-local-ipc.ts'

// Main repeats the exact document, WebContents and top-frame checks for every call.
if (process.isMainFrame && location.href === LOCAL_DRAFT_DOCUMENT) {
  contextBridge.exposeInMainWorld('afosLocalDrafts', Object.freeze({
    state: () => ipcRenderer.invoke(LOCAL_DRAFT_CHANNELS.state),
    edit: (input: unknown) => ipcRenderer.invoke(LOCAL_DRAFT_CHANNELS.edit, input),
    subscribe(listener: () => void) {
      if (typeof listener !== 'function') throw new Error('enterprise/local-draft-refused')
      const changed = () => listener()
      ipcRenderer.on(LOCAL_DRAFT_CHANNELS.changed, changed)
      return () => ipcRenderer.off(LOCAL_DRAFT_CHANNELS.changed, changed)
    },
  }))
}
