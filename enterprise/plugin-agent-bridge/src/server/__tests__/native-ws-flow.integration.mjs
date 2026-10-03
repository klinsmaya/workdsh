import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import { fixture } from './desktop-fixture.mjs';
import { bootEnterpriseNativeWsCore } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/assembly.js';
import { NATIVE_CALLER_PROOF_TIMEOUT_MS } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/native-ws-admission.js';

const policy = { provider: 'afos-managed', model: 'fixed-model', maxTokens: 64 };
const idleModel = [{ type: 'finish', reason: { kind: 'stop' } }];
async function composed(options = {}) {
  let ctx, readDeadline;
  const f = await fixture({ response: options.response, stopHost: async () => { if (ctx) { const old=ctx;ctx=undefined;await old.fiber.dispose(); } },
    model: async () => idleModel });
  await f.ready(); f.capability({ ingressValidated: true, sandbox: 'full' });
  f.startHook(async (signal, layout, authority, business) => {
    ctx = await bootEnterpriseNativeWsCore({ root: layout.profile, binding: authority.binding,
      projectId: authority.project.id, nativeCaller: {
        async assertRequest(request,signal) {
          signal.throwIfAborted();
          if(options.nativeCaller)await options.nativeCaller(request,signal);
          else {
            const cookie=request.headers instanceof Headers?request.headers.get('cookie'):request.headers.cookie;
            if(typeof cookie!=='string'||!cookie.split(';').map(part=>part.trim()).includes('afos_fixture_native=approved'))throw new Error('Fixture native caller proof missing');
          }
          if(options.callerGrant)return options.callerGrant(request,signal);
          return {signal:options.proofSignal??signal,expiresAt:Date.now()+(options.proofExpiryMs??60_000)};
        },
      }, business: options.expiryMs ? {
        ...business,
        ownedSessionRead: async (sessionId, callerSignal) => {
          const grant = await business.ownedSessionRead(sessionId, callerSignal);
          if(options.denyReadAfterMs){readDeadline??=Date.now()+options.denyReadAfterMs;if(Date.now()>=readDeadline)throw Error('fixture Session read authorization revoked');}
          return Object.freeze({ ...grant, expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), Date.now() + options.expiryMs)).toISOString() });
        },
      } : business, model: policy, signal });
  });
  await f.main.startHost();
  const drafts = (method, payload={}) => ctx.afosDraftRuntime.invoke('afos/drafts/'+method,payload,new AbortController().signal);
  let sessionId;
  if(!options.skipStart){
    const response = await drafts('start',{ sources: [f.ref], goal: 'Read original owned local history.', operationId: 'native-five-fixture' });
    assert.equal(response.ok, true, JSON.stringify(response));
    sessionId=response.value.sessionId;
    await ctx.agents.get(sessionId).whenIdle(); await new Promise(resolve=>setImmediate(resolve));
  }
  const unary = async (endpoint,payload) => {
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://127.0.0.1/api/'+endpoint,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'native-fixture',method:endpoint,payload})}));
    assert.equal(response.status,200);return (await response.json()).result;
  };
  return { ...f,ctx:()=>ctx,drafts,unary,sessionId,
    follow: signal => ctx.afosEnterpriseIngress.openNative('session/follow',{args:{request:{address:{kind:'session',sessionId},assistantStream:true,maxMessages:500,turnWindow:{minMessages:50,minTurns:2}}}},signal,(async function*(){})()),
    control: signal => ctx.afosEnterpriseIngress.openNative('session/control',{args:{}},signal,(async function*(){})()),
  };
}

test('AFOS-WS-01 fixed opt-in original public mux scope assembles after private core without exposing the Controller',async()=>{const f=await composed();try{const ctx=f.ctx();assert.ok(ctx.afosNativeReadBridge);assert.equal(ctx.get('typertGateway'),undefined);assert.equal(ctx.get('sessionController'),undefined);assert.equal((await f.unary('session/list',{args:{_request:{}}})).ok,true);}finally{await f.cleanup();}});


