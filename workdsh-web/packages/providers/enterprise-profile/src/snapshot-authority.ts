import type { AuthorizationRequest, EnterpriseAuthorityResult, EnterpriseAuthorityState, EnterpriseBinding, NocoBaseIdentityAuthority } from 'workdsh-contracts';

export class EnterpriseProfileError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EnterpriseProfileError'; }
}
function fail(code: string): never { throw new EnterpriseProfileError(code); }
function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail('afos/profile-invalid-authority');
}
function text(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f]/u.test(value);
}
function sameBinding(left: EnterpriseBinding, right: EnterpriseBinding): boolean {
  return left.issuer === right.issuer && left.subject === right.subject && left.organizationId === right.organizationId && left.deviceId === right.deviceId;
}

/** Private Main business transport; there is no URL, token or caller-selected binding. */
export type CurrentSnapshot = (projectId: string, signal: AbortSignal) => Promise<unknown>;

/** Fixed project and immutable Host identity, verified again for every operation. */
export class SnapshotIdentityAuthority implements NocoBaseIdentityAuthority {
  readonly binding: EnterpriseBinding;
  readonly projectId: string;
  readonly #snapshot: CurrentSnapshot;
  readonly #lifetime = new AbortController();
  constructor(binding: EnterpriseBinding, projectId: string, snapshot: CurrentSnapshot) {
    if (!binding || !text(binding.issuer, 1024) || !text(binding.subject) || !text(binding.organizationId) || !text(binding.deviceId) || !text(projectId) || typeof snapshot !== 'function') fail('afos/profile-invalid-binding');
    let issuer: URL;
    try { issuer = new URL(binding.issuer); } catch { fail('afos/profile-invalid-binding'); }
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) fail('afos/profile-invalid-binding');
    this.binding = Object.freeze({ ...binding }); this.projectId = projectId; this.#snapshot = snapshot;
  }
  cutoff(): void { this.#lifetime.abort(new EnterpriseProfileError('afos/profile-cutoff')); }

  async current(binding: EnterpriseBinding, signal: AbortSignal): Promise<EnterpriseAuthorityState> {
    return (await this.read(binding, signal)).state;
  }
  async authorize(binding: EnterpriseBinding, request: AuthorizationRequest, signal: AbortSignal): Promise<EnterpriseAuthorityResult> {
    const { state, revision } = await this.read(binding, signal);
    const allow = request?.actor?.principalId === this.binding.subject
      && request.actor.organizationId === this.binding.organizationId
      && request.actor.resolvedBy === 'workdsh-identity-nocobase'
      && text(request.actor.sessionId) && request.resource?.domain === 'session'
      && request.resource.id === request.actor.sessionId && text(request.resource.id)
      && request.resource.revision === undefined
      && request.owner?.organizationId === this.binding.organizationId
      && request.owner.ownerPrincipalId === this.binding.subject && request.owner.scope === 'personal'
      && request.owner.projectId === undefined && (request.action === 'read' || request.action === 'use');
    return Object.freeze({ ...state, decision: Object.freeze({ effect: allow ? 'allow' : 'deny', code: allow ? 'afos/current-project-session' : 'afos/authority-scope-denied', authorizationRevision: revision, grantIds: Object.freeze([]) }) });
  }
  private async read(binding: EnterpriseBinding, signal: AbortSignal): Promise<{ state: EnterpriseAuthorityState; revision: string }> {
    if (!binding || !sameBinding(binding, this.binding)) fail('afos/profile-binding-mismatch');
    const combined = AbortSignal.any([signal, this.#lifetime.signal]); combined.throwIfAborted();
    let value: unknown;
    try { value = await this.#snapshot(this.projectId, combined); }
    catch (error) { if (!signal.aborted) this.cutoff(); throw error; }
    combined.throwIfAborted();
    try {
      record(value, ['contractVersion', 'binding', 'project', 'permissions', 'authorizationRevision', 'expiresAt']);
      record(value.binding, ['issuer', 'subject', 'organizationId', 'deviceId']);
      record(value.project, ['id', 'organizationId', 'name']); record(value.permissions, ['read', 'archive']);
      if (value.contractVersion !== 'afos.identity.v1' || !sameBinding(value.binding as unknown as EnterpriseBinding, this.binding)
        || value.project.id !== this.projectId || value.project.organizationId !== this.binding.organizationId
        || !text(value.project.name) || value.permissions.read !== true || typeof value.permissions.archive !== 'boolean'
        || typeof value.authorizationRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.authorizationRevision)
        || typeof value.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value.expiresAt)) fail('afos/profile-invalid-authority');
      const expiresAt = Date.parse(value.expiresAt);
      if (!Number.isSafeInteger(expiresAt) || ![new Date(expiresAt).toISOString(), new Date(expiresAt).toISOString().replace('.000Z', 'Z')].includes(value.expiresAt)
        || expiresAt <= Date.now() || expiresAt > Date.now() + 5000) fail('afos/profile-stale-authority');
      const revision = value.authorizationRevision;
      const state: EnterpriseAuthorityState = Object.freeze({ binding: this.binding, expiresAt, profile: Object.freeze({
        principalId: this.binding.subject, principalKind: 'human', resolvedBy: 'workdsh-identity-nocobase',
        organization: Object.freeze({ id: this.binding.organizationId, kind: 'team', name: this.binding.organizationId, revision }),
        membership: Object.freeze({ organizationId: this.binding.organizationId, principalId: this.binding.subject, principalKind: 'human', role: 'member', state: 'active', revision }),
      }) });
      return { state, revision };
    } catch (error) { this.cutoff(); throw error; }
  }
}
