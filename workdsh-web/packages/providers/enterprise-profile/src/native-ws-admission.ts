import { Context, Service } from '@deepseek-ai/cordis';
import type { WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver';
import type { Duplex } from 'node:stream';
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection';
import type {} from './native-reads.js';
import type {} from './native-ws-connection.js';
import type {} from './native-ws-http-admission.js';
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { EnterpriseProfileError } from './snapshot-authority.js';

declare module '@deepseek-ai/cordis' {
  interface Context { afosNativeParentWebServer: WebServer; afosNativeCallerProof: NativeCallerProof; }
}

export interface NativeCallerGrant { readonly signal: AbortSignal; readonly expiresAt: number; assertFresh?(signal:AbortSignal):Promise<void>; close?():void; }
export interface NativeCallerProof {
  /** Private Main-issued caller identity lifetime; never a renderer-supplied DTO. */
  assertRequest(request: ConnectionTrustRequest, signal: AbortSignal): Promise<NativeCallerGrant>;
}
export const NATIVE_CALLER_PROOF_TIMEOUT_MS = 10_000;
export async function requestCallerProof(proof: NativeCallerProof, request: ConnectionTrustRequest, signal: AbortSignal): Promise<NativeCallerGrant> {
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), NATIVE_CALLER_PROOF_TIMEOUT_MS); timer.unref();
  let cutoff: (() => void) | undefined;
  try {
    combined.throwIfAborted();
    return await new Promise<NativeCallerGrant>((resolve, reject) => {
      cutoff = () => reject(combined.reason);
      combined.addEventListener('abort', cutoff, { once: true });
      Promise.resolve().then(() => proof.assertRequest(request, combined)).then(resolve, reject);
      if (combined.aborted) cutoff();
    });
  } finally { clearTimeout(timer); if (cutoff) combined.removeEventListener('abort', cutoff); }
}
export function bindCallerGrant(grant: NativeCallerGrant, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!grant || !(grant.signal instanceof AbortSignal) || grant.signal.aborted || !Number.isFinite(grant.expiresAt)
    || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 60_000) throw new EnterpriseProfileError('afos/native-read-denied');
  const expiry = new AbortController();
  const combined = AbortSignal.any([signal, grant.signal, expiry.signal]);
  const timer = setTimeout(() => expiry.abort(), Math.max(1, grant.expiresAt - Date.now())); timer.unref();
  return { signal: combined, expiresAt: grant.expiresAt, assertCurrent() { combined.throwIfAborted(); if (Date.now() >= grant.expiresAt) throw new EnterpriseProfileError('afos/native-read-denied'); },
    async assertFresh(caller:AbortSignal = combined) { combined.throwIfAborted(); if(Date.now()>=grant.expiresAt)throw new EnterpriseProfileError('afos/native-read-denied'); await grant.assertFresh?.(caller); combined.throwIfAborted(); if(Date.now()>=grant.expiresAt)throw new EnterpriseProfileError('afos/native-read-denied'); },
    close() { clearTimeout(timer); expiry.abort(); grant.close?.(); } };
}

/** Policy capability over one original parent WebServer; creates no server or transport. */
export default class NativeWsAdmission extends Service {
  static inject = ['afosNativeParentWebServer', 'afosNativeParentConnection', 'connection', 'afosNativeReadBridge', 'afosNativeCallerProof', 'afosNativeHttpProof'];
  readonly #lifetime = new AbortController();
  readonly #sockets = new Set<Duplex>();
  constructor(ctx: Context) {
    super(ctx, 'webServer');
    ctx.effect(() => () => {
      this.#lifetime.abort(); for (const socket of this.#sockets) socket.destroy(); this.#sockets.clear();
    }, 'afos-owned-native-mux admission lifetime');
  }
  get host() { return this.ctx.afosNativeParentWebServer.host; }
  get port() { return this.ctx.afosNativeParentWebServer.port; }
  registerUpgrade = (route: WebUpgradeRoute): (() => void) => {
    if (route.path !== REMOTE_STREAM_MUX_PATH) throw new EnterpriseProfileError('afos/native-read-denied');
    const owner = this;
    const release = this.ctx.afosNativeParentWebServer.registerUpgrade({ path: route.path,
      async handler(request, socket, head) {
        // The original browser identity is a separate proof from the current Main account.
        // Let the original Gateway send its exact auth failure, without asking Main.
        const originalAdmission = owner.ctx.afosNativeParentConnection.admit(request);
        if ('rejection' in originalAdmission) { await route.handler(request, socket, head); return; }
        const closed = new AbortController();
        let permit: Awaited<ReturnType<Context['afosNativeReadBridge']['admitReadCarrier']>> | undefined;
        let proof: ReturnType<typeof bindCallerGrant> | undefined;
        let scope: Awaited<ReturnType<Context['afosNativeHttpProof']['prepareCarrier']>> | undefined;
        const cancel = () => socket.destroy();
        const cleanup = () => {
          closed.abort(); proof?.signal.removeEventListener('abort', cancel); proof?.close(); permit?.signal.removeEventListener('abort', cancel); permit?.close();
          void scope?.close().catch(() => undefined);
          owner.#sockets.delete(socket); socket.removeListener('close', cleanup); socket.removeListener('end', cleanup); socket.removeListener('readable', probeClosed);
        };
        // An upgrade socket is paused until the original mux starts. A zero-byte
        // read lets Node report a pending FIN without consuming carrier bytes.
        const probeClosed = () => { if (socket.readableLength === 0) socket.read(0); };
        socket.once('close', cleanup); socket.once('end', cleanup); socket.on('readable', probeClosed); owner.#sockets.add(socket);
        try {
          const callerSignal = AbortSignal.any([closed.signal, owner.#lifetime.signal]);
          callerSignal.throwIfAborted();
          proof = bindCallerGrant(await requestCallerProof(owner.ctx.afosNativeCallerProof, request, callerSignal), callerSignal);
          proof.assertCurrent(); await proof.assertFresh(); proof.signal.addEventListener('abort', cancel, { once: true });
          proof.assertCurrent();
          // Cold transport readiness has no Session content/authority. Each native
          // invocation still acquires its exact fresh owned Session lease.
          if(owner.ctx.get('afosDraftRuntime')?.nativeSessionId()!==undefined)
            permit = await owner.ctx.afosNativeReadBridge.admitReadCarrier(proof.signal);
          proof.assertCurrent(); permit?.assertCurrent();
          if (socket.destroyed || owner.#lifetime.signal.aborted) throw new EnterpriseProfileError('afos/native-read-denied');
          permit?.signal.addEventListener('abort', cancel, { once: true });
          if (permit?.signal.aborted) throw new EnterpriseProfileError('afos/native-read-denied');
          scope = await owner.ctx.afosNativeHttpProof.prepareCarrier(request, originalAdmission.peer, proof, cancel);
          proof.assertCurrent(); permit?.assertCurrent();
          socket.removeListener('readable', probeClosed);
          // The unchanged original handler alone owns WebSocket negotiation/mux/pumping.
          await route.handler(request, socket, head);
          await proof.assertFresh(); proof.assertCurrent(); permit?.assertCurrent();
        } catch {
          cleanup(); socket.destroy();
        }
      },
    });
    return () => { release(); for (const socket of this.#sockets) socket.destroy(); };
  };
}
