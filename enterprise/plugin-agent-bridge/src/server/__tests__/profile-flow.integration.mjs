import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { readdir } from 'node:fs/promises';
import { fixture } from './desktop-fixture.mjs';
import { bootEnterpriseCore } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/assembly.js';

// Actual official Loader/Session/AgentLoop/tools/model adapter plus real Main/Broker/
// Recovery/Core. Identity, ACL repository and provider replies are fixtures; no AT PASS.
const policy={provider:'afos-managed',model:'fixed-model',maxTokens:64};
const reply=(name,args)=>[
  {type:'block-start',index:0,blockType:'tool-call'},
  {type:'tool-call-delta',index:0,id:`call-${name}`,name,argumentsDelta:JSON.stringify(args)},
  {type:'block-end',index:0,block:{type:'tool-call',id:`call-${name}`,name,arguments:JSON.stringify(args)}},
  {type:'finish',reason:{kind:'tool-calls'}},
];
const done=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'The local draft awaits human review.'},
  {type:'block-end',index:0,block:{type:'text',text:'The local draft awaits human review.'}},{type:'finish',reason:{kind:'stop'}}];
async function composed(options={}){
  let ctx,profileRoot,modelCalls=0;const requests=[];
  const f=await fixture({stopHost:async()=>{if(ctx){const old=ctx;ctx=undefined;await old.fiber.dispose();}},
    model:async(request,signal)=>{requests.push(request);signal.throwIfAborted();modelCalls++;
      if(options.model)return options.model(request,signal);
      const run=f.tables.runs.get(request.run.runId),refs=run.inputs.map(({materialId,revisionId,hash})=>({materialId,revisionId,sha256:hash})),ref=refs[0];
      const phase=(modelCalls-1)%3;
      return phase===0?reply('afos_read_snapshot',{materialId:ref.materialId,revisionId:ref.revisionId}):
        phase===1?reply('afos_render_draft',{text:'Draft based on Server source; pending human review.',sources:refs}):done;
    }});
  await f.ready();f.capability({ingressValidated:true,sandbox:'full'});
  f.startHook(async(signal,layout,authority,business)=>{profileRoot=layout.profile;ctx=await bootEnterpriseCore({root:layout.profile,binding:authority.binding,projectId:authority.project.id,business,model:policy,signal});});
  await f.main.startHost();
  const invoke=(method,payload={})=>ctx.afosDraftRuntime.invoke(`afos/drafts/${method}`,payload,new AbortController().signal);
  return {...f,ctx:()=>ctx,profileRoot:()=>profileRoot,requests,modelCalls:()=>modelCalls,invoke};
}

