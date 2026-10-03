import { Context, Service } from '@deepseek-ai/cordis';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CALLER_HTTP_PATHS } from './native-caller-ipc.js';
import { bindCallerGrant, requestCallerProof } from './native-ws-admission.js';
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection';
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import { EnterpriseProfileError } from './snapshot-authority.js';

type CallerLease = ReturnType<typeof bindCallerGrant>;
interface CarrierScope { readonly base: PeerScope; readonly peer: PeerScope; readonly proof: CallerLease; close(): Promise<void>; }
declare module '@deepseek-ai/cordis' {
  interface Context { afosNativeHttpProof: NativeHttpCallerProof; }
}
/** Root-owned physical HTTP admission; no RPC handler or transport contribution. */
export default class NativeHttpCallerProof extends Service {
  static inject = ['connection', 'afosNativeCallerProof'];
  readonly #scope = new AsyncLocalStorage<CallerLease>();
  readonly #lifetime = new AbortController();
  readonly #requests = new WeakMap<ConnectionTrustRequest, CarrierScope>();
  readonly #peers = new WeakMap<PeerScope, CarrierScope>();
  readonly #carriers = new Set<CarrierScope>();
  current = (): CallerLease | undefined => { const lease = this.#scope.getStore(); lease?.assertCurrent(); return lease; };
  carrierPeer = (request: ConnectionTrustRequest, base: PeerScope): PeerScope | undefined => {
    const scope = this.#requests.get(request);
    if (!scope || scope.base !== base || this.#lifetime.signal.aborted) return undefined;
    scope.peer.ctx.fiber.assertActive();
    scope.proof.assertCurrent(); return scope.peer;
  };
  carrierProof = (peer: PeerScope): CallerLease => {
    const scope = this.#peers.get(peer);
    if (!scope || this.#lifetime.signal.aborted) throw new EnterpriseProfileError('afos/native-read-denied');
    scope.peer.ctx.fiber.assertActive();
    scope.proof.assertCurrent(); return scope.proof;
  };
  /** A stricter scope of the authenticated operator, never another identity. */
  prepareCarrier = async (request: ConnectionTrustRequest, base: PeerScope, admission: CallerLease,
    cancel: () => void): Promise<{ readonly peer: PeerScope; close(): Promise<void> }> => {
    if (this.#requests.has(request) || this.#lifetime.signal.aborted) throw new EnterpriseProfileError('afos/native-read-denied');
    admission.assertCurrent();
    const proof = bindCallerGrant({ signal: AbortSignal.any([admission.signal, this.#lifetime.signal]), expiresAt: admission.expiresAt,
      assertFresh: signal => admission.assertFresh(signal),
    }, admission.signal);
    let child: Context | undefined;
    const fiber = base.ctx.plugin({ name: 'afos-restrictive-caller-scope', apply(ctx: Context) { child = ctx.extend(); } });
    try { await fiber.await(); proof.assertCurrent(); if (!child) throw new EnterpriseProfileError('afos/native-read-denied'); }
    catch (error) { proof.close(); await fiber.dispose(); throw error; }
    let closed: Promise<void> | undefined;
    const cleanup = () => {
      this.#requests.delete(request); this.#peers.delete(peer); this.#carriers.delete(scope); proof.close(); cancel();
    };
    const close = (): Promise<void> => {
      if (closed) return closed;
      // The original Cordis effect disposer may already have been claimed by
      // its parent and return undefined. Public await still waits its inertia.
      closed = Promise.resolve().then(async () => { await fiber.dispose(); await fiber.await(); });
      cleanup(); return closed;
    };
    const peer: PeerScope = Object.freeze({ id: base.id, ctx: child, dispose: close });
    const scope: CarrierScope = Object.freeze({ base, peer, proof, close });
    this.#requests.set(request, scope); this.#peers.set(peer, scope); this.#carriers.add(scope);
    fiber.effect(() => cleanup, 'afos-caller-scope metadata lifetime');
    return Object.freeze({ peer, close });
  };
  constructor(ctx: Context) {
    super(ctx, 'afosNativeHttpProof');
    ctx.effect(() => async () => { this.#lifetime.abort(); this.#scope.disable(); await Promise.all([...this.#carriers].map(scope => scope.close())); }, 'afos-native-http-caller-proof lifetime');
    ctx.on('connection/request', async (request, response, next) => {
      let pathname: string;
      try { pathname = new URL(request.url ?? '', 'http://127.0.0.1').pathname; }
      catch { response.writeHead(403); response.end(); return; }
      if (!CALLER_HTTP_PATHS.includes(pathname)) { response.writeHead(403); response.end(); return; }
      if(request.method!=='POST'||request.url!==pathname){response.writeHead(403);response.end();return;}
      const admission = ctx.connection.admit(request);
      if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return; }
      const closed = new AbortController();
      const cutoff = () => closed.abort(), cancel = () => response.destroy();
      request.once('aborted', cutoff); response.once('close', cutoff);
      const signal = AbortSignal.any([closed.signal, this.#lifetime.signal]);
      let proof: CallerLease | undefined;
      try {
        proof = bindCallerGrant(await requestCallerProof(ctx.afosNativeCallerProof, request, signal), signal);
        proof.assertCurrent(); await proof.assertFresh(); proof.signal.addEventListener('abort', cancel, { once: true }); proof.assertCurrent();
        await this.#scope.run(proof, next); await proof.assertFresh(); proof.assertCurrent();
      } catch {
        if (!response.headersSent && !response.destroyed) { response.writeHead(403); response.end(); }
        else response.destroy();
      } finally {
        proof?.signal.removeEventListener('abort', cancel); proof?.close();
        request.removeListener('aborted', cutoff); response.removeListener('close', cutoff);
      }
    });
  }
}
