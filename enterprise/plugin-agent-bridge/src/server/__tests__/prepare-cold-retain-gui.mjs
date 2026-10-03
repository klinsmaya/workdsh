import {execFileSync}from'node:child_process';import{createRequire}from'node:module';import{join,dirname,resolve}from'node:path';import{readFile,writeFile,unlink,symlink,cp,mkdir}from'node:fs/promises';import{createHash}from'node:crypto';
const [sourceArg,outputArg,reuseArg]=process.argv.slice(2);if(!sourceArg||!outputArg||process.argv.length<4||process.argv.length>5)throw Error('cold GUI paths required');const source=sourceArg,output=outputArg,desktop=join(source,'dsh-plugin-desktop');
if(reuseArg){
 await mkdir(output);await symlink(resolve(reuseArg,'app'),join(output,'app'));await cp(join(reuseArg,'runtime'),join(output,'runtime'),{recursive:true});await mkdir(join(output,'run'));
 await cp(join(reuseArg,'run/enterprise-preload.cjs'),join(output,'run/enterprise-preload.cjs'));await cp(join(reuseArg,'run/node_modules'),join(output,'run/node_modules'),{recursive:true});
 await writeFile(join(output,'REUSED_PREPARATION.json'),JSON.stringify({source,assets:resolve(reuseArg,'app'),runtimePackageLinks:resolve(reuseArg,'runtime'),scope:'unchanged original23 assets/official public package graph reused; provider slot below uses new own output'},null,2)+'\n');
}else execFileSync(process.execPath,[join(desktop,'scripts/prepare-enterprise-online-consumer.mjs'),source,output],{stdio:'inherit'});
const product=join(source,'workdsh-web/packages/providers/enterprise-profile'), observed=join(output,'observed-provider');
await cp(product,observed,{recursive:true,filter:path=>!path.includes('/node_modules')});await symlink(join(output,'runtime/node_modules'),join(observed,'node_modules'));
await unlink(join(output,'runtime/node_modules/workdsh-provider-enterprise-profile'));await symlink(observed,join(output,'runtime/node_modules/workdsh-provider-enterprise-profile'));
const observedModule=join(observed,'dist/native-read-catalog.js'),originalModule=await readFile(observedModule,'utf8');
const observation=`
// TEST ONLY: public lifecycle counter; all calls forward to the actual Controller.
const coldOriginal=EnterpriseNativeReadCatalog.prototype.coldFollow,observedOwners=new WeakSet();
EnterpriseNativeReadCatalog.prototype.coldFollow=function(...args){
 if(!observedOwners.has(this)){observedOwners.add(this);const owner=this.owner;let created=0;owner.on('agent/created',()=>{created++});
  const original=this.controller.follow.bind(this.controller);this.controller.follow=(...values)=>{const cold=this.isColdSession(values[0]),iterator=original(...values)[Symbol.asyncIterator]();let nexts=0,returned=0;return {
   next(){nexts++;return iterator.next()},async return(){returned++;try{return await iterator.return()}finally{console.log((cold?'AFOS_COLD_SOURCE ':'AFOS_LIVE_SOURCE ')+JSON.stringify({nexts,returned,agentsCreated:created,agents:owner.get('agents').list().length,sessions:owner.get('sessions').list().length}));}},[Symbol.asyncIterator](){return this}
  };};
 }return coldOriginal.apply(this,args);
};
`;
await writeFile(observedModule,originalModule+observation);await writeFile(join(output,'TEST_OBSERVER.json'),JSON.stringify({scope:'test-only public source/Agent counter over own fresh68 copied output; product dist unchanged',productModule:join(product,'dist/native-read-catalog.js'),originalSHA:createHash('sha256').update(originalModule).digest('hex'),observerSHA:createHash('sha256').update(observation).digest('hex')},null,2)+'\n');

