import { createHash, randomUUID } from 'node:crypto';
import type {
  ActorContext, AuthorizationDecision, AuthorizationRequest, IdentityProfile,
  IdentityResolutionContext, Membership, RuntimeBindingRequest,
  EnterpriseBinding, EnterpriseAuthorityState, NocoBaseIdentityAuthority, EnterpriseIdentityService,
} from 'workdsh-contracts';

export type { EnterpriseBinding, EnterpriseAuthorityState, EnterpriseAuthorityResult,
  NocoBaseIdentityAuthority, EnterpriseIdentityService } from 'workdsh-contracts';

export class EnterpriseIdentityError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EnterpriseIdentityError'; }
}
function deny(code: string): never { throw new EnterpriseIdentityError(code); }
function bounded(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f]/u.test(value);
}
function validateBinding(binding: EnterpriseBinding): void {
  if (!binding || !bounded(binding.issuer, 1024) || !bounded(binding.subject)
      || !bounded(binding.organizationId) || !bounded(binding.deviceId)) deny('identity-nocobase/invalid-binding');
  let issuer: URL;
  try { issuer = new URL(binding.issuer); } catch { deny('identity-nocobase/invalid-issuer'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) deny('identity-nocobase/invalid-issuer');
}
function sameBinding(left: EnterpriseBinding, right: EnterpriseBinding): boolean {
  return left.issuer === right.issuer && left.subject === right.subject
    && left.organizationId === right.organizationId && left.deviceId === right.deviceId;
}
export function enterpriseNamespace(binding: EnterpriseBinding): string {
  validateBinding(binding);
  return createHash('sha256').update(JSON.stringify([
    binding.issuer, binding.subject, binding.organizationId, binding.deviceId,
  ])).digest('hex');
}

interface ActorEvidence { readonly generation: number; readonly validUntil: number }

/** One immutable enterprise identity per Host; never an enterprise user database. */
export class NocoBaseIdentityProvider implements EnterpriseIdentityService {
  readonly id = 'workdsh-identity-nocobase';
  readonly enterprise = true as const;
  readonly binding: EnterpriseBinding;
  readonly namespace: string;
  readonly #authority: NocoBaseIdentityAuthority;
  readonly #freshnessMs: number;
  readonly #actors = new WeakMap<ActorContext, ActorEvidence>();
  readonly #requests = new Set<AbortController>();
  readonly #lifetime = new AbortController();
  #generation = 0;
  #cutoff = false;
  #profile?: IdentityProfile;
  #profileValidUntil = 0;

  constructor(binding: EnterpriseBinding, authority: NocoBaseIdentityAuthority, freshnessMs = 1000) {
    validateBinding(binding);
    if (!authority || typeof authority.current !== 'function' || typeof authority.authorize !== 'function') deny('identity-nocobase/authority-required');
    if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 1 || freshnessMs > 5000) deny('identity-nocobase/invalid-freshness');
    this.binding = Object.freeze({ ...binding });
    this.namespace = enterpriseNamespace(this.binding);
    this.#authority = authority;
    this.#freshnessMs = freshnessMs;
  }

  /** Irreversible for this Host. Account changes require stopping it and creating a new Host. */
  cutoff(): void {
    if (this.#cutoff) return;
    this.#cutoff = true;
    this.#generation += 1;
    this.#lifetime.abort();
    this.#profile = undefined;
    this.#profileValidUntil = 0;
    for (const request of this.#requests) request.abort();
  }

  profile(): IdentityProfile {
    if (this.#cutoff || !this.#profile || this.#profileValidUntil <= Date.now()) deny('identity-nocobase/not-current');
    return this.#profile;
  }

  membership(organizationId: string, principalId: string): Membership | undefined {
    if (this.#cutoff || !this.#profile || this.#profileValidUntil <= Date.now()) return undefined;
    return organizationId === this.binding.organizationId && principalId === this.binding.subject ? this.#profile.membership : undefined;
  }

  async resolve(evidence?: IdentityResolutionContext, signal?: AbortSignal): Promise<ActorContext> {
    if (evidence?.sessionId !== undefined && !bounded(evidence.sessionId)) deny('identity-nocobase/invalid-session');
    if (evidence?.runId !== undefined && !bounded(evidence.runId)) deny('identity-nocobase/invalid-run');
    const { validUntil, generation } = await this.current(signal);
    const actor: ActorContext = Object.freeze({
      principalId: this.binding.subject, organizationId: this.binding.organizationId,
      requestId: randomUUID(), resolvedBy: this.id,
      ...(evidence?.sessionId === undefined ? {} : { sessionId: evidence.sessionId }),
      ...(evidence?.runId === undefined ? {} : { runId: evidence.runId }),
    });
    this.#actors.set(actor, { generation, validUntil });
    this.assertCurrentActor(actor);
    return actor;
  }

  assertCurrentActor(actor: ActorContext): void {
    const evidence = this.#actors.get(actor);
    if (this.#cutoff || !evidence || evidence.generation !== this.#generation
        || evidence.validUntil <= Date.now() || actor.principalId !== this.binding.subject
        || actor.organizationId !== this.binding.organizationId || actor.resolvedBy !== this.id) deny('identity-nocobase/stale-actor');
  }

  /** Cooperative call deadline; trusted around wrappers must preserve this signal. */
  actorSignal(actor: ActorContext): AbortSignal {
    this.assertCurrentActor(actor);
    const evidence = this.#actors.get(actor)!;
    return AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(Math.max(1, evidence.validUntil - Date.now()))]);
  }

  async authorizeEnterprise(request: AuthorizationRequest, signal?: AbortSignal): Promise<AuthorizationDecision> {
    this.assertCurrentActor(request.actor);
    if (request.owner.organizationId !== this.binding.organizationId) deny('identity-nocobase/cross-organization');
    const generation = this.#generation;
    const startedAt = Date.now();
    const result = await this.request(signal, requestSignal => this.#authority.authorize(this.binding, request, requestSignal));
    const validUntil = this.acceptState(result, generation, startedAt);
    const decision = result.decision;
    if (!decision || !['allow', 'deny'].includes(decision.effect)
        || !bounded(decision.code) || !bounded(decision.authorizationRevision)
        || !Array.isArray(decision.grantIds) || decision.grantIds.length > 128
        || decision.grantIds.some(value => !bounded(value))) {
      this.cutoff(); deny('identity-nocobase/invalid-decision');
    }
    this.#actors.set(request.actor, { generation, validUntil });
    this.assertCurrentActor(request.actor);
    return Object.freeze({ ...decision, grantIds: Object.freeze([...decision.grantIds]) });
  }

  async authorizeSessionBinding(actor: ActorContext, request: Pick<RuntimeBindingRequest, 'sessionId' | 'workspaceId'>, signal?: AbortSignal): Promise<void> {
    if (!bounded(request.sessionId) || (request.workspaceId !== undefined && !bounded(request.workspaceId))) deny('identity-nocobase/invalid-session');
    if (actor.sessionId !== request.sessionId) deny('identity-nocobase/session-context-mismatch');
    const result = await this.authorizeEnterprise({
      actor, action: 'use', resource: { domain: 'session', id: request.sessionId },
      owner: { organizationId: this.binding.organizationId, ownerPrincipalId: this.binding.subject, scope: 'personal' },
    }, signal);
    if (result.effect !== 'allow') deny(result.code);
  }

  private async current(signal?: AbortSignal): Promise<{validUntil: number; generation: number}> {
    if (this.#cutoff) deny('identity-nocobase/cutoff');
    const generation = this.#generation;
    const startedAt = Date.now();
    const state = await this.request(signal, requestSignal => this.#authority.current(this.binding, requestSignal));
    return { validUntil: this.acceptState(state, generation, startedAt), generation };
  }

  private acceptState(state: EnterpriseAuthorityState, generation: number, startedAt: number): number {
    if (this.#cutoff || generation !== this.#generation) deny('identity-nocobase/cutoff');
    const profile = state?.profile;
    const member = profile?.membership;
    if (!state || !state.binding || !sameBinding(state.binding, this.binding)
      || !profile || profile.principalId !== this.binding.subject || profile.principalKind !== 'human'
      || !profile.organization || profile.organization.id !== this.binding.organizationId || profile.organization.kind !== 'team'
      || !bounded(profile.organization.name) || !bounded(profile.organization.revision)
      || !member || member.organizationId !== this.binding.organizationId || member.principalId !== this.binding.subject
      || member.principalKind !== 'human' || member.state !== 'active'
      || !['owner', 'admin', 'member'].includes(member.role) || !bounded(member.revision)
      || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) {
      this.cutoff(); deny('identity-nocobase/authority-changed-or-revoked');
    }
    // Bound freshness from request start, never from arrival of an arbitrarily delayed allow.
    const validUntil = Math.min(state.expiresAt, startedAt + this.#freshnessMs);
    if (validUntil <= Date.now()) { this.cutoff(); deny('identity-nocobase/stale-authority'); }
    this.#profile = Object.freeze({
      principalId: this.binding.subject, principalKind: 'human', resolvedBy: this.id,
      organization: Object.freeze({ ...profile.organization }), membership: Object.freeze({ ...member }),
    });
    this.#profileValidUntil = validUntil;
    return validUntil;
  }

  private async request<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.#cutoff) deny('identity-nocobase/cutoff');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.#requests.add(controller);
    try {
      const result = await action(controller.signal);
      signal?.throwIfAborted();
      controller.signal.throwIfAborted();
      if (this.#cutoff) deny('identity-nocobase/cutoff');
      return result;
    } catch (error) {
      // Caller cancellation is local; unavailable authority invalidates this Host's permissions.
      if (!signal?.aborted) this.cutoff();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#requests.delete(controller);
    }
  }
}
