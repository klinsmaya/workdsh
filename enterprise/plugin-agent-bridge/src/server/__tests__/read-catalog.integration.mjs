import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture } from './desktop-fixture.mjs';
import { bootEnterpriseNativeWsCore } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/assembly.js';

const policy={provider:'afos-managed',model:'fixed-model',maxTokens:64};
const require=createRequire(process.env.AFOS_READ_CATALOG_PROVIDER_PACKAGE);
const WebSocket=createRequire(require.resolve('@deepseek-ai/dsh-api-gateway'))('ws');
async function bounded(promise,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('read fixture deadline')),ms);timer.unref();})]);}finally{clearTimeout(timer);}}
function originalCookie(ctx){const base='http://127.0.0.1:'+ctx.webServer.port,url=new URL(ctx.connection.authenticatedUrl(base+'/'));let status,headers;
  assert.equal(ctx.connection.authorizeIndex({method:'GET',url:url.pathname+url.search,headers:{host:url.host}},{writeHead(s,h){status=s;headers=h;},end(){}}),false);
  assert.equal(status,303);const value=headers['Set-Cookie']??headers['set-cookie'];return {base,cookie:(Array.isArray(value)?value[0]:value).split(';')[0]};}
async function composed(options={}){let ctx,models=0,created=0;
  const f=await fixture({base:options.base,keepBase:options.keepBase,response:options.response,stopHost:async()=>{if(ctx){const old=ctx;ctx=undefined;await old.fiber.dispose();}},model:async()=>{models++;return [{type:'finish',reason:{kind:'stop'}}];}});
  await f.ready();f.capability({ingressValidated:true,sandbox:'full'});
  f.startHook(async(signal,layout,authority,business)=>{
    ctx=await bootEnterpriseNativeWsCore({root:layout.profile,binding:authority.binding,projectId:authority.project.id,model:policy,signal,business:options.business?options.business(business):business,
      nativeCaller:{async assertRequest(request,signal){signal.throwIfAborted();const cookie=request.headers instanceof Headers?request.headers.get('cookie'):request.headers.cookie;
        if(typeof cookie!=='string'||!cookie.split(';').map(x=>x.trim()).includes('afos_fixture_native=approved'))throw Error('caller missing');
        return {signal,expiresAt:Date.now()+60_000};}}});
  });
  await f.main.startHost();
  const drafts=(method,payload={})=>ctx.afosDraftRuntime.invoke('afos/drafts/'+method,payload,new AbortController().signal);
  const http=async(endpoint,payload={},extra={})=>{const {base,cookie}=originalCookie(ctx);const response=await fetch(base+'/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json',Cookie:cookie+'; afos_fixture_native=approved',...extra},body:JSON.stringify({type:'client-request',rpcId:'read-fixture',method:endpoint,payload})});
    if(response.status!==200)return {status:response.status};return (await response.json()).result;};
  const socket=async()=>{const {base,cookie}=originalCookie(ctx),ws=new WebSocket(base.replace('http:','ws:')+'/api/remote.mux',{headers:{Cookie:cookie+'; afos_fixture_native=approved'}});
    await bounded(new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);}));const queue=[],waiters=[];
    ws.on('message',raw=>{const value=JSON.parse(raw.toString());const waiter=waiters.shift();if(waiter)waiter(value);else queue.push(value);});
    return {ws,open:(id,endpoint,payload={args:{}})=>ws.send(JSON.stringify({type:'open',streamId:id,endpoint,payload})),next:()=>bounded(queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve))),close:async()=>{if(ws.readyState===WebSocket.CLOSED)return;const closed=new Promise(resolve=>ws.once('close',resolve));ws.terminate();await bounded(closed);}};};
  return {...f,get main(){return f.main;},ctx:()=>ctx,drafts,http,socket,models:()=>models,created:()=>created,
    reopen:async binding=>{const authority=await f.reopenMain(binding);await f.main.startHost();created=0;
      ctx.on('agent/created',()=>{created++;});return authority;}};
}

