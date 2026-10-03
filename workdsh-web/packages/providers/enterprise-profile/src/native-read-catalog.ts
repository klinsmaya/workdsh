import { getTraceable, symbols, type Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { SessionFollowFrame, SessionFollowRequest, SessionListValue, SessionPageRequest, SessionProjectionsRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import type { MainBusinessCapabilities } from './main-capabilities.js';
import { EnterpriseProfileError, SnapshotIdentityAuthority } from './snapshot-authority.js';
import type {} from './cli-bootstrap.js';
import type {} from '@deepseek-ai/dsh-session-query-sqlite';

type Grant = Awaited<ReturnType<MainBusinessCapabilities['ownedSessionRead']>>;
type OrdinaryFollowRequest = Omit<SessionFollowRequest, 'address'> & {
  readonly address: Extract<SessionFollowRequest['address'], { readonly kind: 'session' }>;
};
type WorkspaceController = { follow(signal: AbortSignal): AsyncIterable<unknown> };
type SettingsController = { describe(): unknown };
const denied = () => new EnterpriseProfileError('afos/native-read-denied');
/** Public Cordis proxy identity; no protected Controller property is inspected. */
function original<T extends object>(value:T):T {
  let current=value;
  for(let depth=0;depth<8;depth++) {const next=(current as T & {[symbols.original]?:T})[symbols.original];if(!next||next===current)return current;current=next;}
  throw denied();
}
function record(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(desc => !('value' in desc))) throw denied();
}
function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw denied();
  return value;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw denied();
}
function pageRequest(request: unknown): asserts request is SessionPageRequest {
  record(request, ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow']);
  record(request.address, ['kind', 'sessionId']);
  if (request.address.kind !== 'session') throw denied();
  sessionId(request.address.sessionId); integer(request.throughSeq, -1);
  if (request.beforeSeq !== undefined) integer(request.beforeSeq, 0);
  if (request.maxMessages !== undefined) integer(request.maxMessages, 1, 500);
  if (request.turnWindow !== undefined) {
    record(request.turnWindow, ['minMessages', 'minTurns']);
    integer(request.turnWindow.minMessages, 0, (request.maxMessages as number | undefined) ?? 500);
    integer(request.turnWindow.minTurns, 0, 100);
  }
}
function followRequest(request: unknown): asserts request is OrdinaryFollowRequest {
  record(request, ['address', 'assistantStream', 'maxMessages', 'turnWindow']);
  record(request.address, ['kind', 'sessionId']);
  if (request.address.kind !== 'session') throw denied();
  sessionId(request.address.sessionId);
  if (request.assistantStream !== undefined && request.assistantStream !== true) throw denied();
  if (request.maxMessages !== undefined) integer(request.maxMessages, 1, 500);
  if (request.turnWindow !== undefined) {
    record(request.turnWindow, ['minMessages', 'minTurns']);
    integer(request.turnWindow.minMessages, 0, (request.maxMessages as number | undefined) ?? 500);
    integer(request.turnWindow.minTurns, 0, 100);
  }
}

/** Business admission/filtering over the exact original private Controller and query provider. */
export class EnterpriseNativeReadCatalog {
  readonly identity: SnapshotIdentityAuthority;
  constructor(readonly owner: Context, readonly controller: SessionController, readonly controllerContext:Context, readonly lifetime: AbortSignal) {
    this.controllerContext=original(controllerContext);
    if(!(owner.afosIdentityAuthority instanceof SnapshotIdentityAuthority))throw new EnterpriseProfileError('afos/catalog-identity-unavailable');
    const captured=this.controllerContext.get('sessionController');
    if(!captured||original(captured)!==original(controller))throw new EnterpriseProfileError('afos/catalog-controller-mismatch');
    if(this.controllerContext.get('webServer')!==undefined)throw new EnterpriseProfileError('afos/catalog-public-ingress');
    this.controller=getTraceable(this.controllerContext,original(controller));
    this.identity=owner.afosIdentityAuthority;
  }
  private signal(caller: AbortSignal): AbortSignal {
    const signal = AbortSignal.any([caller, this.lifetime, ...(this.owner.afosMainBusiness.hostSignal ? [this.owner.afosMainBusiness.hostSignal] : [])]);
    signal.throwIfAborted(); return signal;
  }
  private assertComposition(): void {
    const controller = this.controllerContext.get('sessionController');
    if (!controller || original(controller) !== original(this.controller)
      || this.controllerContext.get('webServer') !== undefined) throw denied();
  }
  private async fresh(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.assertComposition();
    const identity = this.identity;
    await identity.current(identity.binding, signal);
    signal.throwIfAborted(); this.assertComposition();
  }
  /** Physical readiness asks current identity only, and grants no Session content. */
  async assertAuthority(caller: AbortSignal): Promise<void> { await this.fresh(this.signal(caller)); }
  private assertGrant(id: string, grant: Grant, signal: AbortSignal): void {
    signal.throwIfAborted();
    const expires = Date.parse(grant.expiresAt);
    if (grant.sessionId !== id || !grant.epoch || typeof grant.epoch !== 'object'
      || !(grant.signal instanceof AbortSignal) || grant.signal.aborted
      || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 60_000) throw denied();
  }
  private async grant(id: string, signal: AbortSignal, previous?: Grant): Promise<Grant> {
    await this.fresh(signal);
    const grant = await this.owner.afosMainBusiness.ownedSessionRead(id, signal);
    this.assertGrant(id, grant, signal);
    if (previous) { this.assertGrant(id, previous, signal); if (grant.epoch !== previous.epoch) throw denied(); }
    return grant;
  }
  /** Main's actual current-project Draft mapping supplies candidates; every ID still needs fresh ACL. */
  private async owners(signal: AbortSignal): Promise<Map<string, Grant>> {
    await this.fresh(signal);
    await this.owner.afosMainBusiness.asyncAccess?.refreshLocalState(signal);
    signal.throwIfAborted();
    const candidates = new Set(this.owner.afosMainBusiness.drafts()
      .filter(draft => draft.run.projectId === this.identity.projectId)
      .map(draft => sessionId(draft.sessionId)));
    const result = new Map<string, Grant>();
    for (const id of candidates) {
      try { result.set(id, await this.grant(id, signal)); }
      catch { signal.throwIfAborted(); await this.fresh(signal); }
    }
    await this.fresh(signal); return result;
  }
  private async allowed(id: string, owners: Map<string, Grant>, signal: AbortSignal): Promise<boolean> {
    const previous = owners.get(id); if (!previous) return false;
    try { await this.grant(id, signal, previous); return true; }
    catch { signal.throwIfAborted(); await this.fresh(signal); return false; }
  }
  /** Local availability only; storage still waits for an exact fresh Main read grant. */
  isColdSession(request: unknown): boolean {
    record(request, ['address', 'assistantStream', 'maxMessages', 'turnWindow']);
    record(request.address, ['kind', 'sessionId']);
    if (request.address.kind !== 'session') throw denied(); sessionId(request.address.sessionId);
    this.assertComposition();
    const id = SessionId(sessionId(request.address.sessionId)), agents = this.owner.get('agents'), sessions = this.owner.get('sessions');
    if (!agents || !sessions) throw denied();
    return !agents.get(id) && !sessions.get(id);
  }
  /** Continue one original live iterator under fresh short Main read grants. */
  async *liveFollow(request: unknown, caller: AbortSignal, carrierExpiresAt: number): AsyncIterable<SessionFollowFrame> {
    followRequest(request);
    const id = SessionId(sessionId(request.address.sessionId)), signal = this.signal(caller);
    const agents = this.owner.get('agents'), sessions = this.owner.get('sessions');
    const agent = agents?.get(id), session = sessions?.get(id), query = this.controllerContext.get('sessionQuery');
    if (!agent || !session || original(agent.session) !== original(session) || !query
      || !Number.isSafeInteger(carrierExpiresAt) || carrierExpiresAt <= Date.now()
      || carrierExpiresAt > Date.now() + 60_000) throw denied();
    const assertLive = () => {
      this.assertComposition();
      const currentQuery = this.controllerContext.get('sessionQuery');
      const currentAgent = this.owner.get('agents')?.get(id), currentSession = this.owner.get('sessions')?.get(id);
      const privateAgent = this.controllerContext.get('agents')?.get(id), privateSession = this.controllerContext.get('sessions')?.get(id);
      if (this.owner.get('afosDraftRuntime')?.nativeSessionId() !== id || !currentQuery
        || original(currentQuery) !== original(query) || !currentAgent || !currentSession || !privateAgent || !privateSession
        || original(currentAgent) !== original(agent) || original(currentSession) !== original(session)
        || original(privateAgent) !== original(agent) || original(privateSession) !== original(session)
        || original(currentAgent.session) !== original(session)) throw denied();
    };
    assertLive();
    let grant = await this.grant(id, signal); assertLive();
    const ended = new AbortController(), combined = AbortSignal.any([signal, grant.signal, ended.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ended.abort(denied()),
      Math.max(1, Math.min(Date.parse(grant.expiresAt), carrierExpiresAt) - Date.now())); timer.unref(); };
    const renew = async () => {
      while (!combined.aborted) {
        const remaining = Math.min(Date.parse(grant.expiresAt), carrierExpiresAt) - Date.now();
        await new Promise<void>(resolve => {
          let wake: ReturnType<typeof setTimeout>;
          const done = () => { clearTimeout(wake); combined.removeEventListener('abort', done); resolve(); };
          if (combined.aborted) resolve();
          else { wake = setTimeout(done, Math.max(1, Math.min(3_000, Math.floor(remaining / 2)))); wake.unref(); combined.addEventListener('abort', done, { once: true }); }
        });
        if (combined.aborted) return;
        const previous = grant, fresh = await this.grant(id, combined, previous);
        assertLive(); if (fresh.signal !== previous.signal) throw denied();
        combined.throwIfAborted(); grant = fresh; arm();
      }
    };
    arm();
    const renewal = renew().catch(error => { if (!combined.aborted) ended.abort(error); });
    let iterator: AsyncIterator<SessionFollowFrame> | undefined;
    try {
      iterator = this.controller.follow(request, combined)[Symbol.asyncIterator]();
      while (!combined.aborted) {
        const frame = await iterator.next();
        combined.throwIfAborted(); assertLive();
        if (frame.done) return;
        const previous = grant, fresh = await this.grant(id, combined, previous);
        assertLive(); if (fresh.signal !== previous.signal) throw denied();
        combined.throwIfAborted(); grant = fresh; arm();
        yield frame.value;
      }
      combined.throwIfAborted();
    } finally {
      ended.abort(); clearTimeout(timer);
      try { await iterator?.return?.(); } finally { await renewal; }
    }
  }
  /** One public opening snapshot; never resume the original iterator into cold Agent promotion. */
  async *coldFollow(request: unknown, caller: AbortSignal, carrierExpiresAt: number): AsyncIterable<SessionFollowFrame> {
    followRequest(request);
    const id = sessionId(request.address.sessionId), signal = this.signal(caller);
    if (!this.isColdSession(request) || !Number.isSafeInteger(carrierExpiresAt)
      || carrierExpiresAt <= Date.now() || carrierExpiresAt > Date.now() + 60_000) throw denied();
    const query = this.controllerContext.get('sessionQuery'); if (!query) throw denied();
    let grant = await this.grant(id, signal); const expiry = new AbortController();
    const combined = AbortSignal.any([signal, grant.signal, expiry.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => expiry.abort(),
      Math.max(1, Math.min(Date.parse(grant.expiresAt), carrierExpiresAt) - Date.now())); timer.unref(); };
    arm();
    try {
      const openingQuery = this.controllerContext.get('sessionQuery');
      if (!openingQuery || original(openingQuery) !== original(query) || !this.isColdSession(request)) throw denied();
      const iterator = this.controller.follow(request, combined)[Symbol.asyncIterator]();
      let first: IteratorResult<SessionFollowFrame>;
      try { first = await iterator.next(); }
      finally { await iterator.return?.(); }
      const fresh = await this.grant(id, combined, grant);
      const currentQuery = this.controllerContext.get('sessionQuery');
      if (!currentQuery || original(currentQuery) !== original(query)
        || fresh.signal !== grant.signal || !this.isColdSession(request) || first.done
        || first.value.type !== 'snapshot' || first.value.header.id !== id || first.value.header.origin === 'subagent'
        || !Number.isSafeInteger(first.value.cursor) || first.value.cursor < -1
        || first.value.projections.asOfSeq > first.value.cursor
        || (request.assistantStream === true && (first.value.assistantStream?.revision !== 0 || first.value.assistantStream.activeAttempt !== undefined))) throw denied();
      combined.throwIfAborted(); grant = fresh; arm();
      yield first.value;
      // Revalidate only business authority. The original history iterator is already closed.
      // The physical caller's fixed deadline still ends the existing Gateway generation.
      while (!combined.aborted) {
        const remaining = Math.min(Date.parse(grant.expiresAt), carrierExpiresAt) - Date.now();
        const delay = Math.max(1, Math.min(3_000, Math.floor(remaining / 2)));
        await new Promise<void>(resolve => {
          let wake: ReturnType<typeof setTimeout>;
          const done = () => { clearTimeout(wake); combined.removeEventListener('abort', done); resolve(); };
          if (combined.aborted) resolve();
          else { wake = setTimeout(done, delay); wake.unref(); combined.addEventListener('abort', done, { once: true }); }
        });
        if (combined.aborted) return;
        let renewed: Grant;
        try { renewed = await this.grant(id, combined, grant); }
        catch (error) {
          // A cancelled private read can reject with an IPC outcome marker. Once
          // this logical owner ended, leave carrier retry to the original Gateway.
          if (combined.aborted) return;
          throw error;
        }
        const current = this.controllerContext.get('sessionQuery');
        if (renewed.signal !== grant.signal || !current || original(current) !== original(query)
          || !this.isColdSession(request)) throw denied();
        combined.throwIfAborted(); grant = renewed; arm();
      }
    } finally { clearTimeout(timer); expiry.abort(); }
  }
  async list(request: unknown, caller: AbortSignal): Promise<SessionListValue> {
    record(request, []); const signal = this.signal(caller), owners = await this.owners(signal);
    const original = await this.controller.list({}, signal);
    await this.fresh(signal);
    const items: SessionListValue['items'][number][] = [];
    for (const item of original.items) if (item.origin !== 'subagent' && await this.allowed(String(item.sessionId), owners, signal)) items.push(item);
    await this.fresh(signal); return { items };
  }
  async projections(request: unknown, caller: AbortSignal) {
    record(request, ['sessionId']); const id = sessionId(request.sessionId), signal = this.signal(caller);
    const grant = await this.grant(id, signal), combined = AbortSignal.any([signal, grant.signal]);
    const value = await this.controller.projections({ sessionId: SessionId(id) } satisfies SessionProjectionsRequest, combined);
    await this.grant(id, combined, grant); return value;
  }
  async page(request: unknown, caller: AbortSignal) {
    pageRequest(request); if(request.address.kind!=='session')throw denied(); const id = sessionId(request.address.sessionId), signal = this.signal(caller);
    const grant = await this.grant(id, signal), combined = AbortSignal.any([signal, grant.signal]);
    // Public observation owns the legitimate cut/lease. It prepares cold JSONL without Agent resolution.
    const query=this.controllerContext.get('sessionQuery'); if(!query)throw denied();
    const observation = await query.observeSession(SessionId(id), { signal: combined, projectionMode: 'none' });
    try {
      await this.grant(id, combined, grant);
      if (observation.header.id !== id || observation.header.origin === 'subagent' || request.throughSeq > observation.cursor) throw denied();
      const value = await this.controller.page(request, combined);
      await this.grant(id, combined, grant); return value;
    } finally { observation[Symbol.dispose](); }
  }
  async describe(caller: AbortSignal) {
    const signal = this.signal(caller); await this.fresh(signal);
    const controller = this.controllerContext.get('settingsController') as SettingsController | undefined;
    if (!controller || typeof controller.describe !== 'function') throw denied();
    const value = controller.describe(); // Original redaction/provider error; never fabricated settings.
    await this.fresh(signal); return value;
  }
  async *control(caller: AbortSignal): AsyncIterable<unknown> {
    const signal = this.signal(caller); await this.fresh(signal);
    for await (const frame of this.controller.control(signal)) {
      const owners = await this.owners(signal);
      if (frame.type === 'baseline') {
        const projections: Record<string, unknown> = {};
        for (const [id, block] of Object.entries(frame.value.projections)) if (await this.allowed(id, owners, signal)) projections[id] = block;
        await this.fresh(signal); yield { type: 'baseline', value: { projections } };
      } else if (await this.allowed(String(frame.sessionId), owners, signal)) {
        await this.fresh(signal); yield frame;
      }
    }
  }
  async *workspace(caller: AbortSignal): AsyncIterable<unknown> {
    const signal = this.signal(caller); await this.fresh(signal);
    const controller = this.controllerContext.get('workspaceController') as WorkspaceController | undefined;
    if (!controller || typeof controller.follow !== 'function') throw denied();
    const visible = new Map<string,readonly string[]>();
    const sessionIds = async (ids: unknown, owners: Map<string, Grant>) => {
      if (!Array.isArray(ids)) throw denied(); const result: string[] = [];
      for (const id of ids) if (typeof id === 'string' && await this.allowed(id, owners, signal)) result.push(id);
      return result;
    };
    const workspace = async (value: unknown, owners: Map<string, Grant>) => {
      record(value, ['workspaceId', 'path', 'title', 'sessionIds', 'createdAt', 'updatedAt']);
      if (typeof value.workspaceId !== 'string') throw denied();
      const ids = await sessionIds(value.sessionIds, owners);
      if (!ids.length) return undefined; // No Main-owned Session gives authority to disclose a local Workspace path.
      return { ...value, workspaceId:value.workspaceId, sessionIds: ids };
    };
    for await (const value of controller.follow(signal)) {
      const owners = await this.owners(signal); record(value, ['type', 'value', 'workspace', 'workspaceId', 'workspaceIds', 'archivedSessionIds', 'pinnedSessionIds']);
      let frame: unknown;
      if (value.type === 'baseline') {
        record(value.value, ['items', 'archivedSessionIds', 'pinnedSessionIds']);
        if (!Array.isArray(value.value.items)) throw denied(); const items = [];
        for (const item of value.value.items) { const filtered = await workspace(item, owners); if (filtered) { items.push(filtered); visible.set(filtered.workspaceId,filtered.sessionIds); } }
        frame = { type: 'baseline', value: { items, archivedSessionIds: await sessionIds(value.value.archivedSessionIds, owners), pinnedSessionIds: await sessionIds(value.value.pinnedSessionIds, owners) } };
      } else if (value.type === 'upsert') {
        const filtered = await workspace(value.workspace, owners);
        if (filtered) { visible.set(filtered.workspaceId,filtered.sessionIds); frame = { type: 'upsert', workspace: filtered }; }
        else if (typeof (value.workspace as Record<string, unknown>)?.workspaceId === 'string' && visible.delete(String((value.workspace as Record<string, unknown>).workspaceId))) frame = { type: 'remove', workspaceId: (value.workspace as Record<string, unknown>).workspaceId };
      } else if (value.type === 'remove') {
        if (typeof value.workspaceId === 'string' && visible.delete(value.workspaceId)) frame = value;
      } else if (value.type === 'order') {
        if (!Array.isArray(value.workspaceIds)) throw denied(); const workspaceIds=[];
        for(const id of value.workspaceIds)if(typeof id==='string'&&visible.has(id)&& (await sessionIds(visible.get(id),owners)).length)workspaceIds.push(id);
        frame = { type: 'order', workspaceIds };
      } else if (value.type === 'archived') frame = { type: 'archived', archivedSessionIds: await sessionIds(value.archivedSessionIds, owners) };
      else if (value.type === 'pinned') frame = { type: 'pinned', pinnedSessionIds: await sessionIds(value.pinnedSessionIds, owners) };
      else throw denied();
      await this.fresh(signal); if (frame !== undefined) yield frame;
    }
  }
}
