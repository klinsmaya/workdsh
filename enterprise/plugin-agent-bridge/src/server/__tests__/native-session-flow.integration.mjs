import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './desktop-fixture.mjs';
import { bootEnterpriseNativeReadCore } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/assembly.js';

const policy = { provider: 'afos-managed', model: 'fixed-model', maxTokens: 64 };
const idleModel = [{ type: 'finish', reason: { kind: 'stop' } }];
async function composed(options = {}) {
  let ctx;
  const f = await fixture({ response: options.response, stopHost: async () => { if (ctx) { const old=ctx;ctx=undefined;await old.fiber.dispose(); } },
    model: async () => idleModel });
  await f.ready(); f.capability({ ingressValidated: true, sandbox: 'full' });
  f.startHook(async (signal, layout, authority, business) => {
    ctx = await bootEnterpriseNativeReadCore({ root: layout.profile, binding: authority.binding,
      projectId: authority.project.id, business: options.expiryMs ? {
        ...business,
        ownedSessionRead: async (sessionId, callerSignal) => {
          const grant = await business.ownedSessionRead(sessionId, callerSignal);
          return Object.freeze({ ...grant, expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), Date.now() + options.expiryMs)).toISOString() });
        },
      } : business, model: policy, signal });
  });
  await f.main.startHost();
  const drafts = (method, payload={}) => ctx.afosDraftRuntime.invoke('afos/drafts/'+method,payload,new AbortController().signal);
  const response = await drafts('start',{ sources: [f.ref], goal: 'Read original owned local history.', operationId: 'native-five-fixture' });
  assert.equal(response.ok, true, JSON.stringify(response));
  const sessionId=response.value.sessionId;
  await ctx.agents.get(sessionId).whenIdle(); await new Promise(resolve=>setImmediate(resolve));
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

test('AFOS-NATIVE-01 actual opt-in Loader/Controller/Gateway and real Main forward three owned unary reads',async()=>{
  const f=await composed();try{
    const ctx=f.ctx();assert.ok(ctx.get('afosNativeReadBridge'));
    assert.equal(ctx.get('typertGateway'),undefined);assert.equal(ctx.get('sessionController'),undefined);assert.equal(ctx.get('fs'),undefined);
    await assert.rejects(f.business().sessionRun(f.sessionId,new AbortController().signal),/session-run-unowned/);
    const before=f.calls.length;
    const listed=await f.unary('session/list',{args:{_request:{}}});
    assert.equal(listed.ok,true,JSON.stringify(listed));assert.deepEqual(listed.value.items.map(item=>item.sessionId),[f.sessionId]);
    const projected=await f.unary('session/projections',{args:{request:{sessionId:f.sessionId}}});
    assert.equal(projected.ok,true,JSON.stringify(projected));assert.ok(projected.value.asOfSeq>=0);
    const events=ctx.agents.get(f.sessionId).session.snapshotEvents();
    const paged=await f.unary('session/page',{args:{request:{address:{kind:'session',sessionId:f.sessionId},throughSeq:events.at(-1).seq,maxMessages:500}}});
    assert.equal(paged.ok,true,JSON.stringify(paged));
    assert.ok(f.calls.slice(before).filter(action=>action==='identity.current').length>=3);
    assert.equal((await f.unary('session/projections',{args:{request:{sessionId:'foreign-session'}}})).ok,false);
    assert.equal((await f.unary('session/create',{args:{}})).ok,false);
    for(const method of ['state','materials'])assert.equal((await f.drafts(method)).ok,true);
  }finally{await f.cleanup();}
});

test('AFOS-NATIVE-02 parallel original follow/control retain independent scoped admission and original typed frames',async()=>{
  const f=await composed();const followAbort=new AbortController(),controlAbort=new AbortController();try{
    const follow=(await f.follow(followAbort.signal))[Symbol.asyncIterator]();
    const opening=await follow.next();assert.equal(opening.value.type,'snapshot');assert.equal(opening.value.header.id,f.sessionId);
    const control=(await f.control(controlAbort.signal))[Symbol.asyncIterator]();
    const baseline=await control.next();assert.equal(baseline.value.type,'baseline');assert.deepEqual(Object.keys(baseline.value.value.projections),[f.sessionId]);
    const projected=await f.unary('session/projections',{args:{request:{sessionId:f.sessionId}}});assert.equal(projected.ok,true);
    followAbort.abort();await assert.rejects(follow.next());await follow.return();
    assert.equal(controlAbort.signal.aborted,false);
    controlAbort.abort();await assert.rejects(control.next());await control.return();
    assert.equal((await f.unary('session/list',{args:{_request:{}}})).ok,true);
  }finally{followAbort.abort();controlAbort.abort();await f.cleanup();}
});