const profileRequire=createRequire(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/package.json',import.meta.url));
const gatewayRequire=createRequire(profileRequire.resolve('@deepseek-ai/dsh-api-gateway'));
const WebSocket=gatewayRequire('ws');
async function bounded(promise,ms=2000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture deadline')),ms);timer.unref();})]);}finally{clearTimeout(timer);}}
function originalCookie(f) {
  const ctx=f.ctx(),base='http://127.0.0.1:'+ctx.webServer.port;
  const url=new URL(ctx.connection.authenticatedUrl(base+'/'));let headers,status;
  assert.equal(ctx.connection.authorizeIndex({method:'GET',url:url.pathname+url.search,headers:{host:url.host}},{writeHead(s,h){status=s;headers=h;},end(){}}),false);
  assert.equal(status,303);
  const cookie=headers['Set-Cookie']??headers['set-cookie'];assert.ok(cookie,'Original browser authentication issued a fixture cookie');
  return {base,cookie:(Array.isArray(cookie)?cookie[0]:cookie).split(';')[0]};
}
async function socketFor(f,cookie){
  const ws=new WebSocket('ws://127.0.0.1:'+f.ctx().webServer.port+'/api/remote.mux',{headers:cookie?{Cookie:cookie}: {}});
  const opened=new Promise((resolve,reject)=>{ws.once('open',()=>resolve(ws));ws.once('error',reject);});
  try{return await bounded(opened);}catch(error){ws.terminate();throw error;}
}
async function httpFor(f,cookie,endpoint,payload,options={}){
  return fetch('http://127.0.0.1:'+f.ctx().webServer.port+'/api/'+endpoint,{method:'POST',
    headers:{'content-type':'application/json',...(cookie?{Cookie:cookie}: {})},
    body:JSON.stringify({type:'client-request',rpcId:'native-http-fixture',method:endpoint.split('?')[0],payload}),signal:options.signal});
}
async function httpUnary(f,cookie,endpoint,payload){
  const proof=cookie?.includes('afos_fixture_native=approved')?cookie:cookie+'; afos_fixture_native=approved';
  const response=await httpFor(f,proof,endpoint,payload);assert.equal(response.status,200);
  const envelope=await response.json();assert.equal(envelope.type,'server-response');return envelope.result;
}
function frames(ws){
  const queue=[],waiters=[];ws.on('message',raw=>{const value=JSON.parse(raw.toString());const waiter=waiters.shift();if(waiter)waiter(value);else queue.push(value);});
  return ()=>bounded(queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve)));
}
function open(ws,streamId,endpoint,payload){ws.send(JSON.stringify({type:'open',streamId,endpoint,payload}));}
async function endSocket(ws){if(!ws)return;if(ws.readyState===WebSocket.CLOSED)return;const closed=new Promise(resolve=>ws.once('close',resolve));ws.terminate();await bounded(closed);}

test('AFOS-WS-02 actual original mux requires original cookie AND separate fixture Main caller proof before readiness',async()=>{
  const f=await composed();let ws;try{
    const {cookie}=originalCookie(f);const before=f.calls.length;
    await assert.rejects(socketFor(f,''));await assert.rejects(socketFor(f,'invalid=bad; afos_fixture_native=approved'));
    await assert.rejects(socketFor(f,cookie));await assert.rejects(socketFor(f,cookie+'; afos_fixture_native=wrong'));
    assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);
    ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);
    open(ws,'ready','$events',{args:{}});const item=await next();
    assert.equal(item.type,'item');assert.equal(item.streamId,'ready');assert.equal(item.value.type,'ready');
    assert.deepEqual(item.value.host,{home:''});assert.deepEqual(Object.keys(item.value).sort(),['clientId','host','type']);
    assert.ok(f.calls.slice(before).includes('identity.current'));
    assert.equal((await f.unary('$events/result',{clientId:'fixture',eventId:'fixture',result:{kind:'next'}})).error?.code,'afos/profile-endpoint-denied');
  }finally{await endSocket(ws);await f.cleanup();}
});

test('AFOS-WS-03 actual original mux fresh facade forwards owned original follow/control and refuses foreign/write/SRC',async()=>{
  const f=await composed();let ws;try{
    const {cookie}=originalCookie(f);ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);
    const before=f.calls.length;
    open(ws,'follow','session/follow',{args:{request:{address:{kind:'session',sessionId:f.sessionId},assistantStream:true,maxMessages:500}}});
    const snapshot=await next();assert.equal(snapshot.type,'item',JSON.stringify(snapshot.error));assert.equal(snapshot.value.type,'snapshot');assert.equal(snapshot.value.header.id,f.sessionId);
    open(ws,'control','session/control',{args:{}});const baseline=await next();assert.equal(baseline.value.type,'baseline');assert.deepEqual(Object.keys(baseline.value.value.projections),[f.sessionId]);
    assert.ok(f.calls.slice(before).filter(action=>action==='identity.current').length>=2);
    ws.send(JSON.stringify({type:'cancel',streamId:'follow'}));
    open(ws,'foreign','session/follow',{args:{request:{address:{kind:'session',sessionId:'foreign-session'}}}});
    let denied;do{denied=await next();}while(denied.streamId!=='foreign');assert.equal(denied.type,'error');
    open(ws,'write','session/create',{args:{}});do{denied=await next();}while(denied.streamId!=='write');assert.equal(denied.type,'error');
    open(ws,'src','llm/listProviders',{args:{}});do{denied=await next();}while(denied.streamId!=='src');assert.equal(denied.type,'error');
    open(ws,'event-write','$events/result',{args:{}});do{denied=await next();}while(denied.streamId!=='event-write');assert.equal(denied.type,'error');
    assert.equal((await f.drafts('state')).ok,true);assert.equal((await f.unary('session/create',{args:{}})).ok,false);
  }finally{await endSocket(ws);await f.cleanup();}
});


