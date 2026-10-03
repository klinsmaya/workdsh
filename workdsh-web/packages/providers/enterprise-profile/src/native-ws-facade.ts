import { Context, Service } from '@deepseek-ai/cordis';
import { TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type { SessionListRequest, SessionPageRequest, SessionProjectionsRequest, SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import { bindTypertRemote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from './native-reads.js';
import type {} from './native-ws-http-admission.js';

const NAME = 'afosOwnedNativeMuxRead';
const READS = new Set(['list', 'page', 'projections', 'follow', 'control']);
const unavailable = () => new RemoteError('afos/session-view-unavailable', 'Owned live Session view unavailable', {});
/** Only this fresh Main business facade is visible to the original public mux Gateway. */
export default class NativeWsFacade extends Service {
  static inject = ['afosNativeReadBridge', 'afosNativeHttpProof', 'typert', 'typertGateway'];
  readonly typertRemote;
  constructor(ctx: Context) {
    super(ctx, NAME); this.typertRemote = bindTypertRemote(this, NAME, { namespace: 'session' });
    const contribution = TYPERT as TypertContribution;
    const invocations = contribution.invocations.filter(item => item.namespace === 'session');
    if (invocations.length !== 19) throw unavailable();
    for (const invocation of invocations) if (!READS.has(invocation.method)) {
      Object.defineProperty(this, invocation.method, { value: () => { throw unavailable(); } });
    }
    ctx.typert.register({ package: 'workdsh-provider-enterprise-profile/native-ws', face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: invocations.map(item => ({ ...item,
        id: 'workdsh-provider-enterprise-profile/native-ws#session/' + item.method, service: NAME })) });
    // No Host notifications or waterfalls are attached. Original Gateway owns readiness.
    ctx.effect(() => ctx.typertGateway.registerRemoteEvents(signal => (async function* () {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    })(), { home: '' }), 'afos-empty-owned-native readiness');
  }
  private async unary(endpoint: string, payload: unknown, signal?: AbortSignal) {
    const invocation = this.ctx.invocation; if (!invocation) throw unavailable();
    const proof = this.ctx.afosNativeHttpProof.carrierProof(invocation.peer);
    const result = await this.ctx.afosNativeReadBridge.invoke(endpoint, payload, AbortSignal.any([signal ?? invocation.signal, proof.signal]));
    proof.assertCurrent();
    if (!result.ok) throw unavailable(); return result.value;
  }
  list(request: SessionListRequest, signal?: AbortSignal) { return this.unary('session/list', { args: { _request: request } }, signal); }
  page(request: SessionPageRequest, signal?: AbortSignal) { return this.unary('session/page', { args: { request } }, signal); }
  projections(request: SessionProjectionsRequest, signal?: AbortSignal) { return this.unary('session/projections', { args: { request } }, signal); }
  private async *ownedStream(endpoint: string, payload: unknown, callerSignal?: AbortSignal): AsyncIterable<unknown> {
    const invocation = this.ctx.invocation; if (!invocation) throw unavailable();
    const proof = this.ctx.afosNativeHttpProof.carrierProof(invocation.peer);
    const signal = AbortSignal.any([callerSignal ?? invocation.signal, proof.signal]);
    const permit = await this.ctx.afosNativeReadBridge.admitReadCarrier(signal);
    try {
      proof.assertCurrent(); permit.assertCurrent();
      const source = await this.ctx.afosNativeReadBridge.open(endpoint, payload, signal, (async function* () {})());
      for await (const value of source) { proof.assertCurrent(); permit.assertCurrent(); yield value; }
    } finally { permit.close(); }
  }
  follow(request: SessionFollowRequest, signal?: AbortSignal): AsyncIterable<unknown> {
    return this.ownedStream('session/follow', { args: { request } }, signal);
  }
  control(signal?: AbortSignal): AsyncIterable<unknown> {
    return this.ownedStream('session/control', { args: {} }, signal);
  }
}
