import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type {
  SessionControlFrame, SessionFollowFrame, SessionFollowRequest, SessionListRequest,
  SessionListValue, SessionPage, SessionPageRequest, SessionProjectionsRequest, SessionProjectionsValue,
} from '@deepseek-ai/dsh-api-session-controller/types';
import { TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert';
import { bindTypertRemote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'afos/session-view-unavailable': Record<string, never>;
    'afos/session-view-read-only': Record<string, never>;
  }
}

/**
 * Main derives this from a fresh actor/project check and its owned Draft-to-Session
 * mapping, not an old Run's execution lease. No field comes from a wire caller.
 */
export interface OwnedNativeReadAuthority {
  readonly sessionId: SessionId;
  readonly agent: Agent;
  readonly session: Session;
  readonly epoch: object;
  readonly signal: AbortSignal;
}
export interface OwnedNativeReadOptions {
  /** The original privately composed Controller, never a second controller implementation. */
  readonly controller: Pick<SessionController, 'list' | 'page' | 'follow' | 'projections' | 'control'>;
  /** Synchronous current Main authorization; throw or return undefined when unavailable. */
  readonly currentAuthority: () => OwnedNativeReadAuthority | undefined;
  /** Main proves every carrier and event-feed admission, including direct shared Fetch. */
  readonly assertIngressClosed: () => void;
}
export interface OwnedNativeReadInstallation {
  readonly serviceName: 'afosOwnedNativeRead';
  dispose(): Promise<void>;
}

const SERVICE_NAME = 'afosOwnedNativeRead';
const READS = new Set(['list', 'page', 'follow', 'projections', 'control']);
// Published rc.2 Client HISTORY_PAGE_OPTIONS and jump requests use 500.
const MAX_MESSAGES = 500;
const unavailable = () => new RemoteError('afos/session-view-unavailable', 'Owned live Session view unavailable', {});
const invalid = () => new RemoteError('gateway/bad-request', 'Invalid owned Session read request', {});
const readonly = () => new RemoteError('afos/session-view-read-only', 'Use the enterprise draft actions to change this run', {});

function record(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) throw invalid();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(desc => !('value' in desc))) throw invalid();
}
function boundedInteger(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
}
function address(request: SessionFollowRequest | SessionPageRequest, authority: OwnedNativeReadAuthority): void {
  record(request.address, ['kind', 'sessionId']);
  if (request.address.kind !== 'session' || request.address.sessionId !== authority.sessionId) throw unavailable();
  if (request.maxMessages !== undefined) boundedInteger(request.maxMessages, 1, MAX_MESSAGES);
  if (request.turnWindow !== undefined) {
    record(request.turnWindow, ['minMessages', 'minTurns']);
    boundedInteger(request.turnWindow.minMessages, 0, request.maxMessages ?? MAX_MESSAGES);
    boundedInteger(request.turnWindow.minTurns, 0, 100);
  }
}
function combined(signal: AbortSignal | undefined, authority: OwnedNativeReadAuthority, lifetime: AbortSignal): AbortSignal {
  return AbortSignal.any(signal ? [signal, authority.signal, lifetime] : [authority.signal, lifetime]);
}

/**
 * Opt-in business wrapper over the published native protocol. This does not boot
 * a profile, construct a Session/Agent, add a renderer, or add a transport.
 * Main must keep activation refused until the original private Controller and
 * complete carrier admission are proven. A missing proof rejects every call.
 */