test('AFOS-WS-04 real Main denial before upgrade and revocation during caller-proof await never negotiate the original mux',async()=>{
  const denied=await composed();try{
    const {cookie}=originalCookie(denied);denied.revoke();
    await assert.rejects(socketFor(denied,cookie+'; afos_fixture_native=approved'));
  }finally{await denied.cleanup();}
  let release,entered;const waiting=new Promise(resolve=>release=resolve),called=new Promise(resolve=>entered=resolve);
  const f=await composed({nativeCaller:async(request,signal)=>{entered();await waiting;signal.throwIfAborted();}});
  try{
    const {cookie}=originalCookie(f);const result=socketFor(f,cookie+'; afos_fixture_native=approved');const rejection=assert.rejects(result);
    await bounded(called);f.revoke();release();await bounded(rejection);
  }finally{release();await f.cleanup();}
});

test('AFOS-WS-05 selected short grants renew until Main denial ends only logical stream',async()=>{
  const f=await composed({expiryMs:180,denyReadAfterMs:320});let ws;try{
    const {cookie}=originalCookie(f);ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);
    open(ws,'ready','$events',{args:{}});assert.equal((await next()).value.type,'ready');
    open(ws,'own','session/follow',{args:{request:{address:{kind:'session',sessionId:f.sessionId},assistantStream:true,maxMessages:500}}});
    assert.equal((await next()).value.type,'snapshot');const opened=Date.now(),denied=await next();assert.ok(Date.now()-opened>=180);assert.equal(denied.streamId,'own');assert.equal(denied.type,'error');assert.equal(ws.readyState,WebSocket.OPEN);
    open(ws,'healthy-control','session/control',{args:{}});assert.equal((await next()).value.type,'baseline');
    open(ws,'foreign','session/follow',{args:{request:{address:{kind:'session',sessionId:'unowned'}}}});assert.equal((await next()).type,'error');
    assert.equal(ws.readyState,WebSocket.OPEN);
  }finally{await endSocket(ws);await f.cleanup();}
});

test('AFOS-WS-06 fresh Main revocation closes an established original mux and raw file/upload remain absent from parent',async()=>{
  const f=await composed();let ws;try{
    const {cookie}=originalCookie(f);ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);
    const shared=f.ctx().connection.createSharedFetchHandler('/api');
    for(const method of ['GET','HEAD'])assert.equal((await shared.fetch(new Request('http://127.0.0.1/api/file?path='+encodeURIComponent(f.base),{method}))).status,404);
    assert.equal((await shared.fetch(new Request('http://127.0.0.1/api/session/uploadFileBinary',{method:'POST',body:'probe'}))).status,415);
    open(ws,'ready','$events',{args:{}});assert.equal((await next()).value.type,'ready');
    const closed=new Promise(resolve=>ws.once('close',resolve));
    f.revoke();await assert.rejects(f.business().ownedSessionRead(f.sessionId,new AbortController().signal));await bounded(closed);
    assert.equal(ws.readyState,WebSocket.CLOSED);
  }finally{await endSocket(ws);await f.cleanup();}
});