const ipcObserved=join(observed,'dist/main-ipc.js'),ipcOriginal=await readFile(ipcObserved,'utf8');
if(ipcOriginal.split('export async function attachMainBusinessIpc(').length!==2)throw Error('IPC export drift');
const ipcObservation=`
export async function attachMainBusinessIpc(endpoint,...args){
 const stats={acks:0,renews:0,renewReplies:0,sameTicket:true,ttlBounded:true,allOK:true},pending=new Map();let ticket;
 (globalThis.__AFOS_PUBLICATION_OBSERVER__??=[]).push(stats);
 const wrapped={...endpoint,messages(listener){return endpoint.messages(message=>{if(message.kind==='request'&&['publication.ack','publication.renew'].includes(message.method)){if(message.method==='publication.ack'){stats.acks++;ticket=message.args.ticket;}else{stats.renews++;stats.sameTicket&&=message.args.ticket===ticket;pending.set(message.callId,true);}}listener(message);});},async send(message){const result=await endpoint.send(message);if(message.kind==='reply'&&pending.has(message.callId)){pending.delete(message.callId);stats.renewReplies++;stats.allOK&&=message.ok===true;const ttl=Date.parse(message.value?.expiresAt)-Date.now();stats.ttlBounded&&=Number.isFinite(ttl)&&ttl>0&&ttl<=60000;}return result;}};
 return attachMainBusinessIpcOriginal(wrapped,...args);
}
`;
await writeFile(ipcObserved,ipcOriginal.replace('export async function attachMainBusinessIpc(','async function attachMainBusinessIpcOriginal(')+ipcObservation);
await writeFile(join(output,'TEST_IPC_OBSERVER.json'),JSON.stringify({scope:'test-only passive private Endpoint publication metrics; exact original actions forwarded; tickets never persisted',originalSHA:createHash('sha256').update(ipcOriginal).digest('hex'),observerSHA:createHash('sha256').update(ipcObservation).digest('hex')},null,2)+'\n');
const entry=join(desktop,'scripts/enterprise-online-consumer.fixture.mts');let contents=await readFile(entry,'utf8');contents=contents.replace("assert.equal(coldList.ok,false);","assert.equal(coldList.ok,true);assert.deepEqual(coldList.value.items,[]);").replace('coldListRefused:true','coldListEmptyReadonly:true');
const modelFrom="model:async()=>{modelCalls++;return modelCalls===1?";
if(contents.split(modelFrom).length!==2)throw Error('original model fixture drift');
contents=contents.replace(modelFrom,"model:async(_request,modelSignal)=>{modelCalls++;if(modelCalls===4&&process.env.AFOS_COLD_ACTIVE_MIX==='1')return (async function*(){yield {type:'block-start',index:0,blockType:'text'};for(let n=0;n<33;n++){await delay(2000,undefined,{signal:modelSignal});yield {type:'text-delta',index:0,text:'.'};}yield {type:'block-end',index:0,block:{type:'text',text:'.'.repeat(33)}};yield {type:'finish',reason:{kind:'stop'}};})();return modelCalls===1?");
contents="import { setTimeout as delay } from 'node:timers/promises';\n"+contents;
const cut=contents.indexOf(' const seam=');if(cut<0)throw Error('original seam marker missing');contents=contents.slice(0,cut)+`
 const binding=(await f.business().currentAuthority(new AbortController().signal)).binding,modelsBefore=modelCalls;
 await f.reopenMain(binding);await f.main.startHost();
 await until('!!window.__AFOS_ONLINE_OBSERVER__?.connection.generation.getSnapshot()','new original cold SDK ready');
 const cold=await unary('session/list',{args:{_request:{}}});assert.equal(cold.ok,true);assert.equal(cold.value.items.length,1);assert.equal(cold.value.items[0].sessionId,started.value.sessionId);assert.equal(cold.value.items[0].agentAvailable,false);
 const sdk=await ui(\`(async()=>{const ctx=window.__AFOS_ONLINE_OBSERVER__;await ctx.sessions.refresh();const reference=ctx.sessions.retain(\${JSON.stringify(started.value.sessionId)},{source:'gateway'});await reference.ready;window.__AFOS_COLD_REFERENCE__=reference;window.__AFOS_COLD_GENERATION__=ctx.connection.generation.getSnapshot();window.__AFOS_COLD_WINDOW__=JSON.stringify({entries:reference.binding.eventSource.getSnapshot().entries,hasMore:reference.binding.eventSource.getSnapshot().hasMore});const binding=reference.binding;return {snapshot:binding.session.getSnapshot(),window:binding.eventSource.getSnapshot()};})()\`);
 assert.equal(sdk.snapshot.openState,'open');assert.ok(JSON.stringify(sdk.window).includes('Use original online Conversation.'));assert.equal(modelCalls,modelsBefore);
 results.push({case:'original-sdk-cold-retain-public-snapshot',pass:true,openState:sdk.snapshot.openState,actualPersistedHistory:true,additionalModels:0});
 await ui(\`window.__AFOS_ONLINE_OBSERVER__.uiWorkspace.openSession(\${JSON.stringify(started.value.sessionId)});window.__AFOS_ONLINE_OBSERVER__.layout.selectPanel(null)\`);
 await until("document.body.innerText.includes('Use original online Conversation.')",'original cold Conversation persisted user message');
 const conversation=await ui("({text:document.body.innerText,ownDraftForm:!!document.querySelector('#afos-draft-goal'),originalModules:window.__DSH_BOOT__.entries.filter(x=>x.id!=='afos-online-test-observer').length})");
 assert.equal(conversation.ownDraftForm,false);assert.equal(conversation.originalModules,23);assert.equal(modelCalls,modelsBefore);assert.equal(f.tables.runs.size,1);
 results.push({case:'original23-cold-sdk-retain-conversation-public-snapshot-experiment',pass:true,coldListAgentAvailable:false,openState:sdk.snapshot.openState,additionalModels:0,oneOriginalRun:true,conversation,scope:'actual new product original public first-return adapter; engineering component only, not AT'});
 let active:any;
 if(process.env.AFOS_COLD_ACTIVE_MIX==='1'){
  active=await unary('afos/drafts/start',{sources:[f.ref],goal:'Same-peer active Run survives cold history carrier expiry.',operationId:'cold-active-same-peer'});assert.equal(active.ok,true);
  await ui(\`(async()=>{await window.__AFOS_ONLINE_OBSERVER__.sessions.refresh();const reference=window.__AFOS_ONLINE_OBSERVER__.sessions.retain(\${JSON.stringify(active.value.sessionId)},{source:'gateway'});await reference.ready;window.__AFOS_ACTIVE_REFERENCE__=reference;})()\`);
  const enteredDeadline=Date.now()+5000;while(modelCalls<4&&Date.now()<enteredDeadline)await new Promise(r=>setTimeout(r,20));assert.equal(modelCalls,4);
 }
 const ownedMux=()=>networkFacts.filter(x=>x.path==='/api/remote.mux'&&x.witness&&x.frameTop).length,muxBefore=ownedMux(),longStart=Date.now();
 await new Promise(r=>setTimeout(r,process.env.AFOS_COLD_DIAGNOSTIC==='1'?12000:65000));
 const diagnostic=await ui("(()=>{const reference=window.__AFOS_COLD_REFERENCE__,binding=reference?.binding,snapshot=binding?.session.getSnapshot();return {binding:!!binding,snapshot,window:binding?.eventSource.getSnapshot(),error:snapshot?.openError?{name:snapshot.openError.name,message:snapshot.openError.message,code:snapshot.openError.code,stack:snapshot.openError.stack}:undefined,body:document.body.innerText}})()");bootstrapFacts.push({coldDiagnostic:diagnostic});
 await until("!!window.__AFOS_COLD_REFERENCE__?.binding&&window.__AFOS_COLD_REFERENCE__.binding.session.getSnapshot().openState==='open'",'original retained cold Conversation open after60s');
 const retained=await ui("({snapshot:window.__AFOS_COLD_REFERENCE__.binding.session.getSnapshot(),sameHistory:JSON.stringify({entries:window.__AFOS_COLD_REFERENCE__.binding.eventSource.getSnapshot().entries,hasMore:window.__AFOS_COLD_REFERENCE__.binding.eventSource.getSnapshot().hasMore})===window.__AFOS_COLD_WINDOW__,durableSeqs:window.__AFOS_COLD_REFERENCE__.binding.eventSource.getSnapshot().entries.filter(x=>x.type==='event').map(x=>x.event.seq),freshGeneration:window.__AFOS_ONLINE_OBSERVER__.connection.generation.getSnapshot()!==window.__AFOS_COLD_GENERATION__,goalVisible:document.body.innerText.includes('Use original online Conversation.'),ownDraftForm:!!document.querySelector('#afos-draft-goal')})");
 assert.equal(retained.snapshot.openState,'open');assert.equal(retained.sameHistory,true);assert.equal(new Set(retained.durableSeqs).size,retained.durableSeqs.length);assert.equal(retained.freshGeneration,true);assert.equal(retained.goalVisible,true);assert.equal(retained.ownDraftForm,false);assert.ok(ownedMux()>muxBefore);assert.equal(modelCalls,modelsBefore+(active?1:0));assert.equal(f.tables.runs.size,active?2:1);
 const metrics=consoleFacts.flatMap(x=>typeof x.cli==='string'?x.cli.split('\\n').filter(line=>line.includes('AFOS_COLD_SOURCE ')).map(line=>JSON.parse(line.slice(line.indexOf('AFOS_COLD_SOURCE ')+17))):[]);
 assert.ok(metrics.length>=2);for(const metric of metrics){assert.equal(metric.nexts,1);assert.equal(metric.returned,1);assert.equal(metric.agentsCreated,active?Math.min(1,metric.agentsCreated):0);assert.equal(metric.agents,active?Math.min(1,metric.agents):0);assert.equal(metric.sessions,active?Math.min(1,metric.sessions):0);}
 results.push({case:'original23-cold-retained-conversation65s-fresh-sdk',pass:true,elapsedMs:Date.now()-longStart,callerTTLUnchanged:60000,muxBefore,muxAfter:ownedMux(),retained,metrics,oneOriginalRun:!active,oldPersistedRuns:1,activeRuns:active?1:0,additionalColdModels:0});
 if(active){
  let state;const completedDeadline=Date.now()+12000;do{state=await unary('afos/drafts/state');if(state.ok&&state.value.drafts.find(x=>x.sessionId===active.value.sessionId)?.execution==='completed_local')break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<completedDeadline);
  assert.equal(state.ok,true);assert.equal(state.value.drafts.find(x=>x.sessionId===active.value.sessionId).execution,'completed_local');
  const publications=(globalThis as any).__AFOS_PUBLICATION_OBSERVER__;assert.ok(publications?.length===2);const current=publications[1];assert.equal(current.acks,1);assert.ok(current.renews>=26);assert.equal(current.renewReplies,current.renews);assert.equal(current.sameTicket,true);assert.equal(current.ttlBounded,true);assert.equal(current.allOK,true);assert.equal(modelCalls,4);assert.equal(f.tables.runs.size,2);
  const healthy=await ui("(()=>{const ctx=window.__AFOS_ONLINE_OBSERVER__;return {workspace:ctx.get('workspaces').list.getSnapshot(),sessions:ctx.sessions.list.getSnapshot(),activeSnapshot:window.__AFOS_ACTIVE_REFERENCE__.binding.session.getSnapshot()}})()");assert.equal(healthy.workspace.phase,'ready');assert.equal(healthy.workspace.error,null);assert.equal(healthy.sessions.phase,'ready');assert.ok(healthy.sessions.ids.includes(active.value.sessionId));
  assert.equal(healthy.activeSnapshot.openState,'open');assert.equal(healthy.activeSnapshot.openError,null);
  results.push({case:'same-peer-cold-retain-and-active-original-run26renew',pass:true,publications,healthy,liveFollowOpen:true,oldPersistedRun:1,oneActiveRun:true,additionalColdAgent:0,additionalColdModels:0});
  await ui('window.__AFOS_ACTIVE_REFERENCE__.release();delete window.__AFOS_ACTIVE_REFERENCE__');
 }
 await ui('window.__AFOS_COLD_REFERENCE__.release();delete window.__AFOS_COLD_REFERENCE__');
 face.window.destroy();face=undefined;await f.cleanup();f=undefined;
 const sink=JSON.stringify({results,networkFacts,consoleFacts,bootstrapFacts});for(const secret of secrets)assert.equal(sink.includes(secret),false);
 await writeFile(join(output,'result.json'),JSON.stringify({results,networkFacts,consoleFacts,bootstrapFacts,secretCheck:{valuesChecked:secrets.size,noValuesInSink:true,valuesPersisted:false}},null,2)+'\\n');clearTimeout(timer);app.exit(0);
 }catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,networkFacts,consoleFacts,bootstrapFacts,ownerFacts:face?.online.ownerFacts()},null,2)+'\\n').catch(()=>{});console.error(error);face?.window.destroy();await f?.cleanup().catch(()=>{});clearTimeout(timer);app.exit(1);}})();
`;
const {build}=createRequire(join(source,'workdsh-web/packages/plugins/enterprise-drafts/package.json'))('esbuild');
await build({entryPoints:[entry],outfile:join(output,'run/main.mjs'),bundle:true,format:'esm',platform:'node',target:'node24',external:['electron'],packages:'external',sourcemap:true,
plugins:[{name:'actual-product-cold-conversation-with-original-sdk',setup(builder){
builder.onLoad({filter:/enterprise-online-consumer\.fixture\.mts$/},()=>({contents,loader:'ts',resolveDir:dirname(entry)}));
builder.onLoad({filter:/desktop-fixture\.mjs$/},async args=>{let value=await readFile(args.path,'utf8');value=value.replace('const main=new EnterpriseMainSession','let main=new EnterpriseMainSession').replace('return {main,base,config,tables',`return {get main(){return main;},reopenMain:async(binding)=>{await main.suspend();main=new EnterpriseMainSession(config,base,vault,host,browser,fetcher);return main.restoreAccount(binding,project.id);},base,config,tables`);return{contents:value,loader:'js',resolveDir:dirname(args.path)};});}}]});
await writeFile(join(output,'gui-probe-transformed.mts'),contents);console.log(JSON.stringify({output,observedOwnProvider:observed,publicFirstReturn:true,original23:true}));
