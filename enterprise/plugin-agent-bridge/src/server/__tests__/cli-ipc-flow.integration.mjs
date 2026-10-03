import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile,symlink} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {fixture} from './desktop-fixture.mjs';
import {runtimeEnvironment} from '../../../../../dsh-plugin-desktop/src/runtime-security.ts';
import {attachMainBusinessIpc} from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/main-ipc.js';
import {MANAGED_CLI_SCOPE_KEYS,managedCliProfilePatch} from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/cli-profile.js';
const providerRoot=fileURLToPath(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/',import.meta.url));
const require=createRequire(join(providerRoot,'package.json'));
const cli=require.resolve('@deepseek-ai/dsh/lib/bin.js');
const policy={provider:'afos-managed',model:'fixed-model',maxTokens:64};
const reply=(name,args)=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:`call-${name}`,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:`call-${name}`,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
const done=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'Draft ready.'},{type:'block-end',index:0,block:{type:'text',text:'Draft ready.'}},{type:'finish',reason:{kind:'stop'}}];
async function composed(t,{core=false,failAck=false,dropAck=false,wake=false,model}={}){
 let child,channel,next,childClosed,modelCalls=0;const wire=[],observations=[];const leases={prepared:0,committed:0,disposed:0};
 const stop=async()=>{
  await channel?.close();channel=undefined;
  if(!child)return;const prior=child;child=undefined;
  if(prior.exitCode!==null||prior.signalCode!==null)return;
  const exited=once(prior,'exit');prior.kill('SIGTERM');const timer=setTimeout(()=>prior.kill('SIGKILL'),5000);timer.unref();
  try{await exited;}finally{clearTimeout(timer);}
 };
 const f=await fixture({stopHost:stop,model:async(request,signal)=>{
  modelCalls++;if(model)return model(request,signal);const refs=f.tables.runs.get(request.run.runId).inputs.map(({materialId,revisionId,hash})=>({materialId,revisionId,sha256:hash}));
  return(modelCalls-1)%3===0?reply('afos_read_snapshot',{materialId:refs[0].materialId,revisionId:refs[0].revisionId}):(modelCalls-1)%3===1?reply('afos_render_draft',{text:'Original CLI Main-owned durable draft.',sources:refs}):done;
 }});t.after(()=>f.cleanup());await f.ready();
 f.capability({ingressValidated:true,sandbox:'full'}); // Main/IdP fixture only, never the production carrier.
 const bootHost=async(signal,layout,_authority,business)=>{
  const home=join(layout.cache,'cli-'+Date.now()),profile=join(home,'profiles','afos-managed');await mkdir(profile,{recursive:true,mode:0o700});
  await writeFile(join(profile,'package.json'),JSON.stringify({name:'afos-test-profile',private:true,type:'module',dsh:{profile:{bundles:[]}}})+'\n',{mode:0o600,flag:'wx'});
  const isolated=Object.fromEntries(MANAGED_CLI_SCOPE_KEYS.map(key=>[key,true]));
  const rows=core?managedCliProfilePatch({root:layout.profile,binding:_authority.binding,model:policy,signal})[0].insert:[{id:'afos-private-cli',name:require.resolve('@deepseek-ai/cordis-plugin-group'),group:true,isolate:isolated,config:[
   {id:'afos-cli-bootstrap',name:pathToFileURL(join(providerRoot,'dist','cli-bootstrap.js')).href},
   {id:'afos-cli-identity',name:pathToFileURL(join(providerRoot,'dist','cli-ready.js')).href},
  ]}];
  rows[0].config.push({id:'afos-cli-read-fixture',name:pathToFileURL(join(providerRoot,'tests','fixtures',core?'cli-core-consumer.mjs':'cli-read-consumer.mjs')).href,config:{wakeBeforeAck:wake}});
  await writeFile(join(profile,'cordis.patch.yml'),JSON.stringify([{insert:rows}])+'\n',{mode:0o600,flag:'wx'});
  await symlink(join(providerRoot,'node_modules'),join(profile,'node_modules'),'dir');
  child=spawn(process.execPath,[cli,'--profile','afos-managed'],{cwd:home,env:{...runtimeEnvironment(process.env),DSH_HOME:home,DSH_AGENTS_HOME:join(home,'agents'),DSH_TELEMETRY_DISABLED:'1'},stdio:['pipe','pipe','pipe','ipc'],serialization:'json',windowsHide:true});
  const owned=child;childClosed=once(owned,'close');childClosed.catch(()=>undefined);let stdout='',stderr='';owned.stdout.on('data',v=>stdout+=v);owned.stderr.on('data',v=>stderr+=v);
  const received=[],waiting=[],lines=createInterface({input:owned.stdout});let readyResolve,readyReject;
  const appReady=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  lines.on('line',line=>{if(line==='AFOS_CLI_READY v1')readyResolve();
   if(line.startsWith('AFOS_OBSERVATION ')){const value=JSON.parse(line.slice(17));assert.deepEqual(Object.keys(value),['event','created','disposed','wakes','toolCalls','agents']);assert.ok(['ready','agent/created','agent/disposed','creation-wake','tool/call','process/exit'].includes(value.event));for(const name of ['created','disposed','wakes','toolCalls','agents'])assert.ok(Number.isSafeInteger(value[name])&&value[name]>=0&&value[name]<=100000);observations.push(value);console.log('AFOS_CLI_OBSERVATION '+JSON.stringify(value));return;}
   if(!line.startsWith('AFOS_RESULT '))return;const value=JSON.parse(line.slice(12));if(waiting.length)waiting.shift().resolve(value);else received.push(value);});
  const refuse=()=>{readyReject(Error('original-cli-not-ready'));for(const entry of waiting.splice(0))entry.reject(Error(`original CLI exited: ${stdout}\n${stderr}`));};owned.once('error',refuse);owned.once('exit',refuse);appReady.catch(()=>undefined);
  next=()=>received.length?Promise.resolve(received.shift()):new Promise((resolve,reject)=>waiting.push({resolve,reject}));
  const real={...business,prepareSessionBinding:async(...args)=>{const lease=await business.prepareSessionBinding(...args);leases.prepared++;return{commit(){if(failAck)throw Error('fixture-private-ack-error');lease.commit();leases.committed++;},dispose(){lease.dispose();leases.disposed++;}};}};
  const endpoint={send:message=>{wire.push(message);if(dropAck&&message.kind==='reply'&&message.method==='publication.ack'&&message.ok)return Promise.resolve();return new Promise((resolve,reject)=>owned.send(message,error=>error?reject(error):resolve()));},messages:listener=>{const accept=value=>{wire.push(value);listener(value);};owned.on('message',accept);return()=>owned.off('message',accept);},disconnected:listener=>{owned.on('disconnect',listener);return()=>owned.off('disconnect',listener);}};
  channel=await attachMainBusinessIpc(endpoint,real,signal,{root:layout.profile,model:policy});
  const value=await next();assert.equal(value.ready,true,JSON.stringify(value));assert.equal(value.originalLoader,true,JSON.stringify(value));assert.equal(value.rootPrivate,true,JSON.stringify(value));assert.equal(value.identity,_authority.binding.subject);assert.notEqual(value.pid,process.pid);assert.equal(value.ppid,process.pid);assert.equal(value.materials[0].materialId,'m1');
  if(core)await appReady;
  console.log('AFOS_CLI_EVIDENCE '+JSON.stringify({pid:value.pid,ppid:value.ppid,entryOwner:value.entryOwner,rootPrivate:value.rootPrivate,core:value.core??false}));
 };f.startHook(bootHost);
 await f.main.startHost();const command=(op,extra={})=>{child.stdin.write(JSON.stringify({op,...extra})+'\n');return next();};
 return{...f,wire,child:()=>child,channel:()=>channel,stop,bootHost,command,modelCalls:()=>modelCalls,observations:()=>observations.slice(),leases:()=>({...leases}),childClosed:()=>childClosed,
  invoke:async(method,payload)=>{const result=await command('invoke',{method,payload});assert.equal(result.error,undefined,JSON.stringify(result));return result.result;}};
}
test('Main → original official CLI → fixed private provider → awaited Identity → Main material read',{timeout:15000},async t=>{
 const f=await composed(t);assert.ok(f.wire.some(v=>v.kind==='request'&&v.method==='materials.list'));assert.ok(!JSON.stringify(f.wire).includes('fixture-access'));assert.ok(!JSON.stringify(f.wire).includes('fixture-refresh'));assert.equal(f.tables.artifacts.size,0);
});
test('original CLI mounts the reviewed original Core in the same private scope',{timeout:15000},async t=>{
 const f=await composed(t,{core:true});assert.ok(f.wire.some(v=>v.kind==='request'&&v.method==='materials.list'));assert.equal(f.tables.artifacts.size,0);
});
test('original CLI Core → original Agent/read/render/model → Main durable draft and acknowledged edit',{timeout:20000},async t=>{
 const f=await composed(t,{core:true});const payload={sources:[f.ref],goal:'Use original CLI Core and guarded Main business.',operationId:'cli-core-positive'};const started=await f.invoke('start',payload);assert.equal(started.ok,true,JSON.stringify(started));
 const idle=await f.command('idle',{sessionId:started.value.sessionId});assert.equal(idle.error,undefined,JSON.stringify(idle));assert.equal(idle.result.events.at(-1).data.reason.kind,'completed',JSON.stringify(idle));
 const state=await f.invoke('state',{});assert.equal(state.ok,true,JSON.stringify(state));const draft=state.value.drafts[0];assert.equal(draft.content,'Original CLI Main-owned durable draft.');assert.equal(draft.execution,'completed_local');assert.equal(f.modelCalls(),3);
 const edited=await f.invoke('edit',{draftId:draft.draftId,content:'Original CLI acknowledged edit.'});assert.equal(edited.ok,true,JSON.stringify(edited));assert.equal(f.business().drafts()[0].content,edited.value.content);assert.equal(f.tables.artifacts.size,0);
 assert.ok(!JSON.stringify(f.wire).includes('fixture-access'));assert.ok(!JSON.stringify(f.wire).includes('fixture-refresh'));
});
test('original CLI failed publication ACK rejects creation-listener wake before tools/model',{timeout:20000},async t=>{
 const f=await composed(t,{core:true,failAck:true,wake:true});const started=await f.invoke('start',{sources:[f.ref],goal:'No original tool/model before Main ACK.',operationId:'cli-failed-ack'});assert.equal(started.ok,false);assert.equal(f.modelCalls(),0);
 const stats=await f.command('stats');assert.equal(stats.result.wakes,1);assert.equal(stats.result.toolCalls,0);assert.equal(stats.result.agents,0);assert.equal(f.business().drafts().length,0);assert.ok(!JSON.stringify(f.wire).includes('fixture-private-ack-error'));
});
test('original CLI lost publication ACK remains unknown and releases reservation with zero tools/model',{timeout:20000},async t=>{
 const f=await composed(t,{core:true,dropAck:true,wake:true});const owned=f.child(),closed=f.childClosed();const started=await f.invoke('start',{sources:[f.ref],goal:'Lost Main ACK remains unknown.',operationId:'cli-lost-ack'});assert.equal(started.ok,false);assert.equal(started.error.code,'afos/profile-cancelled');assert.equal(f.modelCalls(),0);
 // Main's fresh-authority cutoff (at most 5s) disposes the reservation and the
 // original CLI exits. Read captured events and the original public registry
 // count recorded synchronously at Node exit, never postmortem services.
 const [code,signal]=await closed;assert.equal(code,1);assert.equal(signal,null);assert.equal(owned.exitCode,1);
 const observations=f.observations(),last=observations.at(-1);assert.ok(last,JSON.stringify(observations));assert.equal(last.wakes,1);assert.equal(last.toolCalls,0);assert.equal(last.created,1);assert.equal(last.event,'process/exit',JSON.stringify(observations));assert.ok(last.disposed<=last.created);assert.equal(last.agents,0);assert.equal(f.business().drafts().length,0);
 assert.ok(f.wire.some(v=>v.kind==='cutoff'));assert.equal(f.wire.filter(v=>v.kind==='request'&&v.method==='publication.renew').length,0);assert.deepEqual(f.leases(),{prepared:1,committed:1,disposed:1});
 const ack=f.wire.find(v=>v.kind==='reply'&&v.method==='publication.ack'&&v.ok);assert.ok(ack);assert.equal(f.wire.filter(v=>v.kind==='request'&&v.method==='publication.ack').length,1);
 await assert.rejects(f.business().sessionRun(ack.value.sessionId,new AbortController().signal));const runId=[...f.tables.runs.keys()][0];const admitted=await f.business().authorize([f.ref],'cli-after-lost-ack',new AbortController().signal);assert.notEqual(admitted.runId,runId);f.business().releaseRunAdmission(admitted.runId);assert.equal(f.tables.artifacts.size,0);
 console.log('AFOS_LOST_ACK_CUTOFF '+JSON.stringify({code,observations:last,leases:f.leases(),ackDelivered:false,oldSessionRejected:true,freshAdmissionReleased:true,modelCalls:f.modelCalls()}));
});
test('original CLI same-account restart and account switch cut off prior generations',{timeout:20000},async t=>{
 const f=await composed(t,{core:true});const prior=f.business(),old=f.child();await f.main.startHost();assert.equal(prior.hostSignal.aborted,true);assert.ok(old.exitCode!==null||old.signalCode!==null);assert.throws(()=>prior.drafts(),/host-changed/);
 const state=await f.invoke('state',{});assert.equal(state.ok,true,JSON.stringify(state));const current=f.business();await f.main.logout();assert.equal(current.hostSignal.aborted,true);f.principal('bob');await f.ready();await f.main.startHost();assert.equal((await f.command('stats')).result.identity,'bob');assert.equal((await f.invoke('state',{})).value.drafts.length,0);assert.ok(new Set(f.wire.filter(v=>v.kind==='welcome').map(v=>v.generation)).size>=3);
});
test('original CLI late predecessor reply fails closed without accepting its snapshot',{timeout:15000},async t=>{
 const f=await composed(t,{core:true}),oldFrame=f.wire.find(v=>v.kind==='reply'&&v.method==='authority.current');assert.ok(oldFrame);await f.main.startHost();const owned=f.child(),exited=once(owned,'exit');await new Promise((resolve,reject)=>owned.send(oldFrame,error=>error?reject(error):resolve()));const [code]=await exited;assert.equal(code,1);assert.equal(f.modelCalls(),0);assert.equal(f.business().drafts().length,0);assert.equal(f.tables.artifacts.size,0);
});
test('original CLI hard parent disconnect aborts the private bootstrap and exits',{timeout:15000},async t=>{
 const f=await composed(t,{core:true}),owned=f.child();const exited=once(owned,'exit');owned.disconnect();const [code]=await exited;assert.equal(code,1);assert.equal(f.tables.artifacts.size,0);
});
test('original CLI unknown finite method closes the private channel without Main business write',{timeout:15000},async t=>{
 const f=await composed(t,{core:true}),owned=f.child(),generation=f.wire.find(v=>v.kind==='welcome').generation;const exited=once(owned,'exit');
 owned.stdin.write(JSON.stringify({op:'unsafe-wire',frame:{contractVersion:'afos.main-ipc.v1',kind:'request',generation,callId:100,method:'executeShell',args:{}}})+'\n');const [code]=await exited;assert.equal(code,1);assert.equal(f.modelCalls(),0);assert.equal(f.tables.runs.size,0);assert.equal(f.tables.artifacts.size,0);
});
test('original CLI cancelled Agent projects original turn/end ACK before publication release',{timeout:20000},async t=>{
 const f=await composed(t,{core:true,model:async(_request,signal)=>(async function*(){await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));})()});
 const started=await f.invoke('start',{sources:[f.ref],goal:'Cancel actual original CLI execution.',operationId:'cli-cancel'});assert.equal(started.ok,true,JSON.stringify(started));for(let n=0;n<50&&f.modelCalls()===0;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.modelCalls(),1);
 const cancelled=await f.invoke('cancel',{draftId:started.value.draftId});assert.equal(cancelled.ok,true,JSON.stringify(cancelled));assert.equal(cancelled.value.execution,'interrupted');assert.equal(f.business().drafts()[0].localExecution,'interrupted');
 for(let n=0;n<50&&!f.wire.some(v=>v.kind==='request'&&v.method==='publication.release');n++)await new Promise(resolve=>setTimeout(resolve,10));
 const writes=f.wire.filter(v=>v.kind==='request'&&['session.cancel','session.project','publication.release'].includes(v.method)),cancelAt=writes.findIndex(v=>v.method==='session.cancel'),endAt=writes.findIndex(v=>v.method==='session.project'&&v.args.event.type==='turn/end'),releaseAt=writes.findIndex(v=>v.method==='publication.release');assert.ok(cancelAt>=0&&endAt>cancelAt&&releaseAt>endAt,JSON.stringify(writes));assert.equal(writes[cancelAt].args.stopped,false);assert.equal(f.tables.artifacts.size,0);
});
