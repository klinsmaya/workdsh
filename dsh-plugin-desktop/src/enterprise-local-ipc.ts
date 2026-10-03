import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

export const LOCAL_DRAFT_CHANNELS = Object.freeze({ state: 'afos:local-drafts:state', edit: 'afos:local-drafts:edit', changed: 'afos:local-drafts:changed' })
export const LOCAL_DRAFT_DOCUMENT = 'afos-local://drafts/index.html'
export interface LocalDraftCapabilities {
  readonly accountSignal: AbortSignal
  localState(): { readonly project: { readonly id: string; readonly name: string }; readonly authority: 'offline'; readonly lastSyncAt: string }
  drafts(): readonly unknown[]
  editDraft(draftId: string, content: string): unknown
}
export interface LocalDraftIpcOptions {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  readonly owner: () => WebContents | undefined
  readonly capabilities: () => LocalDraftCapabilities
  readonly documentSignal?: () => AbortSignal
  /** Public, stateless original enterprise-profile draftView; supplied only by Main. */
  readonly projectDraft: (record: unknown) => Promise<unknown>
}
export class LocalDraftIpcError extends Error { constructor() { super('enterprise/local-draft-refused') } }
function refuse(): never { throw new LocalDraftIpcError() }
function editInput(value: unknown): { draftId: string; content: string } {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) refuse()
  const entries = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(entries).length !== 2 || !entries.draftId || !entries.content || !('value' in entries.draftId) || !('value' in entries.content)) refuse()
  const { draftId, content } = value as { draftId: unknown; content: unknown }
  if (typeof draftId !== 'string' || !draftId || draftId.length > 256 || /[\u0000-\u001f\u007f]/u.test(draftId)
    || typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > 65536) refuse()
  return { draftId, content }
}
/** Two finite Main handlers. A local Renderer never receives a business/Host capability. */
export function installLocalDraftIpc(options: LocalDraftIpcOptions): { changed(): void; close(): void } {
  let closed = false
  const lifetime = new AbortController()
  let watched: AbortSignal | undefined
  const notify = () => {
    const owner = options.owner()
    try { if (!closed && owner && !owner.isDestroyed() && owner.mainFrame.url === LOCAL_DRAFT_DOCUMENT) owner.send(LOCAL_DRAFT_CHANNELS.changed) } catch { /* A destroyed Renderer receives no data. */ }
  }
  const sender = (event: IpcMainInvokeEvent): void => {
    const owner = options.owner()
    if (closed || !owner || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame
      || event.senderFrame?.url !== LOCAL_DRAFT_DOCUMENT) refuse()
  }
  const capture = () => {
    const cap = options.capabilities(), documentSignal = options.documentSignal?.() ?? lifetime.signal
    if (!(cap.accountSignal instanceof AbortSignal) || !(documentSignal instanceof AbortSignal)) refuse()
    if (watched !== cap.accountSignal) {
      watched?.removeEventListener('abort', notify); watched = cap.accountSignal
      watched.addEventListener('abort', notify, { once: true })
    }
    const check = () => {
      if (closed || lifetime.signal.aborted || cap.accountSignal.aborted || documentSignal.aborted || options.capabilities().accountSignal !== cap.accountSignal || (options.documentSignal && options.documentSignal() !== documentSignal)) refuse()
    }
    check(); return { cap, check, documentSignal }
  }
  const bounded = (value: unknown): unknown => {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json) > 8 * 1048576) refuse()
    return JSON.parse(json) as unknown
  }
  const project = async (record: unknown, captured: ReturnType<typeof capture>): Promise<unknown> => {
    const signal = AbortSignal.any([captured.cap.accountSignal, captured.documentSignal, lifetime.signal, AbortSignal.timeout(10000)])
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    try {
      const value = await Promise.race([options.projectDraft(record), new Promise<never>((_resolve, reject) => {
        abort = () => reject(new LocalDraftIpcError()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      })])
      captured.check(); return value
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  }
  options.ipc.handle(LOCAL_DRAFT_CHANNELS.state, async (event, ...args: unknown[]) => {
    try {
      sender(event); if (args.length) refuse()
      const captured = capture(), { cap, check } = captured, local = cap.localState()
      if (local.authority !== 'offline') refuse()
      const rows = cap.drafts(); if (rows.length > 128) refuse()
      const drafts = []
      for (const row of rows) { drafts.push(await project(row, captured)); check(); sender(event) }
      check(); sender(event)
      return bounded({ contractVersion: 'afos.drafts.v1', project: { id: local.project.id, name: local.project.name }, authority: 'offline', lastSyncAt: local.lastSyncAt, drafts })
    } catch { throw new LocalDraftIpcError() }
  })
  try { options.ipc.handle(LOCAL_DRAFT_CHANNELS.edit, async (event, ...args: unknown[]) => {
    try {
      sender(event); if (args.length !== 1) refuse()
      const input = editInput(args[0]), captured = capture(), { cap, check } = captured
      check(); const record = cap.editDraft(input.draftId, input.content)
      const view = await project(record, captured); check(); sender(event)
      return bounded(view)
    } catch { throw new LocalDraftIpcError() }
  }) } catch (error) { closed = true; lifetime.abort(); options.ipc.removeHandler(LOCAL_DRAFT_CHANNELS.state); throw error }
  return {
    changed: notify,
    close() { if (closed) return; closed = true; lifetime.abort(); watched?.removeEventListener('abort', notify); watched = undefined; options.ipc.removeHandler(LOCAL_DRAFT_CHANNELS.state); options.ipc.removeHandler(LOCAL_DRAFT_CHANNELS.edit) },
  }
}
