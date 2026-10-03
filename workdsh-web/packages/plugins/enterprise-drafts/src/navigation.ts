import type { ConnectionGeneration, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { ISessions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client';
import type { DraftPanelModel } from './model.js';

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { enterpriseDraftNavigation: unknown; }
}

export class NativeNavigationError extends Error {
  constructor(readonly code: 'cancelled' | 'changed' | 'unavailable') {
    super(code); this.name = 'NativeNavigationError';
  }
}
interface Intent { readonly projectId: string; readonly draftId: string; readonly sessionId: string; }
interface Operation { readonly intent: Intent; readonly controller: AbortController; generation?: ConnectionGeneration; }
/** Await one consumer operation, without cancelling a shared original read/open. */
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
function waitForGeneration(connection: ConnectionHandle, signal: AbortSignal): Promise<ConnectionGeneration> {
  signal.throwIfAborted();
  const current = connection.generation.getSnapshot(); if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (generation?: ConnectionGeneration) => {
      if (settled) return; settled = true;
      unsubscribe(); signal.removeEventListener('abort', aborted);
      if (generation) resolve(generation); else reject(signal.reason);
    };
    const read = () => { const value = connection.generation.getSnapshot(); if (value) finish(value); };
    const aborted = () => finish();
    signal.addEventListener('abort', aborted, { once: true });
    unsubscribe = connection.generation.subscribe(read);
    if (settled) unsubscribe();
    read(); if (signal.aborted) aborted();
  });
}
/** Host membership and binding allocation belong to the original Controller. */
function waitForCatalog(sessions: ISessions, sessionId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}, settled = false;
    const finish = (error?: unknown) => {
      if (settled) return; settled = true; unsubscribe(); signal.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error); else resolve();
    };
    const read = () => {
      const value = sessions.list.getSnapshot();
      const id = value.ids.find(id => id === sessionId);
      if (value.phase === 'ready' && id !== undefined && value.byId[id]?.id === id) finish();
    };
    const aborted = () => finish(signal.reason ?? new NativeNavigationError('cancelled'));
    signal.addEventListener('abort', aborted, { once: true }); unsubscribe = sessions.list.subscribe(read);
    if (settled) unsubscribe(); read(); if (signal.aborted) aborted();
  });
}

/** Operation-local navigation; original Connection, Main and Session remain the truths. */
export class NativeSessionNavigation {
  private active?: Operation;
  private closed = false;
  private readonly disposeGeneration: () => void;
  private readonly disposeModel: () => void;
  constructor(private readonly connection: ConnectionHandle, private readonly sessions: ISessions,
    private readonly remote: Pick<ClientRemote, 'session'>, private readonly model: DraftPanelModel,
    private readonly openView: (sessionId: SessionTarget) => void, private readonly timeoutMs = 30_000) {
    this.disposeGeneration = connection.generation.subscribe(() => {
      const op = this.active;
      if (op?.generation && connection.generation.getSnapshot() !== op.generation) this.cancel('changed');
    });
    this.disposeModel = model.subscribe(() => {
      const op = this.active, view = model.getSnapshot(); if (!op) return;
      if (view.error || view.state?.authority === 'offline') this.cancel('changed');
      // First ready triggers the original reset/repull. Its temporarily absent
      // business view cannot authorize navigation; final checks require a fresh view.
      if (view.state && !this.matches(op.intent)) this.cancel('changed');
    });
  }
  private selected(): Intent | undefined {
    const view = this.model.getSnapshot(), state = view.state;
    if (!state || state.authority !== 'current' || view.error) return;
    const draft = state.drafts.find(row => row.draftId === view.selectedDraftId);
    return draft && { projectId: state.project.id, draftId: draft.draftId, sessionId: draft.sessionId };
  }
  private matches(intent: Intent): boolean {
    const current = this.selected();
    return !!current && current.projectId === intent.projectId && current.draftId === intent.draftId && current.sessionId === intent.sessionId;
  }
  private assertCurrent(op: Operation): void {
    op.controller.signal.throwIfAborted();
    if (this.closed || this.active !== op || !op.generation || this.connection.generation.getSnapshot() !== op.generation || !this.matches(op.intent)) throw new NativeNavigationError('changed');
  }
  /** First establishment is awaited; a reset of an acquired generation cancels. */
  connectionReset(): void { if (this.active?.generation) this.cancel('changed'); }
  cancel(code: 'cancelled' | 'changed' = 'cancelled'): void { this.active?.controller.abort(new NativeNavigationError(code)); }
  close(): void { this.closed = true; this.cancel(); this.disposeGeneration(); this.disposeModel(); }
  async open(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.cancel();
    const intent = this.selected();
    if (this.closed || !intent || intent.sessionId !== sessionId) throw new NativeNavigationError('changed');
    signal?.throwIfAborted();
    const op: Operation = { intent, controller: new AbortController(), generation: this.connection.generation.getSnapshot() }; this.active = op;
    const abort = () => op.controller.abort(signal?.reason ?? new NativeNavigationError('cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => op.controller.abort(new NativeNavigationError('unavailable')), this.timeoutMs);
    let reference: ReturnType<ISessions['retain']> | undefined;
    try {
      if (!op.generation) op.generation = await waitForGeneration(this.connection, op.controller.signal);
      op.controller.signal.throwIfAborted();
      if (this.connection.generation.getSnapshot() !== op.generation) throw new NativeNavigationError('changed');
      await cancellable(this.model.refresh(), op.controller.signal);
      this.assertCurrent(op);
      // Catalog READY may be an offline cache. Require the actual original
      // generated read result, whose Host facade rechecks current Main ownership.
      const result = await cancellable(this.remote.session.list({}, op.controller.signal), op.controller.signal);
      this.assertCurrent(op);
      if (!result.ok || !result.value.items.some(row => row.sessionId === sessionId)) throw new NativeNavigationError('unavailable');
      // A direct Remote result does not publish the original Controller catalog.
      // Await its own public baseline before allocating the known target binding.
      await cancellable(this.sessions.refresh(), op.controller.signal);
      this.assertCurrent(op);
      await waitForCatalog(this.sessions, sessionId, op.controller.signal);
      this.assertCurrent(op);
      reference = this.sessions.retain(sessionId as SessionTarget, { source: 'enterpriseDraftNavigation', signal: op.controller.signal });
      const binding = await cancellable(reference.ready, op.controller.signal);
      this.assertCurrent(op);
      const snapshot = binding.session.getSnapshot();
      if (reference.binding !== binding || this.sessions.binding(binding.sessionId) !== binding || binding.sessionId !== sessionId || snapshot.sessionId !== sessionId || snapshot.openState !== 'open' || snapshot.openError || snapshot.removed) throw new NativeNavigationError('unavailable');
      // The original view owner retains synchronously before our finally releases.
      this.openView(sessionId as SessionTarget);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); reference?.release();
      if (this.active === op) this.active = undefined;
    }
  }
}