test('AFOS-WS-07 unmodified published original Gateway Client becomes ready and generated Session Remote consumes the real original mux',async()=>{
  const f=await composed();let client,releaseRemote;const sockets=[],iterators=[];const abort=new AbortController();try{
    const {cookie,base}=originalCookie(f);const cordis=await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/cordis')).href);
    const {TypertRegistry}=await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-typert-registry')).href);
    const remote=await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-api-session-controller/remote')).href);
    // Node fixture adds the explicit synthetic Main-issued cookie. The original
    // browser factory's constructor takes only a URL; no product issuance is claimed.
    class CookieFixtureWebSocket extends WebSocket { constructor(url){super(url,{headers:{Cookie:cookie+'; afos_fixture_native=approved'}});sockets.push(this);} }
    const scope=vm.createContext({window:{},document:{baseURI:base+'/'},__DSH_TRANSPORT__:{ownsHost:true,streamBaseUrl:base+'/'},
      URL,Request,Response,Headers,AbortController,AbortSignal,Uint8Array,DataView,Blob,TextDecoder,TextEncoder,
      setTimeout,clearTimeout,crypto:webcrypto,WebSocket:CookieFixtureWebSocket,console});
    const clientJSON=vm.runInContext('JSON',scope);
    const publishedFactory=name=>{let declaration;scope.window.__ModuleLoader__={load(value){declaration=value;}};
      const file=profileRequire.resolve(name+'/client');vm.runInContext(readFileSync(file,'utf8'),scope,{filename:file,timeout:1000});
      assert.equal(declaration.id,name);return declaration.factory(external=>{assert.equal(external,'@deepseek-ai/cordis');return cordis;});};
    const connection=publishedFactory('@deepseek-ai/dsh-client-connection'),gateway=publishedFactory('@deepseek-ai/dsh-api-gateway');
    client=new cordis.Context();new TypertRegistry(client);
    connection.installConnection(client,{transport:{rpc:{async call(channel,endpoint,payload){assert.equal(channel,'/api');return clientJSON.parse(JSON.stringify(await httpUnary(f,cookie+'; afos_fixture_native=approved',endpoint,JSON.parse(JSON.stringify(payload)))));}}}});
    gateway.apply(client);assert.equal(client.connection.rpc.open,undefined);
    await bounded(new Promise(resolve=>{let release;const inspect=()=>{if(!client.connection.generation.getSnapshot())return;release?.();resolve();};release=client.connection.generation.subscribe(inspect);inspect();}));
    assert.equal(client.connection.generation.getSnapshot().host.home,'');assert.ok(sockets.length>=1);
    releaseRemote=await client.remote.$mount(remote.default);
    const request=clientJSON.parse(JSON.stringify({address:{kind:'session',sessionId:f.sessionId},assistantStream:true,maxMessages:500}));
    const iterator=client.remote.session.follow(request,abort.signal)[Symbol.asyncIterator]();
    iterators.push(iterator);
    const snapshot=await bounded(iterator.next());assert.equal(snapshot.value.type,'snapshot');assert.equal(snapshot.value.header.id,f.sessionId);
    const control=client.remote.session.control(abort.signal)[Symbol.asyncIterator]();
    iterators.push(control);
    const baseline=await bounded(control.next());assert.equal(baseline.value.type,'baseline');assert.deepEqual(Object.keys(baseline.value.value.projections),[f.sessionId]);
    const projections=await client.remote.session.projections(clientJSON.parse(JSON.stringify({sessionId:f.sessionId})),abort.signal);assert.equal(projections.ok,true,JSON.stringify(projections));assert.ok(projections.value.asOfSeq>=0);
    abort.abort();await bounded(Promise.allSettled([iterator.return(),control.return()]));
  }finally{
    abort.abort();
    try{await bounded(Promise.allSettled(iterators.map(iterator=>iterator.return())));await bounded(Promise.resolve(releaseRemote?.()));await bounded(Promise.resolve(client?.fiber.dispose()));}
    finally{for(const ws of sockets)await endSocket(ws);await f.cleanup();}
  }
});

test('AFOS-WS-08 current Main caller establishes only cold empty readiness; Session reads still require selection',async()=>{
  const f=await composed({skipStart:true});try{
    const {cookie}=originalCookie(f);assert.equal(f.ctx().afosDraftRuntime.nativeSessionId(),undefined);assert.equal(f.ctx().agents.list().length,0);
    await assert.rejects(socketFor(f,cookie));
    const cold=await socketFor(f,cookie+'; afos_fixture_native=approved');const coldNext=frames(cold);
    try{open(cold,'cold-ready','$events',{args:{}});assert.equal((await coldNext()).value.type,'ready');
      open(cold,'cold-list','session/list',{args:{_request:{}}});assert.equal((await coldNext()).type,'error');}
    finally{await endSocket(cold);}
    const state=await httpUnary(f,cookie,'afos/drafts/state',{});assert.equal(state.ok,true);
    const start=await httpUnary(f,cookie,'afos/drafts/start',{sources:[f.ref],goal:'First business task before native readiness.',operationId:'native-initial-fixture'});
    assert.equal(start.ok,true,JSON.stringify(start));await f.ctx().agents.get(start.value.sessionId).whenIdle();
    let ws;try{ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);open(ws,'after-task','$events',{args:{}});assert.equal((await next()).value.type,'ready');}finally{await endSocket(ws);}
  }finally{await f.cleanup();}
});

