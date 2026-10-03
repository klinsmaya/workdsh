import { Context, FiberState } from '@deepseek-ai/cordis';
import NocoBaseIdentityService from 'workdsh-provider-identity-nocobase';
import { EnterpriseProfileError } from './snapshot-authority.js';
import type {} from './cli-bootstrap.js';

export const name = 'afos-managed-cli-identity-ready';
export const inject = ['afosCliBootstrap', 'afosMainBusiness', 'afosIdentityAuthority'];
/** Separate dependency phase: bootstrap is ACTIVE before Identity starts. */
export async function apply(ctx: Context): Promise<void> {
  const bootstrap = ctx.afosCliBootstrap;
  bootstrap.signal.throwIfAborted();
  const fiber = await ctx.plugin(NocoBaseIdentityService, { binding: bootstrap.binding, freshnessMs: 1000 });
  bootstrap.signal.throwIfAborted();
  if (fiber.state !== FiberState.ACTIVE || !ctx.get('workdshIdentity')?.enterprise) {
    throw new EnterpriseProfileError('afos/cli-identity-not-ready');
  }
  ctx.provide('afosCliProfileReady', bootstrap);
}