// Read-only fixture inspection of Cordis's published reflection store. This does not
// give any browser or runtime caller a capability to the private original services.
function service(ctx, name) {
  const found=Reflect.ownKeys(ctx.reflect.store).map(key=>ctx.reflect.store[key]).filter(record=>record.name===name&&record.value);
  assert.equal(found.length,1,'expected one original '+name);return found[0].value;
}
async function untilFailure(iterator) {
  while(true) { const item=await iterator.next();if(item.done)throw new Error('stream completed without a cancellation rejection'); }
}
async function bounded(promise, ms=2000) {
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture deadline')),ms);timer.unref();})]);}
  finally{clearTimeout(timer);}
}

test('AFOS-NATIVE-03 per-RPC shortened fresh authority expiry closes original concurrent streams and permits fresh reads',async()=>{
  // Only shorten an actual Main grant; never extend it or replace its host epoch/signal.
  const f=await composed({expiryMs:150});const abort=new AbortController();let follow,control;try{
    follow=(await f.follow(abort.signal))[Symbol.asyncIterator]();
    assert.equal((await follow.next()).value.type,'snapshot');
    control=(await f.control(abort.signal))[Symbol.asyncIterator]();
    assert.equal((await control.next()).value.type,'baseline');
    const outcomes=await bounded(Promise.allSettled([untilFailure(follow),untilFailure(control)]));
    assert.ok(outcomes.every(item=>item.status==='rejected'&&!String(item.reason).includes('fixture deadline')&&!String(item.reason).includes('stream completed without a cancellation rejection')));
    assert.equal(abort.signal.aborted,false);
    assert.equal((await f.unary('session/list',{args:{_request:{}}})).ok,true);
  }finally{abort.abort();await Promise.allSettled([follow?.return(),control?.return()]);await f.cleanup();}
});

test('AFOS-NATIVE-04 original delayed projection past fresh lease expiry cannot escape the scoped unary admission',async()=>{
  const f=await composed({expiryMs:100});const controller=service(f.ctx(),'sessionController');
  const original=controller.projections;let release,entered;
  const barrier=new Promise(resolve=>release=resolve),called=new Promise(resolve=>entered=resolve);
  controller.projections=async function(...args){const value=await original.apply(this,args);entered();await barrier;return value;};
  try{
    const pending=f.unary('session/projections',{args:{request:{sessionId:f.sessionId}}});
    await bounded(called);await new Promise(resolve=>setTimeout(resolve,150));release();
    assert.equal((await pending).ok,false);
    controller.projections=original;
    assert.equal((await f.unary('session/projections',{args:{request:{sessionId:f.sessionId}}})).ok,true);
  }finally{release();controller.projections=original;await f.cleanup();}
});

test('AFOS-NATIVE-05 direct private original Gateway has no business lease; parent raw file/upload and streaming unary stay closed',async()=>{
  const f=await composed();try{
    const gateway=service(f.ctx(),'typertGateway');
    await assert.rejects(gateway.invoke({namespace:'session',method:'list',args:{_request:{}}}),error=>error.code==='afos/session-view-unavailable');
    await assert.rejects(gateway.invoke({namespace:'llm',method:'listProviders',args:{}}),error=>error.code==='gateway/invocation-unavailable');
    const events=await gateway.wireStream.open('$events',{args:{}},(async function*(){})(),undefined,new AbortController().signal);
    await assert.rejects(events[Symbol.asyncIterator]().next(),error=>error.code==='gateway/service-unavailable');
    const shared=f.ctx().connection.createSharedFetchHandler('/api');
    for(const method of ['GET','HEAD']) {
      const result=await shared.fetch(new Request('http://127.0.0.1/api/file?path='+encodeURIComponent(f.base),{method}));assert.equal(result.status,404);
    }
    const upload=await shared.fetch(new Request('http://127.0.0.1/api/session/uploadFileBinary',{method:'POST',body:'probe-bytes'}));
    assert.equal(upload.status,415); // Original parent RPC parser refuses raw text bytes; no upload route is mounted.
    const invalidJsonUpload=await shared.fetch(new Request('http://127.0.0.1/api/session/uploadFileBinary',{method:'POST',headers:{'content-type':'application/json'},body:'probe-bytes'}));
    assert.equal(invalidJsonUpload.status,400);
    assert.equal((await f.unary('session/follow',{args:{request:{address:{kind:'session',sessionId:f.sessionId}}}})).error?.code,'gateway/signature-invalid');
  }finally{await f.cleanup();}
});