async function publicSdk(f){
  const {base,cookie}=originalCookie(f.ctx()),sockets=[],releases=[];
  const cordis=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const {TypertRegistry}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-registry')).href);
  const cli=createRequire(require.resolve('@deepseek-ai/dsh/package.json')),web=createRequire(cli.resolve('@deepseek-ai/dsh-web-app/package.json'));
  class CookieWebSocket extends WebSocket{constructor(url){super(url,{headers:{Cookie:cookie+'; afos_fixture_native=approved'}});sockets.push(this);}}
  const scope=vm.createContext({window:{},document:{baseURI:base+'/'},__DSH_TRANSPORT__:{ownsHost:true,streamBaseUrl:base+'/'},
    URL,Request,Response,Headers,AbortController,AbortSignal,Uint8Array,DataView,Blob,TextDecoder,TextEncoder,setTimeout,clearTimeout,crypto:webcrypto,WebSocket:CookieWebSocket,console});
  const clientJSON=vm.runInContext('JSON',scope),client=new cordis.Context();new TypertRegistry(client);
  const published=name=>{let declaration;scope.window.__ModuleLoader__={load(row){declaration=row;}};const file=require.resolve(name+'/client');vm.runInContext(readFileSync(file,'utf8'),scope,{filename:file,timeout:1000});
    return declaration.factory(name=>{assert.equal(name,'@deepseek-ai/cordis');return cordis;});};
  const connection=published('@deepseek-ai/dsh-client-connection'),gateway=published('@deepseek-ai/dsh-api-gateway');
  connection.installConnection(client,{transport:{rpc:{async call(channel,endpoint,payload){assert.equal(channel,'/api');return clientJSON.parse(JSON.stringify(await f.http(endpoint,JSON.parse(JSON.stringify(payload)))));}}}});
  gateway.apply(client);
  await bounded(new Promise(resolve=>{let release;const check=()=>{if(!client.connection.generation.getSnapshot())return;release?.();resolve();};release=client.connection.generation.subscribe(check);check();}));
  for(const name of ['@deepseek-ai/dsh-api-session-controller','@deepseek-ai/dsh-api-workspace-controller','@deepseek-ai/dsh-api-settings-controller']){
    const remote=await import(pathToFileURL((name.includes('session')?require:web).resolve(name+'/remote')).href);releases.push(await client.remote.$mount(remote.default));
  }
  return {client,json:value=>clientJSON.parse(JSON.stringify(value)),close:async()=>{for(const release of releases)await release();await client.fiber.dispose();for(const ws of sockets)ws.terminate();}};
}

test('READ-CATALOG-01 actual cold original four-method directory and write refusal',async()=>{const f=await composed();let socket;try{
  assert.equal(f.ctx().agents.list().length,0);
  const result=await f.http('session/list',{args:{_request:{}}});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.value.items,[]);
  socket=await f.socket();socket.open('workspace','workspace/follow');const workspace=await socket.next();assert.equal(workspace.type,'item',JSON.stringify(workspace));assert.equal(workspace.value.type,'baseline');assert.deepEqual(workspace.value.value,{items:[],archivedSessionIds:[],pinnedSessionIds:[]});
  socket.open('control','session/control');const control=await socket.next();assert.equal(control.type,'item');assert.deepEqual(control.value,{type:'baseline',value:{projections:{}}});
  const settings=await f.http('settings/describe',{args:{}});assert.equal(settings.ok,false);assert.equal(settings.error.code,'gateway/internal');
  for(const endpoint of ['workspace/initializeDefault','session/create','session/prompt','settings/write','session/uploadFileBinary'])assert.ok((result=>result.ok===false||result.status===403)(await f.http(endpoint,{args:{}})),endpoint);
  assert.equal(f.ctx().agents.list().length,0);assert.equal(f.models(),0);
}finally{await socket?.close();await f.cleanup();}});

if(process.env.AFOS_COLD_CHILD_BASE)test('READ-CATALOG-CHILD second process reads original persisted bytes and constructs zero Agents',async()=>{
  const f=await composed({base:process.env.AFOS_COLD_CHILD_BASE,keepBase:true});try{
    assert.notEqual(process.pid,Number(process.env.AFOS_COLD_PARENT_PID));const id=process.env.AFOS_COLD_CHILD_SESSION;
    const list=await f.http('session/list',{args:{_request:{}}});assert.equal(list.ok,true);assert.equal(list.value.items[0].sessionId,id);assert.equal(list.value.items[0].agentAvailable,false);
    const projections=await f.http('session/projections',{args:{request:{sessionId:id}}});assert.equal(projections.ok,true);
    const page=await f.http('session/page',{args:{request:{address:{kind:'session',sessionId:id},throughSeq:projections.value.asOfSeq,maxMessages:500}}});assert.equal(page.ok,true);assert.ok(JSON.stringify(page.value).includes('Second process persisted history.'));
    assert.equal(f.ctx().agents.list().length,0);assert.equal(f.models(),0);console.log(JSON.stringify({case:'actual-second-process-cold-read',pid:process.pid,parentPid:Number(process.env.AFOS_COLD_PARENT_PID),list:1,pageRecords:page.value.records.length,agents:0,models:0}));
  }finally{await f.cleanup();}
});
else test('READ-CATALOG-06 shutdown and second process consume actual persisted original history',async()=>{const f=await composed();try{
  const start=await f.drafts('start',{sources:[f.ref],goal:'Second process persisted history.',operationId:'read-second-process'});assert.equal(start.ok,true);await f.ctx().agents.get(start.value.sessionId).whenIdle();await f.main.suspend();
  const childEnv={...process.env,AFOS_COLD_CHILD_BASE:f.base,AFOS_COLD_CHILD_SESSION:start.value.sessionId,AFOS_COLD_PARENT_PID:String(process.pid)};delete childEnv.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['--test','--test-concurrency=1','--test-name-pattern=READ-CATALOG-CHILD',fileURLToPath(import.meta.url)],{env:childEnv,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const code=await bounded(new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),15000);assert.equal(code,0,stdout+stderr);assert.ok(stdout.includes('actual-second-process-cold-read'),stdout+stderr);console.log(stdout.trim());
}finally{await f.cleanup();}});