test('AFOS-WS-09 physical HTTP owned reads require original admission then the same Main caller proof before fresh Main',async()=>{
  const f=await composed();try{
    const {cookie}=originalCookie(f),before=f.calls.length;
    const cursor=f.ctx().agents.get(f.sessionId).session.snapshotEvents().at(-1).seq;
    const reads=[['session/list',{args:{_request:{}}}],['session/page',{args:{request:{address:{kind:'session',sessionId:f.sessionId},throughSeq:cursor,maxMessages:500}}}],['session/projections',{args:{request:{sessionId:f.sessionId}}}]];
    for(const [endpoint,payload] of reads){
      for(const proof of ['', 'invalid=bad; afos_fixture_native=approved', cookie, cookie+'; afos_fixture_native=wrong']){
        const response=await httpFor(f,proof,endpoint,payload);assert.ok([401,403].includes(response.status),endpoint+':'+response.status);await response.arrayBuffer();
      }
    }
    assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);
    for(const [endpoint,payload] of reads){const result=await httpUnary(f,cookie+'; afos_fixture_native=approved',endpoint,payload);assert.equal(result.ok,true,JSON.stringify(result));}
    const queried=await httpFor(f,cookie,'session/list?probe=1',{args:{_request:{}}});assert.equal(queried.status,403);await queried.arrayBuffer();
    const escaped=await httpFor(f,cookie,'session/%6cist',{args:{_request:{}}});assert.equal(escaped.status,403);await escaped.arrayBuffer();
  }finally{await f.cleanup();}
});

test('AFOS-WS-10 caller proof awaited across real Main revocation cannot return an owned HTTP result',async()=>{
  let release,entered;const waiting=new Promise(resolve=>release=resolve),called=new Promise(resolve=>entered=resolve);
  const f=await composed({nativeCaller:async(request,signal)=>{entered();await waiting;signal.throwIfAborted();}});
  try{
    const {cookie}=originalCookie(f),before=f.calls.length;
    const pending=httpFor(f,cookie+'; afos_fixture_native=approved','session/projections',{args:{request:{sessionId:f.sessionId}}}).then(response=>({response}),error=>({error}));
    await bounded(called);assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);
    f.revoke();release();const result=await bounded(pending);
    if(result.error)assert.equal(result.error.cause?.code,'UND_ERR_SOCKET');
    else if(result.response.status===200){const envelope=await result.response.json();assert.equal(envelope.result.ok,false);}
    else {assert.ok([401,403].includes(result.response.status));await result.response.arrayBuffer();}
    assert.ok(f.calls.slice(before).includes('identity.current'));
  }finally{release();await f.cleanup();}
});

test('AFOS-WS-11 original parent RPC keeps its unique interceptor and missing Main proof capability refuses assembly',async()=>{
  const f=await composed();try{
    const publicGateway=(await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-api-gateway')).href)).default;
    const gateways=[...f.ctx().registry.get(publicGateway).fibers].filter(fiber=>fiber.ctx.get('webServer')!==undefined);
    assert.equal(gateways.length,1);const gateway=gateways[0];await gateway.await();assert.equal(gateway.state,2);
    const injectionChildren=[...f.ctx().registry.values()].flatMap(runtime=>[...runtime.fibers]).filter(fiber=>fiber.parent.fiber.uid===gateway.uid);
    assert.equal(injectionChildren.length,2);
    for(const fiber of injectionChildren){await fiber.await();assert.equal(fiber.state,2);}
    assert.deepEqual(injectionChildren.map(fiber=>Object.keys(fiber.inject).sort().join(',')).sort(),['connection','connection,webServer']);
    assert.equal(gateway.ctx.get('connection').operator,f.ctx().connection.operator);
    assert.equal(gateway.ctx.get('webServer').port,f.ctx().webServer.port);
    assert.notEqual(gateway.ctx.get('webServer'),f.ctx().webServer);
    assert.throws(()=>f.ctx().connection.rpc.intercept('/api',()=>undefined),/already has an interceptor/);
    const {cookie}=originalCookie(f);assert.equal((await httpUnary(f,cookie,'afos/drafts/state',{})).ok,true);
    await assert.rejects(bootEnterpriseNativeWsCore({signal:new AbortController().signal}),error=>error.code==='afos/native-read-denied');
  }finally{await f.cleanup();}
});

test('AFOS-WS-12 actual fresh Main await followed by revocation refuses WS negotiation and wrong Origin is rejected before Main',async()=>{
  let entered,release,pause=false;const called=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
  const f=await composed({response:async request=>{if(pause&&request.action==='identity.current'){entered();await waiting;}return undefined;}});
  try{
    const {cookie}=originalCookie(f),before=f.calls.length;
    const wrongOrigin=new WebSocket('ws://127.0.0.1:'+f.ctx().webServer.port+'/api/remote.mux',{headers:{Cookie:cookie+'; afos_fixture_native=approved',Origin:'https://foreign.example'}});
    const refused=new Promise((resolve,reject)=>{wrongOrigin.once('open',()=>reject(new Error('Foreign Origin negotiated')));wrongOrigin.once('error',resolve);});
    await bounded(refused);wrongOrigin.terminate();assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);
    pause=true;const attempt=socketFor(f,cookie+'; afos_fixture_native=approved');const rejection=assert.rejects(attempt);
    await bounded(called);f.revoke();release();await bounded(rejection);
  }finally{release();await f.cleanup();}
});

