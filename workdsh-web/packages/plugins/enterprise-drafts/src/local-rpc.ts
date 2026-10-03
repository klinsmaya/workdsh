import type { EnterpriseDraftClient, EnterpriseDraftState } from 'workdsh-contracts/enterprise-drafts';
import { DraftUiError, parseDraft, parseDraftEdit, parseState } from './rpc.js';

/** Main-owned preload capability. Only these fixed DTO operations cross the boundary. */
export interface LocalDraftCapability {
  state(): Promise<unknown>;
  edit(input: { readonly draftId: string; readonly content: string }): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}
export interface LocalDraftState extends EnterpriseDraftState {
  readonly authority: 'offline';
  readonly scopedLocalOnly: true;
}
export interface LocalDraftClient extends EnterpriseDraftClient {
  readonly scopedLocalOnly: true;
  state(signal?: AbortSignal): Promise<LocalDraftState>;
  subscribe(listener: () => void): () => void;
  close(): void;
}

/** No Connection/Session/Remote, carrier, persistence, identity choice or fallback. */
export function createLocalDraftClient(capability: LocalDraftCapability | undefined, lifetime: AbortSignal): LocalDraftClient {
  const listeners = new Set<() => void>();
  let epoch = 0, closed = false, available = false, unsubscribe: (() => void) | undefined;
  const changed = () => { if (!closed) { epoch++; for (const listener of listeners) listener(); } };
  const close = () => {
    if (closed) return;
    closed = true; epoch++; listeners.clear(); lifetime.removeEventListener('abort', close);
    const release = unsubscribe; unsubscribe = undefined;
    try { release?.(); } catch { /* No raw preload diagnostics reach the UI. */ }
  };
  if (!lifetime.aborted && capability && typeof capability.state === 'function' && typeof capability.edit === 'function' && typeof capability.subscribe === 'function') {
    try { unsubscribe = capability.subscribe(changed); available = typeof unsubscribe === 'function'; }
    catch { available = false; }
  }
  lifetime.addEventListener('abort', close, { once: true });
  if (lifetime.aborted) close();
  const assertCurrent = (captured: number, signal?: AbortSignal) => {
    if (closed || lifetime.aborted || signal?.aborted || captured !== epoch) throw new DraftUiError('closed');
    if (!available || !capability) throw new DraftUiError('unavailable');
  };
  const checked = async <T>(action: () => Promise<unknown>, parse: (value: unknown) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const captured = epoch; assertCurrent(captured, signal);
    let value: unknown;
    try { value = await action(); }
    catch { assertCurrent(captured, signal); throw new DraftUiError('unavailable'); }
    assertCurrent(captured, signal);
    const parsed = await parse(value);
    // SHA verification is asynchronous. A cutoff during hashing must not return
    // old account/project content even when the original invoke ignores cancel.
    assertCurrent(captured, signal); return parsed;
  };
  const offline = async (): Promise<never> => { throw new DraftUiError('offline'); };
  return Object.freeze({
    scopedLocalOnly: true as const,
    state: (signal?: AbortSignal) => checked(() => capability!.state(), async value => {
      const state = await parseState(value);
      return Object.freeze({ ...state, authority: 'offline' as const, scopedLocalOnly: true as const });
    }, signal),
    edit: async (draftId: string, content: string, signal?: AbortSignal) => {
      const input = parseDraftEdit({ draftId, content });
      return checked(() => capability!.edit(input), async value => {
        const draft = await parseDraft(value);
        if (draft.draftId !== input.draftId || draft.content !== input.content) throw new DraftUiError('conflict');
        return draft;
      }, signal);
    },
    materials: offline, snapshot: offline, start: offline, cancel: offline, archive: offline,
    subscribe: (listener: () => void) => {
      if (closed) throw new DraftUiError('closed');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    close,
  });
}