test('READ-CATALOG-02 original persisted SQLite/JSONL page/projections after stop and new Main/Host without Agent',async()=>{const f=await composed();let socket;try{
  const start=await f.drafts('start',{sources:[f.ref],goal:'Persistent owned history fixture.',operationId:'read-cold-owned'});assert.equal(start.ok,true,JSON.stringify(start));
  const id=start.value.sessionId;await f.ctx().agents.get(id).whenIdle();await new Promise(resolve=>setImmediate(resolve));
  // An actual persisted unowned row shares the native storage, never Main's map.
  const handle=await f.ctx().get('sessionPersistence').create({...f.ctx().agents.get(id).session.header,id:'unowned-history'});
  await handle.flush();await handle.close();
  const binding=(await f.business().currentAuthority(new AbortController().signal)).binding;
  const liveProjection=await f.http('session/projections',{args:{request:{sessionId:id}}});assert.equal(liveProjection.ok,true,JSON.stringify(liveProjection));
  const models=f.models();await f.reopen(binding);assert.equal(f.ctx().afosDraftRuntime.nativeSessionId(),undefined);assert.equal(f.ctx().agents.list().length,0);
  const list=await f.http('session/list',{args:{_request:{}}});assert.equal(list.ok,true,JSON.stringify(list));assert.equal(list.value.items.length,1);assert.equal(list.value.items[0].sessionId,id);assert.equal(list.value.items[0].agentAvailable,false);
  const projections=await f.http('session/projections',{args:{request:{sessionId:id}}});assert.equal(projections.ok,true,JSON.stringify(projections));assert.ok(projections.value.asOfSeq>=0);
  const page=await f.http('session/page',{args:{request:{address:{kind:'session',sessionId:id},throughSeq:projections.value.asOfSeq,maxMessages:500}}});assert.equal(page.ok,true,JSON.stringify(page));assert.ok(page.value.records.length>0);assert.ok(JSON.stringify(page.value).includes('Persistent owned history fixture.'));
  assert.equal((await f.http('session/page',{args:{request:{address:{kind:'session',sessionId:'foreign-session'},throughSeq:0}}})).ok,false);
  assert.equal((await f.http('session/projections',{args:{request:{sessionId:'foreign-session'}}})).ok,false);
  assert.equal((await f.http('session/projections',{args:{request:{sessionId:'unowned-history'}}})).ok,false);
  assert.equal((await f.http('session/page',{args:{request:{address:{kind:'session',sessionId:id},throughSeq:Number.MAX_SAFE_INTEGER}}})).ok,false);
  socket=await f.socket();socket.open('workspace','workspace/follow');assert.equal((await socket.next()).type,'item');socket.open('control','session/control');assert.equal((await socket.next()).type,'item');
  // The bounded adapter returns exactly the original cold snapshot without resuming promotion.
  socket.open('cold-follow','session/follow',{args:{request:{address:{kind:'session',sessionId:id},assistantStream:true,maxMessages:500}}});const follow=await socket.next();assert.equal(follow.type,'item');assert.equal(follow.value.type,'snapshot');assert.equal(follow.value.header.id,id);assert.deepEqual(follow.value.assistantStream,{revision:0});
  socket.open('unowned-cold-follow','session/follow',{args:{request:{address:{kind:'session',sessionId:'unowned-history'},assistantStream:true}}});assert.equal((await socket.next()).type,'error');
  assert.equal(f.ctx().agents.list().length,0);assert.equal(f.created(),0);assert.equal(f.models(),models);
  const before=f.calls.filter(x=>x==='identity.current').length;await f.http('session/projections',{args:{request:{sessionId:id}}});assert.ok(f.calls.filter(x=>x==='identity.current').length>before);
  f.revoke();const refused=await f.http('session/projections',{args:{request:{sessionId:id}}}).catch(()=>({ok:false}));assert.equal(refused.ok,false);
}finally{await socket?.close();await f.cleanup();}});