test('AFOS-WS-13 caller socket close during proof wait aborts its capability and Host logout closes an established mux',async()=>{
  let entered,release,proofSignal,pause=false;const called=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
  const f=await composed({nativeCaller:async(_request,signal)=>{if(pause){proofSignal=signal;entered();await waiting;}signal.throwIfAborted();}});let ws;
  try{
    const {cookie}=originalCookie(f);pause=true;
    const unopened=new WebSocket('ws://127.0.0.1:'+f.ctx().webServer.port+'/api/remote.mux',{headers:{Cookie:cookie+'; afos_fixture_native=approved'}});
    const refused=new Promise((resolve,reject)=>{unopened.once('open',()=>reject(new Error('Aborted caller negotiated')));unopened.once('error',resolve);});
    await bounded(called);unopened.terminate();await bounded(refused);
    await bounded(new Promise(resolve=>{if(proofSignal.aborted)resolve();else proofSignal.addEventListener('abort',resolve,{once:true});}));release();
    pause=false;ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);open(ws,'ready','$events',{args:{}});assert.equal((await next()).value.type,'ready');
    const closed=new Promise(resolve=>ws.once('close',resolve));await f.main.logout();await bounded(closed);assert.equal(ws.readyState,WebSocket.CLOSED);
  }finally{release();await endSocket(ws);await f.cleanup();}
});

test('AFOS-WS-14 independent caller proof revocation and expiry close established sockets while Main authority remains valid',async()=>{
  for(const expires of [false,true]){
    const proof=new AbortController();const f=await composed({proofSignal:proof.signal,...(expires?{proofExpiryMs:180}: {})});let ws;
    try{
      const {cookie}=originalCookie(f);ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);
      open(ws,'ready','$events',{args:{}});assert.equal((await next()).value.type,'ready');
      const closed=new Promise(resolve=>ws.once('close',resolve));if(!expires)proof.abort();await bounded(closed);assert.equal(ws.readyState,WebSocket.CLOSED);
      const authority=await f.business().currentAuthority(new AbortController().signal);assert.equal(authority.project.id,'p1');
      if(!expires){const before=f.calls.length;await assert.rejects(socketFor(f,cookie+'; afos_fixture_native=approved'));assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);}
    }finally{await endSocket(ws);await f.cleanup();}
  }
});

test('AFOS-WS-15 independent proof revoke or expiry during fresh Main HTTP await destroys the response before owned content',async()=>{
  for(const expires of [false,true]){
    let entered,release,pause=false;const called=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve),proof=new AbortController();
    const f=await composed({proofSignal:proof.signal,...(expires?{proofExpiryMs:180}: {}),response:async request=>{if(pause&&request.action==='identity.current'){entered();await waiting;}return undefined;}});
    try{
      const {cookie}=originalCookie(f);pause=true;
      const pending=httpFor(f,cookie+'; afos_fixture_native=approved','session/projections',{args:{request:{sessionId:f.sessionId}}}).then(response=>({response}),error=>({error}));
      await bounded(called);if(!expires)proof.abort();const outcome=await bounded(pending);
      assert.equal(outcome.response,undefined);assert.equal(outcome.error?.cause?.code,'UND_ERR_SOCKET');
      pause=false;release();const authority=await f.business().currentAuthority(new AbortController().signal);assert.equal(authority.project.id,'p1');
    }finally{release();await f.cleanup();}
  }
});

test('AFOS-WS-16 early bytes plus caller FIN have bounded pending-proof cleanup without consuming carrier bytes',async()=>{
  let entered,proofSignal;const called=new Promise(resolve=>entered=resolve);
  const f=await composed({nativeCaller:async(_request,signal)=>{proofSignal=signal;entered();await new Promise(()=>{});}});let socket;
  try{
    const {cookie}=originalCookie(f),before=f.calls.length;
    socket=createConnection({host:'127.0.0.1',port:f.ctx().webServer.port});socket.on('error',()=>{});
    await bounded(new Promise(resolve=>socket.once('connect',resolve)));
    const received=[];socket.on('data',data=>received.push(data));
    socket.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:'+f.ctx().webServer.port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: Zml4dHVyZS1ub25jZS0xMg==\r\nSec-WebSocket-Version: 13\r\nCookie: '+cookie+'; afos_fixture_native=approved\r\n\r\n');
    // Malicious early carrier bytes are never read or re-framed by the wrapper.
    socket.write(Buffer.from([0x81,0x80,0,0,0,0]));await bounded(called);socket.end();
    await bounded(new Promise(resolve=>{if(proofSignal.aborted)resolve();else proofSignal.addEventListener('abort',resolve,{once:true});}),NATIVE_CALLER_PROOF_TIMEOUT_MS+1000);
    assert.equal(Buffer.concat(received).includes(Buffer.from('101 Switching Protocols')),false);
    assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);
  }finally{socket?.destroy();await f.cleanup();}
});

