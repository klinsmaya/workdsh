import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile,symlink} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {fixture} from './desktop-fixture.mjs';
import {runtimeEnvironment} from '../../../../../dsh-plugin-desktop/src/runtime-security.ts';
import {MainCallerProofIssuer,NATIVE_WITNESS_HEADER} from '../../../../../dsh-plugin-desktop/src/enterprise-caller-proof.ts';
import {attachMainBusinessIpc} from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/main-ipc.js';
import {managedCliProfilePatch} from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/cli-profile.js';
const providerRoot=fileURLToPath(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/',import.meta.url));
const require=createRequire(join(providerRoot,'package.json')),cli=require.resolve('@deepseek-ai/dsh/lib/bin.js'),WebSocket=createRequire(require.resolve('@deepseek-ai/dsh-api-gateway'))('ws');
const policy={provider:'afos-managed',model:'fixed-model',maxTokens:64};
async function composed(t,{response,model}={}){
 let child,channel,issuer,ready,wire=[];
 const stop=async()=>{issuer?.close();await channel?.close();if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}};
 const f=await fixture({response,stopHost:stop,model:model??(async()=>[{type:'finish',reason:{kind:'stop'}}])});t.after(()=>f.cleanup());await f.ready();f.capability({ingressValidated:true,sandbox:'full'}); // Fixture switch only; production remains false/unavailable.
 f.startHook(async(signal,layout,authority,business)=>{
  const home=join(layout.cache,'caller-cli'),profile=join(home,'profiles','afos-managed');await mkdir(profile,{recursive:true,mode:0o700});
  await writeFile(join(profile,'package.json'),JSON.stringify({name:'afos-test-profile',private:true,type:'module',dsh:{profile:{bundles:[]}}})+'\n',{mode:0o600,flag:'wx'});
  const patch=managedCliProfilePatch({root:layout.profile,binding:authority.binding,model:policy,signal,nativeCaller:true});
  patch[0].insert[0].config.push({id:'afos-cli-caller-fixture',name:pathToFileURL(join(providerRoot,'tests/fixtures/cli-caller-consumer.mjs')).href});
  await writeFile(join(profile,'cordis.patch.yml'),JSON.stringify(patch)+'\n',{mode:0o600,flag:'wx'});await symlink(join(providerRoot,'node_modules'),join(profile,'node_modules'),'dir');
  child=spawn(process.execPath,[cli,'--profile','afos-managed'],{cwd:home,env:{...runtimeEnvironment(process.env),DSH_HOME:home,DSH_AGENTS_HOME:join(home,'agents'),DSH_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe','ipc'],serialization:'json'});
  let stdout='',stderr='';const messages=Promise.withResolvers(),appReady=Promise.withResolvers();messages.promise.catch(()=>{});appReady.promise.catch(()=>{});
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  createInterface({input:child.stdout}).on('line',line=>{if(line.startsWith('AFOS_RESULT '))messages.resolve(JSON.parse(line.slice(12)));if(line==='AFOS_CLI_READY v1')appReady.resolve();});
  child.once('exit',code=>{const e=Error('fixture CLI exit '+code+' '+stdout+' '+stderr);messages.reject(e);appReady.reject(e);});
  const endpoint={send:message=>{wire.push(message);return new Promise((resolve,reject)=>child.send(message,e=>e?reject(e):resolve()));},messages:listener=>{const accept=value=>{wire.push(value);listener(value);};child.on('message',accept);return()=>child.off('message',accept);},disconnected:listener=>{child.on('disconnect',listener);return()=>child.off('disconnect',listener);}};
  channel=await attachMainBusinessIpc(endpoint,business,signal,{root:layout.profile,model:policy},{assertRequest:(request,s)=>{if(!issuer)throw Error('caller issuer not bound');return issuer.assertRequest(request,s);}});
  ready=await messages.promise;await appReady.promise;assert.equal(ready.rootPrivate,true);assert.notEqual(ready.pid,process.pid);
 });await f.main.startHost();
 const account=new AbortController(),window=new AbortController(),frame={detached:false,url:'http://'+ready.authority+'/',top:null};frame.top=frame;
 const session={},contents={id:19,session,mainFrame:frame,isDestroyed:()=>false,getURL:()=>frame.url};
 issuer=new MainCallerProofIssuer({contents,session,partition:'afos-enterprise-ui',authority:ready.authority,uiUrl:frame.url,accountSignal:account.signal,hostSignal:f.business().hostSignal,windowSignal:window.signal});let requestId=0;
 const stamp=(path='/api/afos/drafts/state',method='POST',proofIssuer=issuer)=>proofIssuer.stampRequest({id:++requestId,url:(method==='GET'?'ws://':'http://')+ready.authority+path,method,resourceType:method==='GET'?'webSocket':'xhr',webContentsId:19,webContents:contents,frame,requestHeaders:{}})[NATIVE_WITNESS_HEADER];
 const http=async(endpoint,payload={},witness)=>fetch('http://'+ready.authority+'/api/'+endpoint,{method:'POST',headers:{cookie:ready.cookie,'content-type':'application/json',...(witness?{[NATIVE_WITNESS_HEADER]:witness}:{})},body:JSON.stringify({type:'client-request',rpcId:'caller-proof-fixture',method:endpoint,payload})});
 const unary=async(endpoint,payload={})=>{const r=await http(endpoint,payload,stamp('/api/'+endpoint));assert.equal(r.status,200,endpoint);return (await r.json()).result;};
 const socket=async(witness)=>{const ws=new WebSocket('ws://'+ready.authority+'/api/remote.mux',{headers:{cookie:ready.cookie,...(witness?{[NATIVE_WITNESS_HEADER]:witness}:{})}});try{await Promise.race([once(ws,'open'),once(ws,'error').then(([e])=>{throw e;})]);return ws;}catch(e){ws.terminate();throw e;}};
 return {...f,ready,stamp,http,unary,socket,window,account,issuer,wire,frame};
}
test('real original CLI cold finite business HTTP requires original auth and Main-issued one-use witness',{timeout:20000},async t=>{
 const f=await composed(t),before=f.calls.length;
 for(const endpoint of ['afos/drafts/state','afos/drafts/materials','afos/drafts/start','afos/drafts/archive','session/list']){const r=await f.http(endpoint);assert.equal(r.status,403);await r.arrayBuffer();}
 assert.equal(f.calls.length,before,'missing caller proof must precede fresh Main');
 const state=await f.unary('afos/drafts/state');assert.equal(state.ok,true);assert.equal(state.value.drafts.length,0);
 const materials=await f.unary('afos/drafts/materials');assert.equal(materials.ok,true);assert.equal(materials.value[0].materialId,'m1');
 const witness=f.stamp();assert.equal((await f.http('afos/drafts/state',{},witness)).status,200);assert.equal((await f.http('afos/drafts/state',{},witness)).status,403);
 const snapshot=await f.unary('afos/drafts/snapshot',{ref:f.ref});assert.equal(snapshot.ok,true);assert.equal(snapshot.value.text,'Server source');
 assert.equal(f.tables.artifacts.size,0);assert.ok(!JSON.stringify(f.wire).includes('fixture-access'));assert.ok(!JSON.stringify(f.wire).includes('fixture-refresh'));
 console.log('AFOS_CALLER_CLI cold Main proof real original CLI exercised');
});
test('real original CLI Main witness covers canonical path/body variants and foreign Host transfer',{timeout:20000},async t=>{
 const f=await composed(t),before=f.calls.length;
 for(const endpoint of ['afos/drafts/state?x=1','afos/drafts/state/','afos/drafts/%73tate','session/delete','file','credential/token','afos/drafts/nope']){const r=await f.http(endpoint,{},'A'.repeat(43));assert.equal(r.status,403,endpoint);await r.arrayBuffer();}
 assert.equal(f.calls.length,before);
 const witness=f.stamp('/api/afos/drafts/state');const r=await f.http('afos/drafts/archive',{},witness);assert.equal(r.status,403);assert.equal(f.calls.length,before);
 const rr=await f.unary('afos/drafts/state',{actor:'forged'});assert.equal(rr.ok,false);
 f.window.abort();await assert.rejects(f.unary('afos/drafts/state'));assert.equal(f.tables.artifacts.size,0);
});
test('real original CLI original mux uses per-socket Main witness and immediate window cutoff',{timeout:20000},async t=>{
 const f=await composed(t);await assert.rejects(f.socket());
 const cold=await f.socket(f.stamp('/api/remote.mux','GET'));cold.terminate();
 const started=await f.unary('afos/drafts/start',{sources:[f.ref],goal:'Produce a local original CLI Session.',operationId:'caller-original-cli'});assert.equal(started.ok,true,JSON.stringify(started));
 let state;for(let n=0;n<50;n++){state=await f.unary('afos/drafts/state');if(state.value.drafts[0]?.execution==='completed_local')break;await new Promise(r=>setTimeout(r,10));}assert.equal(state.value.drafts[0].execution,'completed_local');
 const a=await f.socket(f.stamp('/api/remote.mux','GET')),b=await f.socket(f.stamp('/api/remote.mux','GET'));t.after(()=>{a.terminate();b.terminate();});
 const messages=[];a.on('message',raw=>messages.push(JSON.parse(raw)));a.send(JSON.stringify({type:'open',streamId:'ready-a',endpoint:'$events',payload:{args:{}}}));
 for(let n=0;n<100&&!messages.length;n++)await new Promise(r=>setTimeout(r,5));assert.equal(messages[0].value.type,'ready');
 const closedA=once(a,'close');a.close();await closedA;
 const messagesB=[];b.on('message',raw=>messagesB.push(JSON.parse(raw)));b.send(JSON.stringify({type:'open',streamId:'ready-b',endpoint:'$events',payload:{args:{}}}));
 for(let n=0;n<100&&!messagesB.length;n++)await new Promise(r=>setTimeout(r,5));assert.equal(messagesB[0].value.type,'ready','closing one same-operator socket preserves the other caller scope');
 const closedB=once(b,'close');f.window.abort();await closedB;
 assert.ok(f.wire.some(frame=>frame.kind==='caller-cutoff'));assert.equal(f.tables.artifacts.size,0);
});

test('unmodified standard Gateway Client cold readiness uses Main proof before first Session and consumes owned follow',{timeout:20000},async t=>{
 const {readFileSync}=await import('node:fs'),{default:vm}=await import('node:vm'),{webcrypto}=await import('node:crypto');
 const f=await composed(t),sockets=[],iterators=[],abort=new AbortController();let client,releaseRemote;
 t.after(async()=>{abort.abort();await Promise.allSettled(iterators.map(it=>it.return()));await releaseRemote?.();await client?.fiber.dispose();for(const ws of sockets)ws.terminate();});
 const cordis=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),{TypertRegistry}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-registry')).href),remote=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-api-session-controller/remote')).href);
 const base='http://'+f.ready.authority;
 // Test-only Node platform transport stamps from Main. Original SDK assets remain byte-identical.
 class OwnedWebSocket extends WebSocket {constructor(url){super(url,{headers:{Cookie:f.ready.cookie,[NATIVE_WITNESS_HEADER]:f.stamp('/api/remote.mux','GET')}});sockets.push(this);}}
 const scope=vm.createContext({window:{},document:{baseURI:base+'/'},__DSH_TRANSPORT__:{ownsHost:true,streamBaseUrl:base+'/'},URL,Request,Response,Headers,AbortController,AbortSignal,Uint8Array,DataView,Blob,TextDecoder,TextEncoder,setTimeout,clearTimeout,crypto:webcrypto,WebSocket:OwnedWebSocket,console});
 const json=vm.runInContext('JSON',scope),published=name=>{let declaration;scope.window.__ModuleLoader__={load(v){declaration=v;}};const file=require.resolve(name+'/client');vm.runInContext(readFileSync(file,'utf8'),scope,{filename:file,timeout:1000});assert.equal(declaration.id,name);return declaration.factory(external=>{assert.equal(external,'@deepseek-ai/cordis');return cordis;});};
 const connection=published('@deepseek-ai/dsh-client-connection'),gateway=published('@deepseek-ai/dsh-api-gateway');client=new cordis.Context();new TypertRegistry(client);
 connection.installConnection(client,{transport:{rpc:{async call(channel,endpoint,payload){assert.equal(channel,'/api');return json.parse(JSON.stringify(await f.unary(endpoint,JSON.parse(JSON.stringify(payload)))));}}}});gateway.apply(client);
 let timer;await Promise.race([new Promise(resolve=>{let release;const check=()=>{if(client.connection.generation.getSnapshot()){release?.();resolve();}};release=client.connection.generation.subscribe(check);check();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cold SDK ready unavailable')),2000);})]).finally(()=>clearTimeout(timer));
 assert.equal(client.connection.generation.getSnapshot().host.home,'');assert.equal((await f.unary('afos/drafts/state')).value.drafts.length,0);
 releaseRemote=await client.remote.$mount(remote.default);
 const list=await client.remote.session.list(json.parse('{}'),abort.signal);assert.equal(list.ok,true);
 assert.equal(JSON.stringify(list.value),'{"items":[]}','cold SDK readiness conveys an empty authorized catalog');
 const started=await f.unary('afos/drafts/start',{sources:[f.ref],goal:'Use the original Client cold entry.',operationId:'main-proof-cold-sdk'});assert.equal(started.ok,true,JSON.stringify(started));
 const follow=client.remote.session.follow(json.parse(JSON.stringify({address:{kind:'session',sessionId:started.value.sessionId},assistantStream:true,maxMessages:500})),abort.signal)[Symbol.asyncIterator]();iterators.push(follow);
 const snapshot=await follow.next();assert.equal(snapshot.value.type,'snapshot');assert.equal(snapshot.value.header.id,started.value.sessionId);assert.equal(f.tables.artifacts.size,0);
 console.log('AFOS_CALLER_SDK cold ready and first owned Session original SDK exercised');
});

test('real original CLI window cutoff settles pending fresh Main and discards noncooperative late authority',{timeout:20000},async t=>{
 let pause=false,enter,release;const called=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
 const f=await composed(t,{response:async request=>{if(pause&&request.action==='identity.current'){enter();await waiting;}return undefined;}});t.after(()=>release());
 pause=true;const response=f.http('afos/drafts/state',{},f.stamp());await called;f.window.abort();
 let timer;const refused=await Promise.race([response,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('revoked caller still waiting for Main')),1000);})]).finally(()=>clearTimeout(timer));
 assert.equal(refused.status,403);await refused.arrayBuffer();const writes=f.tables.runs.size;release();await new Promise(r=>setTimeout(r,50));assert.equal(f.tables.runs.size,writes);assert.equal(f.tables.artifacts.size,0);
});

