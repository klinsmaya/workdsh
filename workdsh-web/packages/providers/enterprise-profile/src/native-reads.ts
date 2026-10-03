import { Context, Service } from '@deepseek-ai/cordis';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { ConnectionFetchHandler, ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection';
import { RpcId, serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import { installOwnedNativeSessionReads, type OwnedNativeReadAuthority, type OwnedNativeReadInstallation } from 'workdsh-enterprise-session-view';
import { EnterpriseProfileError } from './snapshot-authority.js';
import type {} from './runtime.js';
import type {} from './authority-service.js';
import type {} from '@deepseek-ai/dsh-api-gateway';

export const NATIVE_READ_ENDPOINTS = Object.freeze(['session/list', 'session/page', 'session/projections', 'session/follow', 'session/control'] as const);
const UNARY = new Set<string>(NATIVE_READ_ENDPOINTS.slice(0, 3));
const STREAM = new Set<string>(NATIVE_READ_ENDPOINTS.slice(3));
const denied = () => new EnterpriseProfileError('afos/native-read-denied');
function exactRecord(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor))) throw denied();
}
interface Lease {
  readonly authority: OwnedNativeReadAuthority;
  readonly expiresAt: number;
  close(): void;
}
export interface NativeReadBridgeOptions {
  readonly reader: Context;
  readonly controller: SessionController;
  readonly workspace: string;
}
declare module '@deepseek-ai/cordis' {
  interface Context { afosNativeReadBridge: EnterpriseNativeReadBridge; }
}

