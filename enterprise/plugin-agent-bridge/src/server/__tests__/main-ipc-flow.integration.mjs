import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fixture } from './desktop-fixture.mjs';
import { attachMainBusinessIpc } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/main-ipc.js';
const policy={provider:'afos-managed',model:'fixed-model',maxTokens:64};
const reply=(name,args)=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:`call-${name}`,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:`call-${name}`,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
const done=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'Draft ready.'},{type:'block-end',index:0,block:{type:'text',text:'Draft ready.'}},{type:'finish',reason:{kind:'stop'}}];
async function composed(t,{failAck=false,wake=false,dropAck=false,model}={}){
 let child,channel,modelCalls=0,sequence=0;const wire=[];let stdout='',stderr='';
 const stop=async()=>{if(channel){await channel.close();channel=undefined;}if(child){const old=child;child=undefined;old.kill();if(old.exitCode===null&&old.signalCode===null)await once(old,'exit');}};
 const f=await fixture({stopHost:stop,model:async(request,signal)=>{modelCalls++;if(model)return model(request,signal);const refs=f.tables.runs.get(request.run.runId).inputs.map(({materialId,revisionId,hash})=>({materialId,revisionId,sha256:hash}));return (modelCalls-1)%3===0?reply('afos_read_snapshot',{materialId:refs[0].materialId,revisionId:refs[0].revisionId}):(modelCalls-1)%3===1?reply('afos_render_draft',{text:'Main-owned IPC durable draft.',sources:refs}):done;}});
 await f.ready();f.capability({ingressValidated:true,sandbox:'full'});
 let next;
 const bootHost=async(signal,layout,_authority,business)=>{
  child=fork(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/tests/fixtures/main-ipc-core-child.mjs',import.meta.url),wake?['--wake-before-ack']:[],{stdio:['pipe','pipe','pipe','ipc'],serialization:'json',env:{PATH:process.env.PATH},execArgv:[]});
  const received=[],waiting=[],lines=createInterface({input:child.stdout});child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
  lines.on('line',line=>{if(!line.startsWith('AFOS_RESULT '))return;const value=JSON.parse(line.slice(12));if(waiting.length)waiting.shift()(value);else received.push(value);});
  next=()=>received.length?Promise.resolve(received.shift()):new Promise(resolve=>waiting.push(resolve));
  const real=failAck?{...business,prepareSessionBinding:async(...args)=>{const lease=await business.prepareSessionBinding(...args);return{commit(){throw new Error('fixture-main-private-secret-ack-fail');},dispose:lease.dispose};}}:business;
  const endpoint={send:message=>{wire.push(message);if(dropAck&&message.kind==='reply'&&message.method==='publication.ack'&&message.ok)return Promise.resolve();return new Promise((resolve,reject)=>child.send(message,error=>error?reject(error):resolve()));},messages:listener=>{const wrapper=value=>{wire.push(value);listener(value);};child.on('message',wrapper);return()=>child?.off('message',wrapper);},disconnected:listener=>{child.on('disconnect',listener);return()=>child?.off('disconnect',listener);}};
  channel=await attachMainBusinessIpc(endpoint,real,signal,{root:layout.profile,model:policy});
  const ready=await Promise.race([next(),once(child,'exit').then(([code])=>{throw new Error(`child exit ${code}: ${stdout}\n${stderr}`);})]);assert.equal(ready.ready,true);assert.notEqual(ready.pid,process.pid);
 };f.startHook(bootHost);
 t.after(async()=>{await f.cleanup();});await f.main.startHost();
 const command=(op,extra={})=>{child.stdin.write(JSON.stringify({op,...extra})+'\n');return next();};
 return {...f,wire,bootHost,modelCalls:()=>modelCalls,command,invoke:async(method,payload)=>{const r=await command('invoke',{method,payload});assert.equal(r.error,undefined,JSON.stringify(r));return r.result;},stop};
}
test('real Node Main → public Loader → original Agent/tools/model → durable Main Recovery and acknowledged edit',{timeout:20000},async t=>{
 const f=await composed(t);const started=await f.invoke('start',{sources:[f.ref],goal:'Generate with original Core and Main-owned material.',operationId:'ipc-core-positive'});assert.equal(started.ok,true,JSON.stringify(started));
 const idle=await f.command('idle',{sessionId:started.value.sessionId});assert.equal(idle.error,undefined,JSON.stringify(idle));assert.equal(idle.result.events.at(-1).data.reason.kind,'completed',JSON.stringify(idle));
 const state=await f.invoke('state',{});assert.equal(state.ok,true,JSON.stringify(state));const draft=state.value.drafts[0];assert.equal(draft.content,'Main-owned IPC durable draft.');assert.equal(draft.execution,'completed_local');assert.equal(f.modelCalls(),3);const late=await f.command('late-cancel',{sessionId:draft.sessionId});assert.equal(late.result.execution,'completed_local');
 const edit=await f.invoke('edit',{draftId:draft.draftId,content:'Human-reviewed immutable mirror ACK.'});assert.equal(edit.ok,true,JSON.stringify(edit));assert.equal(edit.value.content,'Human-reviewed immutable mirror ACK.');assert.equal(f.business().drafts()[0].content,edit.value.content);assert.equal(f.tables.artifacts.size,0);
 const wire=JSON.stringify(f.wire);assert.ok(!wire.includes('fixture-access'));assert.ok(!wire.includes('fixture-refresh'));assert.equal(f.wire.filter(v=>v.method==='publication.ack'&&v.kind==='request').length,1);
});
test('real Core failed Main ACK refuses Runtime start with creation-listener wake and zero model/tool action',{timeout:20000},async t=>{
 const f=await composed(t,{failAck:true,wake:true});const started=await f.invoke('start',{sources:[f.ref],goal:'Must refuse before any model or tool execution.',operationId:'ipc-core-failed-ack'});assert.equal(started.ok,false);assert.equal(f.modelCalls(),0);const stats=await f.command('stats');assert.equal(stats.result.wakes,1);assert.equal(stats.result.toolCalls,0);assert.equal(stats.result.agents,0);assert.equal(f.business().drafts().length,0);assert.ok(!JSON.stringify(f.wire).includes('fixture-main-private-secret-ack-fail'));
});

test('real Core cancellation awaits original turn/end Main ACK and conservatively records interrupted',{timeout:20000},async t=>{
 const f=await composed(t,{model:async(_request,signal)=>(async function*(){await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));})()});
 const started=await f.invoke('start',{sources:[f.ref],goal:'Cancel original execution without claiming process stop.',operationId:'ipc-core-cancel'});assert.equal(started.ok,true,JSON.stringify(started));
 for(let n=0;n<50&&f.modelCalls()===0;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.modelCalls(),1);
 const cancelled=await f.invoke('cancel',{draftId:started.value.draftId});assert.equal(cancelled.ok,true,JSON.stringify(cancelled));assert.equal(cancelled.value.execution,'interrupted');assert.equal(f.business().drafts()[0].localExecution,'interrupted');assert.equal(f.tables.artifacts.size,0);
 const writes=f.wire.filter(v=>v.kind==='request'&&['session.project','session.cancel','publication.release'].includes(v.method));const cancelAt=writes.findIndex(v=>v.method==='session.cancel');const endAt=writes.findIndex(v=>v.method==='session.project'&&v.args.event.type==='turn/end');const releaseAt=writes.findIndex(v=>v.method==='publication.release');assert.ok(cancelAt>=0&&endAt>cancelAt&&releaseAt>endAt,JSON.stringify(writes));assert.equal(writes.find(v=>v.method==='session.cancel').args.stopped,false);
});
test('same-account real Host restart and subsequent account switch invalidate prior private channels',{timeout:20000},async t=>{
 const f=await composed(t);const started=await f.invoke('start',{sources:[f.ref],goal:'First real Host run.',operationId:'ipc-core-host-first'});assert.equal(started.ok,true,JSON.stringify(started));await f.command('idle',{sessionId:started.value.sessionId});const old=f.business(),oldSignal=old.hostSignal;
 await f.main.startHost();assert.equal(oldSignal.aborted,true);assert.throws(()=>old.drafts(),/host-changed/);const state=await f.invoke('state',{});assert.equal(state.ok,true,JSON.stringify(state));assert.equal(state.value.drafts.length,1);
 const next=await f.invoke('start',{sources:[f.ref],goal:'Independent restarted Host original run.',operationId:'ipc-core-host-second'});assert.equal(next.ok,true,JSON.stringify(next));await f.command('idle',{sessionId:next.value.sessionId});
 const prior=f.business();await f.main.logout();assert.equal(prior.hostSignal.aborted,true);f.principal('bob');await f.ready();await f.main.startHost();const switched=await f.invoke('state',{});assert.equal(switched.ok,true,JSON.stringify(switched));assert.equal(switched.value.drafts.length,0);assert.equal(f.tables.artifacts.size,0);
});