test('actual original CLI owned follow method and output frame each retain private Main freshness',{timeout:20000},async t=>{
 const f=await composed(t),started=await f.unary('afos/drafts/start',{sources:[f.ref],goal:'Check original follow freshness.',operationId:'carrier-fresh-original-cli'});
 assert.equal(started.ok,true,JSON.stringify(started));
 let state;for(let n=0;n<50;n++){state=await f.unary('afos/drafts/state');if(state.value.drafts[0]?.execution==='completed_local')break;await new Promise(r=>setTimeout(r,10));}assert.equal(state.value.drafts[0].execution,'completed_local');
 const ws=await f.socket(f.stamp('/api/remote.mux','GET'));t.after(()=>ws.terminate());await new Promise(r=>setTimeout(r,50));
 const count=()=>f.wire.filter(frame=>frame.kind==='request'&&frame.method==='caller.assert').length,before=count(),messages=[];
 ws.on('message',raw=>messages.push(JSON.parse(raw)));
 ws.send(JSON.stringify({type:'open',streamId:'carrier-fresh',endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId:started.value.sessionId},assistantStream:true,maxMessages:500}}}}));
 for(let n=0;n<100&&!messages.length;n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(messages[0]?.value?.type,'snapshot');assert.ok(count()>=before+2,'method and output frame must reach real private caller.assert');
});