test('AFOS-CHECK-P01 real Loader and official tool loop produce durable draft, human edit and receipt',async()=>{
  const f=await composed();try{
    const state=await f.invoke('state');assert.equal(state.ok,true);assert.equal(state.value.drafts.length,0);
    const materials=await f.invoke('materials');assert.equal(materials.ok,true);assert.equal(materials.value[0].sha256,f.ref.sha256);
    const started=await f.invoke('start',{sources:[f.ref],goal:'Summarize the evidence with gaps.',operationId:'official-loop-one'});
    assert.equal(started.ok,true,JSON.stringify(started));
    const id=started.value.sessionId,agent=f.ctx().agents.get(id);assert.ok(agent);
    await agent.whenIdle();
    const events=agent.session.snapshotEvents();
    assert.equal(events.at(-1).type,'turn/end');assert.equal(events.at(-1).data.reason.kind,'completed',JSON.stringify({events,calls:f.calls,modelCalls:f.modelCalls()}));
    assert.equal(events.filter(e=>e.type==='tool/result').length,2,JSON.stringify(events.map(e=>e.type)));
    const generated=(await f.invoke('state')).value.drafts[0];
    assert.equal(generated.content,'Draft based on Server source; pending human review.');assert.equal(generated.execution,'completed_local');
    assert.equal(generated.archive,'local-only');assert.equal(f.tables.artifacts.size,0);
    assert.equal(f.modelCalls(),3);
    for(const request of f.requests){assert.equal(request.run.runId,generated.runId);assert.equal(request.request.maxTokens,64);assert.deepEqual(request.request.tools.map(t=>t.name).sort(),['afos_read_snapshot','afos_render_draft']);assert.equal(JSON.stringify(request).includes('fixture-access'),false);}
    const edit=await f.invoke('edit',{draftId:generated.draftId,content:'Reviewed local draft.'});assert.equal(edit.ok,true);assert.equal(edit.value.content,'Reviewed local draft.');
    assert.equal((await f.invoke('archive',{draftId:generated.draftId,expectedSha256:generated.sha256})).ok,false);
    assert.equal(f.tables.artifacts.size,0);
    const archive=await f.invoke('archive',{draftId:generated.draftId,expectedSha256:edit.value.sha256});assert.equal(archive.ok,true,JSON.stringify(archive));assert.equal(archive.value.archive,'receipt-recorded');assert.ok(archive.value.receipt.receiptId);assert.equal(f.tables.artifacts.size,1);
    assert.equal((await f.invoke('archive',{draftId:generated.draftId,expectedSha256:edit.value.sha256})).value.receipt.receiptId,archive.value.receipt.receiptId);
    assert.equal((await f.invoke('start',{sources:[f.ref],goal:'Another independent local draft.',operationId:'official-loop-two'})).ok,true);
    await f.ctx().agents.list().at(-1).whenIdle();assert.equal(f.tables.runs.size,2);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-P02 fixed public Connection rejects raw HTTP, RPC and actual WS upgrade',async()=>{
  const f=await composed();try{
    const ctx=f.ctx(),base=`http://127.0.0.1:${ctx.webServer.port}`;
    assert.equal(ctx.get('typertGateway'),undefined);assert.equal(ctx.get('fs'),undefined);assert.equal(ctx.get('mcp'),undefined);
    const release=ctx.webServer.register({kind:'exact',path:'/',handler(req,res){if(ctx.connection.authorizeIndex(req,res)){res.writeHead(200);res.end('test auth entry');}}});
    const login=await fetch(ctx.connection.authenticatedUrl(base+'/'),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
    for(const endpoint of ['/api/files/read','/api/pluginManager/install','/api/session/create','/files']){
      const result=await fetch(base+endpoint,{headers:{cookie},redirect:'manual'});assert.equal(result.status,404);
    }
    const fixed=await fetch(base+'/api/afos/drafts/state',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'probe',method:'afos/drafts/state',payload:{}})});
    assert.equal(fixed.status,200);assert.equal((await fixed.json()).result.ok,true);
    const upgrade=await new Promise((resolve,reject)=>{
      const socket=connect({host:'127.0.0.1',port:ctx.webServer.port});let bytes=0;
      const timer=setTimeout(()=>{socket.destroy();reject(Error('unapproved upgrade did not close'));},2000);
      socket.once('connect',()=>socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:${ctx.webServer.port}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: YWZvcy1maXhlZC1wcm9iZQ==\r\n\r\n`));
      socket.on('data',data=>{bytes+=data.length;});socket.on('error',reject);socket.once('close',()=>{clearTimeout(timer);resolve({closed:true,bytes});});
    });assert.deepEqual(upgrade,{closed:true,bytes:0});
    const extra=await f.invoke('start',{sources:[f.ref],goal:'Goal',operationId:'one',actor:'admin'});assert.equal(extra.ok,false);assert.equal(f.tables.runs.size,0);
    const denied=await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(base+'/api/llm/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'bad',method:'llm/generate',payload:{}})}));
    assert.equal((await denied.json()).result.ok,false);
    release();
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-P03 actual streaming Agent cancellation settles without a server artifact',async()=>{
  let entered;const begun=new Promise(resolve=>{entered=resolve;});
  const f=await composed({model:(_request,signal)=>(async function*(){
    yield {type:'block-start',index:0,blockType:'text'};entered();
    await new Promise((resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  })()});try{
    const started=await f.invoke('start',{sources:[f.ref],goal:'Create a cancellable draft.',operationId:'cancel-one'});assert.equal(started.ok,true);
    await begun;
    const cancelled=await f.invoke('cancel',{draftId:started.value.draftId});assert.equal(cancelled.ok,true,JSON.stringify(cancelled));
    assert.equal(cancelled.value.execution,'cancelled');assert.equal(cancelled.value.archive,'local-only');assert.equal(f.tables.artifacts.size,0);
    assert.equal(f.ctx().agents.get(started.value.sessionId).session.snapshotEvents().at(-1).type,'turn/end');
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-P04 current server Run and pins gate local tools; revocation drains without self-wait',async()=>{
  let entered;const begun=new Promise(resolve=>{entered=resolve;});
  const f=await composed({model:(_request,signal)=>(async function*(){
    entered();await new Promise((resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  })()});try{
    const started=await f.invoke('start',{sources:[f.ref],goal:'Check current authority.',operationId:'revoke-one'});assert.equal(started.ok,true);await begun;
    const sessionId=started.value.sessionId,business=f.business(),agent=f.ctx().agents.get(sessionId);
    await assert.rejects(business.readPinnedSnapshot(sessionId,{materialId:'foreign',revisionId:'v1'},new AbortController().signal));
    const run=f.tables.runs.get(started.value.runId);run.policyRevision='changed-policy';
    await assert.rejects(business.readPinnedSnapshot(sessionId,f.ref,new AbortController().signal));run.policyRevision='afos.policy.v1';
    f.revoke();
    const error=await Promise.race([business.sessionRun(sessionId,new AbortController().signal).then(()=>undefined,error=>error),
      new Promise(resolve=>{const timer=setTimeout(()=>resolve('self-wait-timeout'),2000);timer.unref();})]);
    assert.ok(error instanceof Error,String(error));await agent.whenIdle();assert.equal(f.tables.artifacts.size,0);
    await assert.rejects(business.materials(new AbortController().signal));
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-P05 unpublished Session failure releases admission; repeated boot removes owned config',async()=>{
  const f=await composed();try{
    const ctx=f.ctx(),business=f.business(),signal=new AbortController().signal;
    await business.readRevision(f.ref,signal);
    const run=await business.authorize([f.ref],'admission-one',signal);
    await assert.rejects(business.prepareSessionBinding(run.runId,'',signal));business.releaseRunAdmission(run.runId);
    const next=await business.authorize([f.ref],'admission-two',signal);assert.notEqual(next.runId,run.runId);business.releaseRunAdmission(next.runId);
    assert.equal((await readdir(f.profileRoot())).filter(name=>/^afos-core-.*\.json$/u.test(name)).length,1);
    await f.main.startHost();assert.notEqual(f.ctx(),ctx);
    await assert.rejects(business.materials(signal));
    assert.equal((await readdir(f.profileRoot())).filter(name=>/^afos-core-.*\.json$/u.test(name)).length,1);
    assert.equal((await f.invoke('state')).ok,true);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-P06 authority revocation at official pre-projection model boundary terminates the same Agent',async()=>{
  const f=await composed();try{
    const ctx=f.ctx();let revoked=false;
    ctx.on('llm/stream',(_options,next)=>{if(!revoked){revoked=true;f.revoke();}return next();},{global:true,prepend:true});
    const started=await f.invoke('start',{sources:[f.ref],goal:'Verify revocation at model dispatch.',operationId:'revoke-at-stream'});assert.equal(started.ok,true);
    const agent=ctx.agents.get(started.value.sessionId);let timer;
    try {assert.equal(await Promise.race([agent.whenIdle().then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]),true);}
    finally{clearTimeout(timer);}
    assert.equal(revoked,true);assert.equal(f.modelCalls(),0);assert.equal(f.tables.artifacts.size,0);
    assert.equal(agent.session.snapshotEvents().at(-1).type,'turn/end');
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-P07 actual authenticated HTTP accepts bounded escaped draft and denies one extra byte',async()=>{
  const f=await composed();try{
    const started=await f.invoke('start',{sources:[f.ref],goal:'Draft edit transport limit.',operationId:'escaped-edit'});assert.equal(started.ok,true);
    const ctx=f.ctx();await ctx.agents.get(started.value.sessionId).whenIdle();
    const base=`http://127.0.0.1:${ctx.webServer.port}`;
    const release=ctx.webServer.register({kind:'exact',path:'/',handler(req,res){if(ctx.connection.authorizeIndex(req,res)){res.writeHead(200);res.end('test auth entry');}}});
    try{
      const login=await fetch(ctx.connection.authenticatedUrl(base+'/'),{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
      const edit=async content=>{
        const response=await fetch(base+'/api/afos/drafts/edit',{method:'POST',headers:{cookie,'content-type':'application/json'},
          body:JSON.stringify({type:'client-request',rpcId:'bounded-edit',method:'afos/drafts/edit',payload:{draftId:started.value.draftId,content}})});
        assert.equal(response.status,200);return(await response.json()).result;
      };
      const content='\u0000'.repeat(64*1024),saved=await edit(content);assert.equal(saved.ok,true);assert.equal(saved.value.content,content);
      assert.equal((await edit(content+'a')).ok,false);assert.equal(f.tables.artifacts.size,0);
    }finally{release();}
  }finally{await f.cleanup();}
});