test('lost real Main publication ACK stays unknown with no tool/model work and releases original reservation',{timeout:20000},async t=>{
 const f=await composed(t,{dropAck:true,wake:true});const result=await f.invoke('start',{sources:[f.ref],goal:'No action before delivered Main ACK.',operationId:'ipc-core-lost-ack'});assert.equal(result.ok,false);assert.equal(f.modelCalls(),0);assert.equal((await f.command('stats')).result.toolCalls,0);assert.equal(f.business().drafts().length,0);assert.ok(f.wire.some(v=>v.kind==='request'&&v.method==='publication.release'));
 const runId=[...f.tables.runs.keys()][0];await assert.rejects(f.business().sessionRun('not-published',new AbortController().signal));const admitted=await f.business().authorize([f.ref],'ipc-after-lost-ack',new AbortController().signal);assert.notEqual(admitted.runId,runId);f.business().releaseRunAdmission(admitted.runId);assert.equal(f.tables.artifacts.size,0);
});
test('failed real child Core startup cuts off new and prior generations and permits independent later start',{timeout:20000},async t=>{
 const f=await composed(t);const old=f.business();let failed;
 f.startHook(async(...args)=>{failed=args[3];await f.bootHost(...args);throw new Error('fixture-child-start-failed');});await assert.rejects(f.main.startHost(),/fixture-child-start-failed/);assert.equal(old.hostSignal.aborted,true);assert.equal(failed.hostSignal.aborted,true);assert.throws(()=>failed.drafts(),/host-changed/);
 f.startHook(f.bootHost);await f.main.startHost();const next=await f.invoke('start',{sources:[f.ref],goal:'New child after failed predecessor.',operationId:'ipc-after-failed-start'});assert.equal(next.ok,true,JSON.stringify(next));await f.command('idle',{sessionId:next.value.sessionId});assert.equal(f.tables.artifacts.size,0);assert.ok(new Set(f.wire.filter(v=>v.kind==='welcome').map(v=>v.generation)).size>=3);
});