for (const endpoint of ['session/list', 'session/follow']) test('actual original CLI frame replacement refuses ' + endpoint + ' before a fresh enterprise query',{timeout:20000},async t=>{
 const f=await composed(t),started=await f.unary('afos/drafts/start',{sources:[f.ref],goal:'Keep owned history.',operationId:'carrier-frame-method'});
 assert.equal(started.ok,true,JSON.stringify(started));
 let state;for(let n=0;n<50;n++){state=await f.unary('afos/drafts/state');if(state.value.drafts[0]?.execution==='completed_local')break;await new Promise(r=>setTimeout(r,10));}
 const ws=await f.socket(f.stamp('/api/remote.mux','GET'));t.after(()=>ws.terminate());await new Promise(r=>setTimeout(r,50));
 const before=f.calls.length,messages=[];f.frame.url+='foreign-navigation';ws.on('message',raw=>messages.push(JSON.parse(raw)));
 const payload = endpoint === 'session/list' ? {args:{_request:{}}} : {args:{request:{address:{kind:'session',sessionId:started.value.sessionId},assistantStream:true,maxMessages:500}}};
 ws.send(JSON.stringify({type:'open',streamId:'carrier-frame-method',endpoint,payload}));
 for(let n=0;n<100&&!messages.length;n++)await new Promise(r=>setTimeout(r,5));
 assert.ok(messages.length,'original Gateway reports a refused native method');assert.equal(messages.some(x=>x.type==='item'),false);
 assert.equal(f.calls.length,before,'current Main frame proof fails before identity.current/owned read');assert.equal(f.tables.artifacts.size,0);
});

