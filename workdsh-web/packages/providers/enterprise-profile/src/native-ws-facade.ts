import { Context, Service } from '@deepseek-ai/cordis';
import { TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type { SessionListRequest, SessionPageRequest, SessionProjectionsRequest, SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import { bindTypertRemote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from './native-reads.js';
import type {} from './native-ws-http-admission.js';
import { originalReadControllerExport } from './native-loader-rows.js';

const NAME = 'afosOwnedNativeMuxRead';
declare module '@deepseek-ai/cordis' {
  interface Context { afosOwnedNativeMuxRead: NativeWsFacade; }
}
const READS = new Set(['list', 'page', 'projections', 'follow', 'control']);
const unavailable = () => new RemoteError('afos/session-view-unavailable', 'Owned live Session view unavailable', {});
function contribution(ctx:Context,original:TypertContribution,namespace:string,service:string,reads:readonly string[],owner:object):void {
  const invocations=original.invocations.filter(item=>item.namespace===namespace);
  if(!invocations.length||reads.some(method=>!invocations.some(item=>item.method===method)))throw unavailable();
  for(const item of invocations)if(!reads.includes(item.method))Object.defineProperty(owner,item.method,{value:()=>{throw unavailable();}});
  ctx.typert.register({package:'workdsh-provider-enterprise-profile/native-read-catalog/'+namespace,face:'host',schemas:[],
    model:{services:[],events:[],objects:[]},invocations:invocations.map(item=>({...item,id:'workdsh-provider-enterprise-profile/native-read-catalog#'+namespace+'/'+item.method,service}))});
}
async function* catalogStream(ctx:Context,kind:'workspace'|'control',caller?:AbortSignal):AsyncIterable<unknown> {
  const invocation=ctx.invocation,catalog=ctx.afosNativeReadBridge.catalog;if(!invocation||!catalog)throw unavailable();
  const proof=ctx.afosNativeHttpProof.carrierProof(invocation.peer),signal=AbortSignal.any([caller??invocation.signal,proof.signal]);
  await proof.assertFresh();proof.assertCurrent();
  const source=kind==='workspace'?catalog.workspace(signal):catalog.control(signal);
  for await(const frame of source){await proof.assertFresh();proof.assertCurrent();signal.throwIfAborted();yield frame;}
}
class CatalogWorkspace extends Service {
  static inject=['typert','afosNativeReadBridge','afosNativeHttpProof'];
  readonly typertRemote;
  constructor(ctx:Context,original:TypertContribution){super(ctx,'afosOwnedWorkspaceRead');this.typertRemote=bindTypertRemote(this,'afosOwnedWorkspaceRead',{namespace:'workspace'});contribution(ctx,original,'workspace','afosOwnedWorkspaceRead',['follow'],this);}
  follow(signal?:AbortSignal){return catalogStream(this.ctx,'workspace',signal);}
}
class CatalogSettings extends Service {
  static inject=['typert','afosNativeReadBridge','afosNativeHttpProof'];
  readonly typertRemote;
  constructor(ctx:Context,original:TypertContribution){super(ctx,'afosOwnedSettingsRead');this.typertRemote=bindTypertRemote(this,'afosOwnedSettingsRead',{namespace:'settings'});contribution(ctx,original,'settings','afosOwnedSettingsRead',['describe'],this);}
  async describe(){const invocation=this.ctx.invocation,catalog=this.ctx.afosNativeReadBridge.catalog;if(!invocation||!catalog)throw unavailable();
    const proof=this.ctx.afosNativeHttpProof.carrierProof(invocation.peer);await proof.assertFresh();proof.assertCurrent();
    const value=await catalog.describe(AbortSignal.any([invocation.signal,proof.signal]));await proof.assertFresh();proof.assertCurrent();return value;}
}
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
  async [Service.init]():Promise<void>{
    if(!this.ctx.afosNativeReadBridge.catalog)throw unavailable();
    const workspace=await import(originalReadControllerExport('@deepseek-ai/dsh-api-workspace-controller','/typert'));
    const settings=await import(originalReadControllerExport('@deepseek-ai/dsh-api-settings-controller','/typert'));
    await this.ctx.plugin(CatalogWorkspace,workspace.TYPERT as TypertContribution).await();
    await this.ctx.plugin(CatalogSettings,settings.TYPERT as TypertContribution).await();
  }
  private async unary(endpoint: string, payload: unknown, signal?: AbortSignal) {
    const invocation = this.ctx.invocation; if (!invocation) throw unavailable();
    const proof = this.ctx.afosNativeHttpProof.carrierProof(invocation.peer);
    await proof.assertFresh();
    const result = await this.ctx.afosNativeReadBridge.invoke(endpoint, payload, AbortSignal.any([signal ?? invocation.signal, proof.signal]));
    await proof.assertFresh(); proof.assertCurrent();
    if (!result.ok) throw unavailable(); return result.value;
  }
  list(request: SessionListRequest, signal?: AbortSignal) { return this.unary('session/list', { args: { _request: request } }, signal); }
  page(request: SessionPageRequest, signal?: AbortSignal) { return this.unary('session/page', { args: { request } }, signal); }
  projections(request: SessionProjectionsRequest, signal?: AbortSignal) { return this.unary('session/projections', { args: { request } }, signal); }
  private async *ownedStream(endpoint: string, payload: unknown, callerSignal?: AbortSignal): AsyncIterable<unknown> {
    const invocation = this.ctx.invocation; if (!invocation) throw unavailable();
    const proof = this.ctx.afosNativeHttpProof.carrierProof(invocation.peer);
    const signal = AbortSignal.any([callerSignal ?? invocation.signal, proof.signal]);
    // Caller/frame proof must fail before an owned read asks Main enterprise authority.
    await proof.assertFresh(); proof.assertCurrent();
    const permit = await this.ctx.afosNativeReadBridge.admitReadCarrier(signal);
    try {
      await proof.assertFresh(); proof.assertCurrent(); permit.assertCurrent();
      const source = await this.ctx.afosNativeReadBridge.open(endpoint, payload, signal, (async function* () {})());
      for await (const value of source) { await proof.assertFresh(); proof.assertCurrent(); permit.assertCurrent(); yield value; }
    } finally { permit.close(); }
  }
  async *follow(request: SessionFollowRequest, caller?: AbortSignal): AsyncIterable<unknown> {
    const invocation = this.ctx.invocation, catalog = this.ctx.afosNativeReadBridge.catalog;
    if (!invocation || !catalog) throw unavailable();
    const peer = invocation.peer, proof = this.ctx.afosNativeHttpProof.carrierProof(peer);
    const signal = AbortSignal.any([invocation.signal, ...(caller ? [caller] : []), proof.signal]);
    await proof.assertFresh(); proof.assertCurrent(); signal.throwIfAborted();
    const cold = catalog.isColdSession(request);
    const source = cold ? catalog.coldFollow(request, signal, proof.expiresAt)
      : catalog.liveFollow(request, signal, proof.expiresAt);
    for await (const frame of source) {
      await proof.assertFresh(); proof.assertCurrent(); signal.throwIfAborted(); yield frame;
    }
  }
  control(signal?: AbortSignal): AsyncIterable<unknown> {
    return catalogStream(this.ctx,'control',signal);
  }
}
