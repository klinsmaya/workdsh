import { Context, Service } from '@deepseek-ai/cordis';
import type {
  ActorContext, AuthorizationRequest, IdentityResolutionContext, RuntimeBindingRequest,
} from 'workdsh-contracts';
import { NocoBaseIdentityProvider, type EnterpriseBinding, type NocoBaseIdentityAuthority } from './authority.js';
export * from './authority.js';

export interface Config {
  readonly binding: EnterpriseBinding;
  readonly freshnessMs?: number;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    afosIdentityAuthority: NocoBaseIdentityAuthority;
  }
}

/** Explicit Loader/Host composition only; never added to the personal bundle. */
export class NocoBaseIdentityService extends Service {
  static inject = ['afosIdentityAuthority'];
  readonly id = 'workdsh-identity-nocobase';
  readonly enterprise = true as const;
  private readonly provider: NocoBaseIdentityProvider;

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workdshIdentity');
    this.provider = new NocoBaseIdentityProvider(config.binding, ctx.afosIdentityAuthority, config.freshnessMs);
    ctx.effect(() => () => this.provider.cutoff(), 'workdshIdentity.enterpriseCutoff');
  }

  async [Service.init](): Promise<void> { await this.provider.resolve(); }
  get namespace() { return this.provider.namespace; }
  get binding() { return this.provider.binding; }
  profile() { return this.provider.profile(); }
  membership(organizationId: string, principalId: string) { return this.provider.membership(organizationId, principalId); }
  resolve(evidence?: IdentityResolutionContext, signal?: AbortSignal) { return this.provider.resolve(evidence, signal); }
  assertCurrentActor(actor: ActorContext) { this.provider.assertCurrentActor(actor); }
  actorSignal(actor: ActorContext) { return this.provider.actorSignal(actor); }
  authorizeEnterprise(request: AuthorizationRequest, signal?: AbortSignal) { return this.provider.authorizeEnterprise(request, signal); }
  authorizeSessionBinding(actor: ActorContext, request: Pick<RuntimeBindingRequest, 'sessionId' | 'workspaceId'>, signal?: AbortSignal) { return this.provider.authorizeSessionBinding(actor, request, signal); }
  cutoff() { this.provider.cutoff(); }
}
export default NocoBaseIdentityService;