test('actual original CLI frame replacement between original follow frames blocks late content',{timeout:20000},async t=>{
 let entered,release;const called=new Promise(r=>entered=r),paused=new Promise(r=>release=r);
 const f=await composed(t,{model:async()=>{entered();await paused;return [{type:'block-start',index:0,blockType:'text'},
  {type:'text-delta',index:0,text:'must-not-escape-after-frame-change'},
  {type:'block-end',index:0,block:{type:'text',text:'must-not-escape-after-frame-change'}},{type:'finish',reason:{kind:'stop'}}];}});
 t.after(()=>release());
 const started=await f.unary('afos/drafts/start',{sources:[f.ref],goal:'Pause live original follow.',operationId:'carrier-frame-output'});assert.equal(started.ok,true,JSON.stringify(started));await called;
 const ws=await f.socket(f.stamp('/api/remote.mux','GET'));t.after(()=>ws.terminate());const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));
 ws.send(JSON.stringify({type:'open',streamId:'carrier-frame-output',endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId:started.value.sessionId},assistantStream:true,maxMessages:500}}}}));
 for(let n=0;n<100&&!messages.length;n++)await new Promise(r=>setTimeout(r,5));assert.equal(messages[0]?.value?.type,'snapshot');
 f.frame.url+='foreign-navigation';const before=messages.length;release();
 for(let n=0;n<200&&!messages.slice(before).some(x=>x.type==='error');n++)await new Promise(r=>setTimeout(r,5));
 console.log('AFOS_CLI_FRAME_OUTPUT '+JSON.stringify(messages.slice(before).map(x=>({type:x.type,valueType:x.value?.type,code:x.error?.code}))));
 assert.ok(messages.slice(before).some(x=>x.type==='error'),'original Gateway refuses the next original frame');
 assert.equal(messages.slice(before).some(x=>x.type==='item'),false);assert.equal(JSON.stringify(messages.slice(before)).includes('must-not-escape-after-frame-change'),false);
 assert.equal(f.tables.artifacts.size,0);
});
