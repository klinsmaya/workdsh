import { Context } from '@deepseek-ai/cordis';
import type { EnterpriseIdentityService, AccessService, RuntimeBindingService } from 'workdsh-contracts';
import type { MainBusinessCapabilities } from './main-capabilities.js';
import type { EnterpriseDraftRuntime } from './runtime.js';
declare module '@deepseek-ai/cordis' {
  interface Context { afosMainBusiness: MainBusinessCapabilities; afosDraftRuntime: EnterpriseDraftRuntime }
}
export const name = 'afos-profile-authority';
export const inject = ['workdshIdentity', 'workdshAccess'];
export function apply(ctx: Context): void {
  ctx.provide('afosProfileAuthority', Object.freeze({
    identity: ctx.get('workdshIdentity') as EnterpriseIdentityService,
    access: ctx.get('workdshAccess') as AccessService & RuntimeBindingService,
  }));
}