test('AFOS-WS-17 mux admission unload retains Root HTTP proof; Root proof unload refuses native reads before fresh Main',async()=>{
  const f=await composed();try{
    const {cookie}=originalCookie(f);
    const admissionEntry=[...f.ctx().loader.entries()].find(entry=>entry.options.name.endsWith('/native-ws-admission.js'));
    assert.ok(admissionEntry?.fiber);await admissionEntry.fiber.dispose();assert.ok(f.ctx().get('afosNativeHttpProof'));assert.ok(f.ctx().get('afosNativeReadBridge'));
    const before=f.calls.length;
    for(const endpoint of ['session/list','session/page','session/projections']){const response=await httpFor(f,cookie,endpoint,{args:{}});assert.equal(response.status,403);await response.arrayBuffer();}
    assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);
    assert.equal((await httpUnary(f,cookie+'; afos_fixture_native=approved','session/list',{args:{_request:{}}})).ok,true);
    const proofEntry=[...f.ctx().loader.entries()].find(entry=>entry.options.name.endsWith('/native-ws-http-admission.js'));assert.ok(proofEntry?.fiber);await proofEntry.fiber.dispose();assert.equal(f.ctx().get('afosNativeHttpProof'),undefined);
    const later=f.calls.length;
    for(const endpoint of ['session/list','session/page','session/projections']){
      const result=await httpUnary(f,cookie,endpoint,{args:{}});assert.equal(result.ok,false);assert.equal(result.error.code,'afos/native-read-denied');
    }
    assert.equal(f.calls.slice(later).filter(action=>action==='identity.current').length,0);
  }finally{await f.cleanup();}
});

test('AFOS-WS-18 two actual sockets retain one original operator id with isolated proof views and independent expiry/disposal',async()=>{
  const first=new AbortController(),second=new AbortController(),requests={};
  const f=await composed({callerGrant:(request,signal)=>{
    const key=request.headers.cookie.includes('afos_fixture_socket=first')?'first':'second';requests[key]=request;
    return {signal:AbortSignal.any([signal,key==='first'?first.signal:second.signal]),expiresAt:Date.now()+(key==='first'?180:60_000)};
  }});let a,b;try{
    const {cookie}=originalCookie(f);a=await socketFor(f,cookie+'; afos_fixture_native=approved; afos_fixture_socket=first');b=await socketFor(f,cookie+'; afos_fixture_native=approved; afos_fixture_socket=second');
    const gate=f.ctx().afosNativeHttpProof,base=f.ctx().connection.operator,viewA=gate.carrierPeer(requests.first,base),viewB=gate.carrierPeer(requests.second,base);
    assert.notEqual(viewA,viewB);assert.equal(viewA.id,base.id);assert.equal(viewB.id,base.id);assert.notEqual(viewA.ctx.fiber,base.ctx.fiber);assert.notEqual(viewB.ctx.fiber,base.ctx.fiber);
    assert.throws(()=>gate.carrierProof(base));const nextA=frames(a),nextB=frames(b),aClosed=new Promise(resolve=>a.once('close',resolve));
    open(a,'ready-a','$events',{args:{}});assert.equal((await nextA()).value.type,'ready');open(b,'ready-b','$events',{args:{}});assert.equal((await nextB()).value.type,'ready');
    await bounded(aClosed);assert.equal(b.readyState,WebSocket.OPEN);
    open(b,'second-read','session/follow',{args:{request:{address:{kind:'session',sessionId:f.sessionId},assistantStream:true,maxMessages:500}}});assert.equal((await nextB()).value.type,'snapshot');
    assert.ok((await f.unary('session/list',{args:{_request:{}}})).ok);assert.equal(second.signal.aborted,false);
    const bClosed=new Promise(resolve=>b.once('close',resolve));await viewB.dispose();await bounded(bClosed);assert.equal(base.ctx.fiber.uid!==null,true);
    assert.ok((await f.unary('session/list',{args:{_request:{}}})).ok);
  }finally{await endSocket(a);await endSocket(b);await f.cleanup();}
});