test('READ-CATALOG-03 unmodified original public SDK consumes real cold list/page and catalog streams',async()=>{const f=await composed();let sdk;const abort=new AbortController(),iterators=[];try{
  const start=await f.drafts('start',{sources:[f.ref],goal:'Public SDK cold history.',operationId:'read-sdk-owned'});assert.equal(start.ok,true);const id=start.value.sessionId;
  await f.ctx().agents.get(id).whenIdle();const binding=(await f.business().currentAuthority(abort.signal)).binding,models=f.models();await f.reopen(binding);
  sdk=await publicSdk(f);const remote=sdk.client.remote;
  const list=await remote.session.list(sdk.json({}),abort.signal);assert.equal(list.ok,true);assert.equal(JSON.stringify(list.value.items.map(x=>x.sessionId)),JSON.stringify([id]));
  const projections=await remote.session.projections(sdk.json({sessionId:id}),abort.signal);assert.equal(projections.ok,true);
  const page=await remote.session.page(sdk.json({address:{kind:'session',sessionId:id},throughSeq:projections.value.asOfSeq,maxMessages:500}),abort.signal);assert.equal(page.ok,true);assert.ok(JSON.stringify(page.value).includes('Public SDK cold history.'));
  for(const stream of [remote.workspace.follow(abort.signal),remote.session.control(abort.signal)]){const iterator=stream[Symbol.asyncIterator]();iterators.push(iterator);const first=await bounded(iterator.next());assert.equal(first.value.type,'baseline');}
  const settings=await remote.settings.describe();assert.equal(settings.ok,false);assert.equal(settings.error.code,'gateway/internal');
  assert.equal((await remote.session.projections(sdk.json({sessionId:'unowned-history'}),abort.signal)).ok,false);
  assert.equal(f.ctx().agents.list().length,0);assert.equal(f.created(),0);assert.equal(f.models(),models);
}finally{abort.abort();await Promise.allSettled(iterators.map(it=>it.return()));await sdk?.close();await f.cleanup();}});

test('READ-CATALOG-04 held fresh authority cannot return a late directory after account cutoff',async()=>{let held=false;const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await composed({response:async request=>{if(held&&request.action==='identity.current'){entered.resolve();await release.promise;}return undefined;}});try{
    held=true;const pending=f.http('session/list',{args:{_request:{}}}).catch(()=>({ok:false}));await bounded(entered.promise);
    const stopped=f.main.suspend();held=false;release.resolve();const result=await bounded(pending);assert.ok(result.ok===false||result.status===403);await stopped;
    assert.equal(f.ctx(),undefined);
  }finally{release.resolve();await f.cleanup();}});

test('READ-CATALOG-05 project replacement and changed server account cannot reuse a cold directory or carrier',async()=>{const f=await composed();let socket;try{
  const start=await f.drafts('start',{sources:[f.ref],goal:'Project-bound cold directory.',operationId:'read-project-owned'});assert.equal(start.ok,true);
  await f.ctx().agents.get(start.value.sessionId).whenIdle();const binding=(await f.business().currentAuthority(new AbortController().signal)).binding;
  await f.reopen(binding);const previous=await f.business().ownedSessionRead(start.value.sessionId,new AbortController().signal);
  socket=await f.socket();socket.open('catalog','session/control');assert.equal((await socket.next()).type,'item');const closed=new Promise(resolve=>socket.ws.once('close',resolve));
  await f.main.selectProject('p1');await bounded(closed);assert.equal(previous.signal.aborted,true);await f.main.startHost();
  const current=await f.business().ownedSessionRead(start.value.sessionId,new AbortController().signal);assert.notEqual(current.epoch,previous.epoch);
  const list=await f.http('session/list',{args:{_request:{}}});assert.equal(list.ok,true);assert.equal(list.value.items[0].sessionId,start.value.sessionId);
  f.principal('other-account');const changed=await f.http('session/page',{args:{request:{address:{kind:'session',sessionId:start.value.sessionId},throughSeq:0}}}).catch(()=>({ok:false}));
  assert.ok(changed.ok===false||changed.status===403);assert.equal(current.signal.aborted,true);
}finally{await socket?.close();await f.cleanup();}});

export { composed, bounded, publicSdk };
