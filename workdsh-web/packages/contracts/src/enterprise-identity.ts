import type {
  ActorContext, AuthorizationDecision, AuthorizationRequest, IdentityProfile,
  IdentityService, RuntimeBindingRequest,
} from './governance.js';

/** Immutable trusted Host binding; never caller-selected model or Renderer context. */
export interface EnterpriseBinding {
  readonly issuer: string;
  readonly subject: string;
  readonly organizationId: string;
  readonly deviceId: string;
}

/** Fixed server wire DTO. Roles and identity are derived from current server records. */
export interface GatewayAuthoritySnapshot {
  readonly contractVersion: 'afos.identity.v1';
  readonly binding: EnterpriseBinding;
  readonly project: { readonly id: string; readonly organizationId: string; readonly name: string };
  readonly permissions: { readonly read: true; readonly archive: boolean };
  readonly authorizationRevision: string;
  readonly expiresAt: string;
}

/** Current verified NocoBase state, not a persisted local enterprise member database. */
export interface EnterpriseAuthorityState {
  readonly binding: EnterpriseBinding;
  readonly profile: IdentityProfile;
  /** Epoch milliseconds, bounded by the verified access grant expiry. */
  readonly expiresAt: number;
}

export interface EnterpriseAuthorityResult extends EnterpriseAuthorityState {
  readonly decision: AuthorizationDecision;
}

/** Trusted Broker adapter; this contract defines no login or network implementation. */
export interface NocoBaseIdentityAuthority {
  current(binding: EnterpriseBinding, signal: AbortSignal): Promise<EnterpriseAuthorityState>;
  authorize(binding: EnterpriseBinding, request: AuthorizationRequest, signal: AbortSignal): Promise<EnterpriseAuthorityResult>;
}

/** Optional enterprise seam of the existing WorkDSH identity and Access services. */
export interface EnterpriseIdentityService extends IdentityService {
  readonly enterprise: true;
  assertCurrentActor(actor: ActorContext): void;
  actorSignal(actor: ActorContext): AbortSignal;
  authorizeEnterprise(request: AuthorizationRequest, signal?: AbortSignal): Promise<AuthorizationDecision>;
  authorizeSessionBinding(actor: ActorContext, request: Pick<RuntimeBindingRequest, 'sessionId' | 'workspaceId'>, signal?: AbortSignal): Promise<void>;
}