/** Private business admission for the existing original Connection/Gateway. */
export class EnterpriseNativeReadBridge extends Service {
  static inject = ['agents', 'sessions', 'afosMainBusiness'];
  readonly workspace: string;
  readonly #reader: Context;
  readonly #shared: ConnectionFetchHandler;
  readonly #scope = new AsyncLocalStorage<Lease>();
  readonly #lifetime = new AbortController();
  readonly #leases = new Set<Lease>();
  #installation: OwnedNativeReadInstallation | undefined;
  readonly #controller: SessionController;
  constructor(ctx: Context, options: NativeReadBridgeOptions) {
    super(ctx, 'afosNativeReadBridge');
    this.workspace = options.workspace; this.#reader = options.reader; this.#controller = options.controller;
    this.assertPrivateComposition();
    this.#shared = options.reader.connection.createSharedFetchHandler('/api');
    ctx.effect(() => async () => {
      this.#lifetime.abort(); for (const lease of this.#leases) lease.close();
      await this.#installation?.dispose(); this.#scope.disable();
    }, 'afosNativeReadBridge.lifetime');
  }
  async [Service.init](): Promise<void> {
    this.#installation = await installOwnedNativeSessionReads(this.#reader, {
      controller: this.#controller,
      currentAuthority: () => this.currentAuthority(),
      assertIngressClosed: () => this.assertPrivateComposition(),
    });
  }
  private assertPrivateComposition(): void {
    if (this.#lifetime.signal.aborted || this.ctx.get('typertGateway') !== undefined
      || this.#reader.get('webServer') !== undefined || this.#reader.get('sessionController') !== undefined
      || this.#reader.get('llm') !== undefined || this.#reader.get('agentPresets') !== undefined
      || !this.#reader.get('typertGateway') || !this.#reader.get('connection')
      || this.#reader.get('connection') === this.ctx.get('connection')) throw denied();
  }
  private selectedSession(): string {
    const sessionId = this.ctx.get('afosDraftRuntime')?.nativeSessionId();
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) throw denied();
    return sessionId;
  }
  private currentAuthority(): OwnedNativeReadAuthority | undefined {
    const lease = this.#scope.getStore();
    if (!lease || lease.authority.signal.aborted || Date.now() >= lease.expiresAt
      || this.selectedSession() !== lease.authority.sessionId) return undefined;
    return lease.authority;
  }
  private target(endpoint: string, payload: unknown): string {
    if (!NATIVE_READ_ENDPOINTS.includes(endpoint as typeof NATIVE_READ_ENDPOINTS[number])) throw denied();
    const sessionId = this.selectedSession(); exactRecord(payload, ['args']);
    if (!Object.hasOwn(payload, 'args')) throw denied();
    const names = endpoint === 'session/control' ? [] : [endpoint === 'session/list' ? '_request' : 'request'];
    exactRecord(payload.args, names);
    if (Reflect.ownKeys(payload.args).length !== names.length) throw denied();
    if (endpoint === 'session/list') exactRecord(payload.args._request, []);
    else if (endpoint !== 'session/control') {
      const request = payload.args.request;
      exactRecord(request, endpoint === 'session/projections' ? ['sessionId']
        : endpoint === 'session/follow' ? ['address', 'assistantStream', 'maxMessages', 'turnWindow']
        : ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow']);
      if (endpoint === 'session/projections') { if (request.sessionId !== sessionId) throw denied(); }
      else {
        exactRecord(request.address, ['kind', 'sessionId']);
        if (request.address.kind !== 'session' || request.address.sessionId !== sessionId) throw denied();
      }
    }
    return sessionId;
  }
  private async lease(endpoint: string, payload: unknown, callerSignal: AbortSignal): Promise<Lease> {
    this.assertPrivateComposition();
    const sessionId = this.target(endpoint, payload);
    const before = this.#reader.agents.get(SessionId(sessionId));
    const session = this.#reader.sessions.get(SessionId(sessionId));
    if (!before || before.session !== session) throw denied();
    const signal = AbortSignal.any([callerSignal, this.#lifetime.signal]); signal.throwIfAborted();
    const grant = await this.ctx.afosMainBusiness.ownedSessionRead(sessionId, signal);
    const expiresAt = Date.parse(grant.expiresAt);
    if (grant.sessionId !== sessionId || !grant.epoch || typeof grant.epoch !== 'object'
      || !(grant.signal instanceof AbortSignal) || grant.signal.aborted || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now() || expiresAt > Date.now() + 60_000 || this.selectedSession() !== sessionId
      || this.#reader.agents.get(SessionId(sessionId)) !== before || this.#reader.sessions.get(SessionId(sessionId)) !== session) throw denied();
    signal.throwIfAborted();
    const expiry = new AbortController();
    const combined = AbortSignal.any([signal, grant.signal, expiry.signal]);
    const timer = setTimeout(() => lease.close(), Math.max(1, expiresAt - Date.now())); timer.unref();
    const lease: Lease = Object.freeze({ authority: Object.freeze({ sessionId: SessionId(sessionId), agent: before,
      session: session!, epoch: grant.epoch, signal: combined }), expiresAt,
      close: () => { clearTimeout(timer); expiry.abort(); this.#leases.delete(lease); },
    });
    this.#leases.add(lease);
    try { combined.throwIfAborted(); return lease; }
    catch (error) { lease.close(); throw error; }
  }
  /** Unary response encoding remains the original Connection/Gateway's responsibility. */
  invoke = async (endpoint: string, payload: unknown, callerSignal: AbortSignal): Promise<ConnectionRpcHandlerResult> => {
    if (!UNARY.has(endpoint)) {
      if (STREAM.has(endpoint)) throw new EnterpriseProfileError('gateway/signature-invalid');
      throw denied();
    }
    const lease = await this.lease(endpoint, payload, callerSignal);
    try {
      const response = await this.#scope.run(lease, () => this.#shared.fetch(new Request('http://127.0.0.1/api/' + endpoint, {
        method: 'POST', signal: lease.authority.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: RpcId(randomUUID()), method: endpoint, payload }),
      })));
      lease.authority.signal.throwIfAborted();
      if (Date.now() >= lease.expiresAt || this.selectedSession() !== lease.authority.sessionId
        || response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) throw denied();
      const envelope = serverResponseSchema.parse(await response.json());
      lease.authority.signal.throwIfAborted();
      if (Date.now() >= lease.expiresAt || this.selectedSession() !== lease.authority.sessionId) throw denied();
      return envelope.result;
    } finally { lease.close(); }
  };
  /** Existing carrier consumes unchanged official wire values; no mux/framing is introduced here. */
  open = async (endpoint: string, payload: unknown, callerSignal: AbortSignal,
    uplink: AsyncIterable<unknown>, peer?: PeerScope): Promise<AsyncIterable<unknown>> => {
    if (!STREAM.has(endpoint)) throw denied();
    const lease = await this.lease(endpoint, payload, callerSignal);
    let source: AsyncIterable<unknown>;
    try {
      source = await this.#scope.run(lease, () => this.#reader.typertGateway.wireStream.open(endpoint, payload,
        uplink, peer, lease.authority.signal));
    } catch (error) { lease.close(); throw error; }
    let iterator: AsyncIterator<unknown>;
    try { iterator = this.#scope.run(lease, () => source[Symbol.asyncIterator]()); }
    catch (error) { lease.close(); throw error; }
    let closed = false;
    let cleanup: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      closed = true;
      // Closing first also interrupts an in-flight next() before return() is queued.
      lease.close();
      return cleanup ??= (async () => {
        if (iterator.return) await this.#scope.run(lease, () => iterator.return!());
      })();
    };
    const consumer: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]() { return consumer; },
      next: async () => {
        if (closed) return { done: true, value: undefined };
        try {
          const item = await this.#scope.run(lease, () => iterator.next());
          lease.authority.signal.throwIfAborted();
          if (Date.now() >= lease.expiresAt || this.selectedSession() !== lease.authority.sessionId) throw denied();
          if (item.done) await dispose();
          return item;
        } catch (error) { await dispose(); throw error; }
      },
      return: async (value?: unknown) => { await dispose(); return { done: true, value }; },
      throw: async (error?: unknown) => { await dispose(); throw error; },
    };
    return consumer;
  };
}
