import { getTraceable, symbols, type Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { SessionListValue, SessionPageRequest, SessionProjectionsRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import type { MainBusinessCapabilities } from './main-capabilities.js';
import { EnterpriseProfileError, SnapshotIdentityAuthority } from './snapshot-authority.js';
import type {} from './cli-bootstrap.js';
import type {} from '@deepseek-ai/dsh-session-query-sqlite';

type Grant = Awaited<ReturnType<MainBusinessCapabilities['ownedSessionRead']>>;
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
  private async fresh(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const identity = this.identity;
    await identity.current(identity.binding, signal);
    signal.throwIfAborted();
  }
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
