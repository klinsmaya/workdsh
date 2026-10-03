import type { Context } from '@deepseek-ai/cordis';
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot';
import type { ModelPolicy } from '@afos/model-adapter';
import type { EnterpriseBinding } from 'workdsh-contracts';
import type { MainBusinessCapabilities } from './main-capabilities.js';
import type { NativeCallerProof } from './native-ws-admission.js';
import { connectMainBusinessIpc, type MainIpcEndpoint } from './main-ipc.js';
import type { MainCliReady } from './main-cli-ready.js';
import { EnterpriseProfileError, SnapshotIdentityAuthority } from './snapshot-authority.js';

export const name = 'afos-managed-cli-bootstrap';
export const inject = ['profileContext', 'appExit'];
export interface CliBootstrap {
  readonly root: string;
  readonly model: ModelPolicy;
  readonly binding: EnterpriseBinding;
  readonly projectId: string;
  readonly signal: AbortSignal;
  readonly business: MainBusinessCapabilities;
  readonly nativeCaller?: NativeCallerProof;
  readonly online?: { readonly frontendIndex: string; readonly publishReady: (ready: MainCliReady) => Promise<void> };
}
declare module '@deepseek-ai/cordis' {
  interface Context { afosCliBootstrap: CliBootstrap; afosCliProfileReady: CliBootstrap; }
}

/** An ordinary plugin in the original CLI tree, never a new application boot. */
export async function apply(ctx: Context): Promise<void> {
  const profile = ctx.get('profileContext') as ProfileContext | undefined;
  const exit = ctx.get('appExit');
  if (profile?.name !== 'afos-managed' || profile.startedBundles.length || profile.overlays.length
    || typeof process.send !== 'function' || !process.connected || typeof exit !== 'function') {
    throw new EnterpriseProfileError('afos/cli-bootstrap-refused');
  }
  const lifetime = new AbortController();
  const endpoint: MainIpcEndpoint = {
    send: message => new Promise<void>((resolve, reject) => {
      if (!process.connected || typeof process.send !== 'function') { reject(new EnterpriseProfileError('afos/cli-bootstrap-refused')); return; }
      process.send(message, undefined, undefined, (error: Error | null) => error ? reject(new EnterpriseProfileError('afos/cli-bootstrap-refused')) : resolve());
    }),
    messages: listener => { process.on('message', listener); return () => { process.off('message', listener); }; },
    disconnected: listener => { process.on('disconnect', listener); return () => { process.off('disconnect', listener); }; },
  };
  let channel: Awaited<ReturnType<typeof connectMainBusinessIpc>> | undefined;
  let identity: SnapshotIdentityAuthority | undefined;
  const cutoff = () => { identity?.cutoff(); exit(1); };
  ctx.effect(() => () => {
    channel?.signal.removeEventListener('abort', cutoff); lifetime.abort(); identity?.cutoff(); channel?.close();
  }, 'afos-managed-cli-ipc');
  try {
    channel = await connectMainBusinessIpc(endpoint, lifetime.signal);
    identity = new SnapshotIdentityAuthority(channel.authority.binding, channel.authority.project.id,
      (_projectId, signal) => channel!.business.currentAuthority(AbortSignal.any([signal, channel!.signal])));
    await identity.current(channel.authority.binding, channel.signal);
    channel.signal.throwIfAborted();
    channel.signal.addEventListener('abort', cutoff, { once: true });
    ctx.provide('afosMainBusiness', channel.business);
    ctx.provide('afosIdentityAuthority', identity);
    ctx.provide('afosCliBootstrap', Object.freeze({ root: channel.bootstrap.root, model: channel.bootstrap.model,
      binding: channel.authority.binding, projectId: channel.authority.project.id, signal: channel.signal, business: channel.business,...(channel.bootstrap.nativeCaller?{nativeCaller:channel.nativeCaller}:{}),
      ...(channel.bootstrap.online?{online:Object.freeze({frontendIndex:channel.bootstrap.online.frontendIndex,publishReady:channel.publishReady})}:{}) }));
    channel.signal.throwIfAborted();
    // Return ACTIVE before the next plugin awaits Identity. A LOADING provider's
    // own injected child can return PENDING; it is not an initialization barrier.
  } catch {
    identity?.cutoff(); channel?.close(); throw new EnterpriseProfileError('afos/cli-bootstrap-refused');
  }
}