test('AFOS-WS-19 exact original invocation peer refuses late caller frame before timer, without borrowing another socket proof',async()=>{
  let entered,release,hold=true;const called=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
  const f=await composed({callerGrant:(request,signal)=>({signal,expiresAt:Date.now()+(request.headers.cookie.includes('afos_fixture_socket=short')?500:60_000)})});let a,b;
  const originalNow=Date.now;let controller,originalFollow;
  try{
    const gatewayClass=(await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-api-gateway')).href)).default;
    const publicFiber=[...f.ctx().registry.get(gatewayClass).fibers].find(fiber=>fiber.ctx.get('webServer'));
    const publicGateway=publicFiber.ctx.get('typertGateway');
    const direct=await publicGateway.wireStream.open('session/follow',{args:{request:{address:{kind:'session',sessionId:f.sessionId},assistantStream:true}}},(async function*(){})(),f.ctx().connection.operator,new AbortController().signal);
    await assert.rejects(direct[Symbol.asyncIterator]().next());
    controller=Reflect.ownKeys(f.ctx().reflect.store).map(key=>f.ctx().reflect.store[key]).find(record=>record.name==='sessionController'&&record.value).value;
    originalFollow=controller.follow;
    controller.follow=function(...args){const source=originalFollow.apply(this,args);return(async function*(){for await(const frame of source){if(hold){hold=false;entered();await waiting;}yield frame;}})();};
    const {cookie}=originalCookie(f);a=await socketFor(f,cookie+'; afos_fixture_native=approved; afos_fixture_socket=short');b=await socketFor(f,cookie+'; afos_fixture_native=approved; afos_fixture_socket=long');
    const nextA=frames(a),nextB=frames(b);open(a,'late-short','session/follow',{args:{request:{address:{kind:'session',sessionId:f.sessionId},assistantStream:true,maxMessages:500}}});
    await bounded(called);const current=originalNow();Date.now=()=>current+600;release();
    const denied=await nextA();assert.equal(denied.streamId,'late-short');assert.equal(denied.type,'error');Date.now=originalNow;
    open(b,'independent-long','session/follow',{args:{request:{address:{kind:'session',sessionId:f.sessionId},assistantStream:true,maxMessages:500}}});assert.equal((await nextB()).value.type,'snapshot');
  }finally{Date.now=originalNow;release();if(controller)controller.follow=originalFollow;await endSocket(a);await endSocket(b);await f.cleanup();}
});

test('AFOS-WS-20 caller proof which never settles reaches its fixed public admission deadline without opening the original mux',async()=>{
  let entered,proofSignal;const called=new Promise(resolve=>entered=resolve);
  const f=await composed({nativeCaller:async(_request,signal)=>{proofSignal=signal;entered();await new Promise(()=>{});}});let socket;
  try{
    const {cookie}=originalCookie(f),before=f.calls.length;
    socket=createConnection({host:'127.0.0.1',port:f.ctx().webServer.port});socket.on('error',()=>{});
    await bounded(new Promise(resolve=>socket.once('connect',resolve)));const received=[];socket.on('data',data=>received.push(data));
    socket.write('GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:'+f.ctx().webServer.port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: Zml4dHVyZS1ub25jZS0xMg==\r\nSec-WebSocket-Version: 13\r\nCookie: '+cookie+'; afos_fixture_native=approved\r\n\r\n');
    await bounded(called);await bounded(new Promise(resolve=>proofSignal.addEventListener('abort',resolve,{once:true})),NATIVE_CALLER_PROOF_TIMEOUT_MS+1000);
    assert.equal(Buffer.concat(received).includes(Buffer.from('101 Switching Protocols')),false);assert.equal(f.calls.slice(before).filter(action=>action==='identity.current').length,0);
  }finally{socket?.destroy();await f.cleanup();}
});

test('AFOS-WS-21 child fiber disposed first still gives a stable Peer close Promise and waits pending official cleanup',async()=>{
  for(const pendingFirst of [false,true]){
    let request,entered,release;const called=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
    const f=await composed({callerGrant:(value,signal)=>{request=value;return{signal,expiresAt:Date.now()+60_000};}});let ws;
    try{
      const {cookie}=originalCookie(f);ws=await socketFor(f,cookie+'; afos_fixture_native=approved');const next=frames(ws);open(ws,'ready','$events',{args:{}});assert.equal((await next()).value.type,'ready');
      const base=f.ctx().connection.operator,view=f.ctx().afosNativeHttpProof.carrierPeer(request,base),fiber=view.ctx.fiber;
      let finished=false;fiber.effect(()=>async()=>{entered();if(pendingFirst)await waiting;finished=true;},'fixture pending child cleanup');
      const closed=new Promise(resolve=>ws.once('close',resolve));const raw=fiber.dispose();await bounded(called);
      assert.throws(()=>f.ctx().afosNativeHttpProof.carrierProof(view));
      if(!pendingFirst)await raw;
      const first=view.dispose(),second=view.dispose();assert.ok(first instanceof Promise);assert.equal(first,second);
      let settled=false;first.then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));
      if(pendingFirst){assert.equal(settled,false);assert.equal(finished,false);release();}
      await bounded(first);await bounded(closed);assert.equal(finished,true);assert.equal(fiber.uid,null);assert.notEqual(base.ctx.fiber.uid,null);
      assert.equal((await f.unary('session/list',{args:{_request:{}}})).ok,true);
    }finally{release();await endSocket(ws);await f.cleanup();}
  }
});