test('AFOS-NATIVE-06 fresh Main revocation closes existing scoped streams and denies cached old session reads',async()=>{
  const f=await composed();const abort=new AbortController(),bridge=f.ctx().afosNativeReadBridge;let follow,control;try{
    follow=(await f.follow(abort.signal))[Symbol.asyncIterator]();await follow.next();
    control=(await f.control(abort.signal))[Symbol.asyncIterator]();await control.next();
    const pending=Promise.allSettled([untilFailure(follow),untilFailure(control)]);
    f.revoke();await assert.rejects(f.business().ownedSessionRead(f.sessionId,new AbortController().signal));
    const outcomes=await bounded(pending);
    assert.ok(outcomes.every(item=>item.status==='rejected'&&!String(item.reason).includes('fixture deadline')&&!String(item.reason).includes('stream completed without a cancellation rejection')));
    await assert.rejects(bridge.invoke('session/list',{args:{_request:{}}},new AbortController().signal));
  }finally{abort.abort();await Promise.allSettled([follow?.return(),control?.return()]);await f.cleanup();}
});

test('AFOS-NATIVE-07 an unstarted consumer return immediately returns the actual original iterator once',async()=>{
  const f=await composed();const gateway=service(f.ctx(),'typertGateway'),wire=gateway.wireStream;
  const original=wire.open;let returned=0,sourceSignal;
  wire.open=async function(...args){const source=await original.apply(this,args);sourceSignal=args[4];
    const iterator=source[Symbol.asyncIterator]();return {[Symbol.asyncIterator](){return this;},next:()=>iterator.next(),return:async()=>{returned++;return iterator.return();}};};
  try{
    const source=await f.follow(new AbortController().signal),iterator=source[Symbol.asyncIterator]();
    assert.equal(sourceSignal.aborted,false);assert.equal(returned,0);
    assert.equal((await bounded(iterator.return())).done,true);
    assert.equal(sourceSignal.aborted,true);assert.equal(returned,1);
    await iterator.return();assert.equal(returned,1);
    assert.equal((await iterator.next()).done,true);
    assert.equal((await f.unary('session/list',{args:{_request:{}}})).ok,true);
  }finally{wire.open=original;await f.cleanup();}
});


test('AFOS-NATIVE-08 a new successful local selection during actual response JSON consumption denies the previous result',async()=>{
  const f=await composed();const original=Response.prototype.json;let release,entered,paused=false;
  const barrier=new Promise(resolve=>release=resolve),called=new Promise(resolve=>entered=resolve);
  Response.prototype.json=async function(...args){const value=await original.apply(this,args);
    if(!paused&&value?.result?.ok===true&&typeof value.result.value?.asOfSeq==='number') {paused=true;entered();await barrier;}
    return value;
  };
  try{
    const pending=f.unary('session/projections',{args:{request:{sessionId:f.sessionId}}});
    await bounded(called);
    const next=await f.drafts('start',{sources:[f.ref],goal:'Select the next owned local session.',operationId:'native-second-selection'});
    assert.equal(next.ok,true,JSON.stringify(next));assert.notEqual(next.value.sessionId,f.sessionId);
    await f.ctx().agents.get(next.value.sessionId).whenIdle();release();
    assert.equal((await pending).ok,false);
    const latest=await f.unary('session/list',{args:{_request:{}}});assert.equal(latest.ok,true);
    assert.deepEqual(latest.value.items.map(item=>item.sessionId),[next.value.sessionId]);
  }finally{release();Response.prototype.json=original;await f.cleanup();}
});