export async function installOwnedNativeSessionReads(ctx: Context, options: OwnedNativeReadOptions): Promise<OwnedNativeReadInstallation> {
  if (!options || typeof options.currentAuthority !== 'function' || typeof options.assertIngressClosed !== 'function') throw unavailable();
  if (ctx.get(SERVICE_NAME) !== undefined) throw new Error('Owned native Session read facade already installed');
  const official = TYPERT as TypertContribution;
  if (!Array.isArray(official?.invocations)) throw new Error('Official Session Host contribution unavailable');
  const invocations = official.invocations.filter(item => item.namespace === 'session');
  if (invocations.length !== 19 || [...READS].some(method => !invocations.some(item => item.method === method))) {
    throw new Error('Unsupported official Session Host protocol version');
  }
  const lifetime = new AbortController();

  class OwnedNativeRead extends Service {
    static inject = ['agents', 'sessions', 'typert'];
    readonly typertRemote;
    constructor(owner: Context) {
      super(owner, SERVICE_NAME);
      this.typertRemote = bindTypertRemote(this, SERVICE_NAME, { namespace: 'session' });
      // Strict official wire codecs, result codecs and native stream cancellation
      // are reused. Every remaining native endpoint is a refusing business method.
      for (const invocation of invocations) if (!READS.has(invocation.method)) {
        Object.defineProperty(this, invocation.method, { configurable: true, value: () => { throw readonly(); } });
      }
      owner.typert.register({ package: 'workdsh-enterprise-session-view', face: 'host', schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: invocations.map(item => ({ ...item,
          id: 'workdsh-enterprise-session-view#session/' + item.method, service: SERVICE_NAME })) });
      owner.effect(() => () => { lifetime.abort(); }, 'owned native Session read lifetime');
    }
    capture(expected?: OwnedNativeReadAuthority): OwnedNativeReadAuthority {
      if (lifetime.signal.aborted) throw unavailable();
      options.assertIngressClosed();
      const supplied = options.currentAuthority();
      if (!supplied) throw unavailable();
      // Main may reuse a mutable backing authority record. Keep the captured
      // fields detached so changing that record cannot mutate our expected epoch.
      const current: OwnedNativeReadAuthority = Object.freeze({ sessionId: supplied.sessionId,
        agent: supplied.agent, session: supplied.session, epoch: supplied.epoch, signal: supplied.signal });
      if (current.signal.aborted || current.sessionId !== current.session.id
        || current.agent.session !== current.session || this.ctx.agents.get(current.sessionId) !== current.agent
        || this.ctx.sessions.get(current.sessionId) !== current.session || current.session.header.origin === 'subagent'
        || (expected && (current.epoch !== expected.epoch || current.agent !== expected.agent
          || current.session !== expected.session || current.signal !== expected.signal))) throw unavailable();
      return current;
    }
    async list(request: SessionListRequest, signal?: AbortSignal): Promise<SessionListValue> {
      record(request, []);
      const authority = this.capture(); const actualSignal = combined(signal, authority, lifetime.signal);
      actualSignal.throwIfAborted();
      const result = await options.controller.list({}, actualSignal);
      this.capture(authority); actualSignal.throwIfAborted();
      return { items: result.items.filter(item => item.sessionId === authority.sessionId) };
    }
    async projections(request: SessionProjectionsRequest, signal?: AbortSignal): Promise<SessionProjectionsValue> {
      record(request, ['sessionId']); const authority = this.capture();
      if (request.sessionId !== authority.sessionId) throw unavailable();
      const actualSignal = combined(signal, authority, lifetime.signal); actualSignal.throwIfAborted();
      const result = await options.controller.projections(request, actualSignal);
      this.capture(authority); actualSignal.throwIfAborted(); return result;
    }
    async page(request: SessionPageRequest, signal?: AbortSignal): Promise<SessionPage> {
      record(request, ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow']);
      const authority = this.capture(); address(request, authority);
      boundedInteger(request.throughSeq, -1, Number.MAX_SAFE_INTEGER);
      if (request.beforeSeq !== undefined) boundedInteger(request.beforeSeq, 0, Number.MAX_SAFE_INTEGER);
      const actualSignal = combined(signal, authority, lifetime.signal); actualSignal.throwIfAborted();
      const result = await options.controller.page(request, actualSignal);
      this.capture(authority); actualSignal.throwIfAborted(); return result;
    }
    async *follow(request: SessionFollowRequest, signal?: AbortSignal): AsyncIterable<SessionFollowFrame> {
      record(request, ['address', 'assistantStream', 'maxMessages', 'turnWindow']);
      const authority = this.capture(); address(request, authority);
      if (request.assistantStream !== undefined && request.assistantStream !== true) throw invalid();
      const actualSignal = combined(signal, authority, lifetime.signal); actualSignal.throwIfAborted();
      for await (const frame of options.controller.follow(request, actualSignal)) {
        this.capture(authority); actualSignal.throwIfAborted(); yield frame;
      }
    }
    async *control(signal?: AbortSignal): AsyncIterable<SessionControlFrame> {
      const authority = this.capture(); const actualSignal = combined(signal, authority, lifetime.signal); actualSignal.throwIfAborted();
      for await (const frame of options.controller.control(actualSignal)) {
        this.capture(authority); actualSignal.throwIfAborted();
        if (frame.type === 'baseline') {
          const baseline = frame.value.projections[authority.sessionId];
          yield { type: 'baseline', value: { projections: baseline ? { [authority.sessionId]: baseline } : {} } };
        } else if (frame.sessionId === authority.sessionId) yield frame;
      }
    }
  }
  const fiber = ctx.plugin(OwnedNativeRead);
  try {
    await fiber;
    // Fiber fulfillment alone does not prove service activation.
    if (ctx.get(SERVICE_NAME) === undefined) throw new Error('Owned native Session read dependencies unavailable');
    return { serviceName: SERVICE_NAME, dispose: async () => { lifetime.abort(); await fiber.dispose(); } };
  } catch (error) { lifetime.abort(); await fiber.dispose(); throw error; }
}

export interface OwnedNativeFetchCarrierOptions {
  /** Main's fixed application base, never selected by a request or Renderer. */
  readonly baseUrl: string;
  /** Main/app carrier lifetime, revoked on account/project/host changes. */
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}
export interface OwnedNativeFetchHandler extends ConnectionFetchHandler {
  /** Main uses this before bridging/reading an HTTP request body. */
  admit(request: { readonly method: string; readonly url: URL }): boolean;
}
const NATIVE_READ_PATHS = new Set([
  '/api/session/list', '/api/session/page', '/api/session/follow',
  '/api/session/projections', '/api/session/control',
]);
function forbidden(): Response {
  return new Response('forbidden', { status: 403, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/**
 * Admission wrapper at the existing Main carrier's dispatch seam. Main wraps
 * the original Connection.createSharedFetchHandler('/api') exactly once before
 * passing it to its HTTP/app-scheme driver. It adds no transport or RPC protocol.
 * The registered original /api/file and upload handlers remain installed but
 * cannot be selected through this wrapper. WS/direct Gateway still require the
 * in-method owned Session facade; this Fetch wrapper does not certify them.
 */
export function guardOwnedNativeSharedFetch(handler: ConnectionFetchHandler, options: OwnedNativeFetchCarrierOptions): OwnedNativeFetchHandler {
  const base = new URL(options.baseUrl);
  const lifetime = options.signal;
  const assertCurrent = options.assertCurrent;
  if (!['http:', 'https:', 'dsh-app:'].includes(base.protocol) || !base.host || base.pathname !== '/'
    || base.search || base.hash || base.username || base.password || typeof assertCurrent !== 'function') {
    throw new Error('Invalid Main-owned native Fetch base');
  }
  const admit = (request: { readonly method: string; readonly url: URL }): boolean => {
    try {
      if (lifetime.aborted || request.method !== 'POST' || request.url.protocol !== base.protocol
        || request.url.host !== base.host || request.url.username || request.url.password || request.url.search || request.url.hash
        || !NATIVE_READ_PATHS.has(request.url.pathname)) return false;
      assertCurrent(); return !lifetime.aborted;
    } catch { return false; }
  };
  return {
    admit,
    requestBodyMode(request) {
      if (!admit(request) || handler.requestBodyMode(request) !== 'buffered') throw unavailable();
      return 'buffered';
    },
    async fetch(request) {
      // Clone first: a Request subclass can override public getters without
      // changing the internal request that the Fetch constructor will forward.
      // Admission and delegation must observe the same canonical request.
      const canonical = new Request(request);
      const facts = { method: canonical.method, url: new URL(canonical.url) };
      if (canonical.signal.aborted || !admit(facts) || handler.requestBodyMode(facts) !== 'buffered') return forbidden();
      const signal = AbortSignal.any([canonical.signal, lifetime]);
      const result = await handler.fetch(new Request(canonical, { signal }));
      if (canonical.signal.aborted || !admit(facts)) {
        try { await result.body?.cancel(); } catch { /* Body discarded after authority changed. */ }
        return forbidden();
      }
      return result;
    },
  };
}
