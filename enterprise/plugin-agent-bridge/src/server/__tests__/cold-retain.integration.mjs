import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composed, bounded, publicSdk } from './read-catalog.integration.mjs';
import NativeWsFacade from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/native-ws-facade.js';
import { EnterpriseNativeReadCatalog } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/native-read-catalog.js';

async function cold(options={}) {
  const f=await composed(options);
  const start=await f.drafts('start',{sources:[f.ref],goal:'Owned cold retained history.',operationId:'cold-retain-'+Math.random()});
  assert.equal(start.ok,true);const id=start.value.sessionId;await f.ctx().agents.get(id).whenIdle();
  const binding=(await f.business().currentAuthority(new AbortController().signal)).binding,models=f.models();await f.reopen(binding);
  return {f,id,models,catalog:f.ctx().get('afosNativeReadBridge').catalog};
}
function countOriginal(catalog) {
  const real=catalog.controller.follow.bind(catalog.controller),ctx=catalog.controllerContext,on=ctx.on.bind(ctx);
  const counts={next:0,returned:0,listeners:0};
  catalog.controller.follow=(...args)=>{const iterator=real(...args)[Symbol.asyncIterator]();return {
    next(){counts.next++;assert.equal(counts.next,1,'never request original post-yield promotion');return iterator.next();},
    return(){counts.returned++;return iterator.return();},[Symbol.asyncIterator](){return this;},
  };};
  ctx.on=(...args)=>{const release=on(...args);if(!['session/event','session/created','agent/assistant-stream'].includes(args[0]))return release;
    counts.listeners++;let closed=false;return()=>{if(closed)return;closed=true;counts.listeners--;release();};};
  return {counts,restore(){catalog.controller.follow=real;ctx.on=on;}};
}
function noExecution(value) {
  assert.equal(value.f.ctx().agents.list().length,0);assert.equal(value.f.ctx().sessions.list().length,0);
  assert.equal(value.f.created(),0);assert.equal(value.f.models(),value.models);
}
const request=id=>({address:{kind:'session',sessionId:id},assistantStream:true,maxMessages:500});

test('COLD-RETAIN-01 strict ordinary owned wire snapshot and original public Remote SDK',async()=>{
  const value=await cold();let sdk;const abort=new AbortController();let iterator;try{
    sdk=await publicSdk(value.f);iterator=sdk.client.remote.session.follow(sdk.json(request(value.id)),abort.signal)[Symbol.asyncIterator]();
    const first=await iterator.next();assert.equal(first.value.type,'snapshot');assert.equal(first.value.header.id,value.id);
    assert.ok(JSON.stringify(first.value.records).includes('Owned cold retained history.'));assert.deepEqual(JSON.parse(JSON.stringify(first.value.assistantStream)),{revision:0});noExecution(value);
    abort.abort();await iterator.return();iterator=undefined;
    for(const bad of [
      {...request(value.id),cursor:10}, {...request(value.id),throughSeq:10}, {...request(value.id),extra:true},
      request('../escape'),request('unknown-session'),{address:{kind:'subagent',parentSessionId:value.id,childSessionId:'foreign',mode:'one-shot'}},
      {...request(value.id),assistantStream:false},{...request(value.id),maxMessages:0},{...request(value.id),maxMessages:501},
      {...request(value.id),turnWindow:{minMessages:501,minTurns:1}},{...request(value.id),turnWindow:{minMessages:1,minTurns:101}},
    ]){
      const denied=new AbortController(),stream=value.catalog.coldFollow(bad,denied.signal,Date.now()+60000)[Symbol.asyncIterator]();
      try{await assert.rejects(stream.next());}finally{denied.abort();await stream.return();}
    }
    noExecution(value);
  }finally{abort.abort();await iterator?.return();await sdk?.close();await value.f.cleanup();}
});

test('COLD-RETAIN-02 pending real public observation abort completes return and disposes original lease/listeners',async()=>{
  const value=await cold(),abort=new AbortController(),entered=Promise.withResolvers(),instrument=countOriginal(value.catalog);
  const query=value.catalog.controllerContext.get('sessionQuery'),real=query.observeSession.bind(query);let disposed=0;
  query.observeSession=async(id,options)=>{const observation=await real(id,options);entered.resolve();try{
    await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
    return observation;
  }catch(error){observation[Symbol.dispose]();disposed++;throw error;}};
  const iterator=value.catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
  try{const pending=iterator.next();await entered.promise;abort.abort(Error('caller cancelled pending source'));await assert.rejects(pending);
    assert.equal(disposed,1);assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});noExecution(value);
  }finally{abort.abort();await iterator.return();query.observeSession=real;instrument.restore();await value.f.cleanup();}
});

test('COLD-RETAIN-03 original observation dispose error rejects snapshot after real cleanup',async()=>{
  const value=await cold(),abort=new AbortController(),instrument=countOriginal(value.catalog),query=value.catalog.controllerContext.get('sessionQuery'),real=query.observeSession.bind(query);let disposed=0;
  query.observeSession=async(...args)=>{const observation=await real(...args);return new Proxy(observation,{get(target,key){
    if(key===Symbol.dispose)return()=>{target[Symbol.dispose]();disposed++;throw Error('fixture original source dispose failure');};
    const item=Reflect.get(target,key,target);return typeof item==='function'?item.bind(target):item;
  }});};
  const iterator=value.catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
  try{await assert.rejects(iterator.next(),/fixture original source dispose failure/);assert.equal(disposed,1);
    assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});noExecution(value);
  }finally{abort.abort();await iterator.return();query.observeSession=real;instrument.restore();await value.f.cleanup();}
});

test('COLD-RETAIN-04 public captured services revoked or ingress appears during first await rejects late snapshot',async()=>{
  for(const name of ['sessionQuery','sessionController','webServer']){
    const value=await cold(),abort=new AbortController(),entered=Promise.withResolvers(),release=Promise.withResolvers();let iterator,instrument;
    const originalContext=value.catalog.controllerContext,query=originalContext.get('sessionQuery'),real=query.observeSession.bind(query);let disposed=0;
    try{
      // A real public Cordis isolated service scope, owned by the captured fiber.
      // The actual Controller and actual query provider remain the initial services.
      const ctx=originalContext.isolate(name);ctx.provide(name,name==='webServer'?undefined:originalContext.get(name));
      const catalog=new EnterpriseNativeReadCatalog(value.catalog.owner,value.catalog.controller,ctx,value.catalog.lifetime);
      instrument=countOriginal(catalog);
      query.observeSession=async(...args)=>{const observation=await real(...args);entered.resolve();await release.promise;return new Proxy(observation,{get(target,key){
        if(key===Symbol.dispose)return()=>{target[Symbol.dispose]();disposed++;};const item=Reflect.get(target,key,target);return typeof item==='function'?item.bind(target):item;
      }});};
      iterator=catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
      const pending=iterator.next(),rejected=assert.rejects(pending);await entered.promise;
      ctx[name]=name==='webServer'?value.f.ctx().webServer:undefined;
      release.resolve();await rejected;assert.equal(disposed,1);assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});noExecution(value);
    }finally{release.resolve();abort.abort();try{await iterator?.return();}finally{query.observeSession=real;instrument?.restore();await value.f.cleanup();}}
  }
});

test('COLD-RETAIN-05 Main cutoff while fresh post-snapshot authority is held cannot return a late frame',async()=>{
  let held=false;const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const value=await cold({response:async request=>{if(held&&request.action==='identity.current'){entered.resolve();await release.promise;}return undefined;}}),abort=new AbortController(),instrument=countOriginal(value.catalog);
  const query=value.catalog.controllerContext.get('sessionQuery'),real=query.observeSession.bind(query);
  query.observeSession=async(...args)=>{const observation=await real(...args);held=true;return observation;};
  const iterator=value.catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
  try{const pending=iterator.next();await entered.promise;const stopped=value.f.main.suspend();held=false;release.resolve();await assert.rejects(pending);await stopped;
    assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});assert.equal(value.f.created(),0);assert.equal(value.f.models(),value.models);
  }finally{held=false;release.resolve();abort.abort();await iterator.return();query.observeSession=real;instrument.restore();await value.f.cleanup();}
});

test('COLD-RETAIN-06 fresh same-epoch real Main grants maintain static snapshot past old expiry without resuming source',async()=>{
  const value=await cold(),abort=new AbortController();let iterator,instrument,grants=0;
  try{
    const business=value.catalog.owner.afosMainBusiness,owner=value.catalog.owner.isolate('afosMainBusiness');
    // Test-only shortened lifetime over the real Main grant; product TTL stays 60s.
    owner.provide('afosMainBusiness',{...business,ownedSessionRead:async(...args)=>{grants++;return Object.freeze({...await business.ownedSessionRead(...args),expiresAt:new Date(Date.now()+100).toISOString()});}});
    const catalog=new EnterpriseNativeReadCatalog(owner,value.catalog.controller,value.catalog.controllerContext,value.catalog.lifetime);instrument=countOriginal(catalog);
    iterator=catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type,'snapshot');let ended=false;const pending=iterator.next().then(result=>{ended=true;return result;});await new Promise(resolve=>setTimeout(resolve,240));assert.equal(ended,false);assert.ok(grants>=4);abort.abort();assert.equal((await pending).done,true);
    assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});noExecution(value);
  }finally{abort.abort();try{await iterator?.return();}finally{instrument?.restore();await value.f.cleanup();}}
});


test('COLD-RETAIN-07 real pending observation physical deadline aborts source before first frame',async()=>{
  const value=await cold(),abort=new AbortController(),instrument=countOriginal(value.catalog),query=value.catalog.controllerContext.get('sessionQuery'),real=query.observeSession.bind(query);let disposed=0;
  query.observeSession=async(id,options)=>{const observation=await real(id,options);try{await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});return observation;}catch(error){observation[Symbol.dispose]();disposed++;throw error;}};
  const iterator=value.catalog.coldFollow(request(value.id),abort.signal,Date.now()+120)[Symbol.asyncIterator](),started=Date.now();
  try{await assert.rejects(iterator.next());assert.ok(Date.now()-started>=90);assert.equal(disposed,1);assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});noExecution(value);}
  finally{abort.abort();try{await iterator.return();}finally{query.observeSession=real;instrument.restore();await value.f.cleanup();}}
});

test('COLD-RETAIN-08 preaborted read never enters original public source',async()=>{
  const value=await cold(),abort=new AbortController(),instrument=countOriginal(value.catalog);abort.abort(Error('already cancelled'));
  const iterator=value.catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
  try{await assert.rejects(iterator.next(),/already cancelled/);assert.deepEqual(instrument.counts,{next:0,returned:0,listeners:0});noExecution(value);}
  finally{try{await iterator.return();}finally{instrument.restore();await value.f.cleanup();}}
});

test('COLD-RETAIN-09 actual public Session attachment during first read rejects late cold frame without Agent',async()=>{
  const value=await cold(),abort=new AbortController(),instrument=countOriginal(value.catalog),query=value.catalog.controllerContext.get('sessionQuery'),real=query.observeSession.bind(query);let detach,disposed=0;
  query.observeSession=async(...args)=>{const observation=await real(...args),sessions=value.f.ctx().sessions;
    const session=sessions.prepare(value.id,{seed:observation.events,meta:observation.header});detach=sessions.enter(session);
    return new Proxy(observation,{get(target,key){if(key===Symbol.dispose)return()=>{target[Symbol.dispose]();disposed++;};const item=Reflect.get(target,key,target);return typeof item==='function'?item.bind(target):item;}});};
  const iterator=value.catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
  try{await assert.rejects(iterator.next());assert.equal(disposed,1);assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});detach();detach=undefined;noExecution(value);}
  finally{abort.abort();try{await iterator.return();}finally{detach?.();query.observeSession=real;instrument.restore();await value.f.cleanup();}}
});


test('COLD-RETAIN-10 actual same-peer cancel preserves healthy catalogs and late old-peer disposal cannot close new peer',async()=>{
  const value=await cold(),peers=[],real=NativeWsFacade.prototype.follow;let oldSocket,newSocket;
  NativeWsFacade.prototype.follow=function(...args){peers.push({peer:this.ctx.invocation.peer,signal:this.ctx.afosNativeHttpProof.carrierProof(this.ctx.invocation.peer).signal});return real.apply(this,args);};
  try{
    oldSocket=await value.f.socket();oldSocket.open('cold','session/follow',{args:{request:request(value.id)}});assert.equal((await oldSocket.next()).value.type,'snapshot');assert.equal(peers.length,1);
    oldSocket.ws.send(JSON.stringify({type:'cancel',streamId:'cold'}));await new Promise(resolve=>setTimeout(resolve,80));assert.equal(oldSocket.ws.readyState,1);assert.equal(peers[0].signal.aborted,false);
    oldSocket.open('healthy-control','session/control');assert.equal((await oldSocket.next()).value.type,'baseline');oldSocket.open('healthy-workspace','workspace/follow');assert.equal((await oldSocket.next()).value.type,'baseline');
    newSocket=await value.f.socket();newSocket.open('new-cold','session/follow',{args:{request:request(value.id)}});assert.equal((await newSocket.next()).value.type,'snapshot');assert.equal(peers.length,2);assert.notEqual(peers[0].peer.ctx,peers[1].peer.ctx);
    const closed=new Promise(resolve=>oldSocket.ws.once('close',resolve));await peers[0].peer.dispose();await bounded(closed);assert.equal(peers[0].signal.aborted,true);assert.equal(peers[1].signal.aborted,false);assert.equal(newSocket.ws.readyState,1);
    newSocket.open('new-control','session/control');assert.equal((await newSocket.next()).value.type,'baseline');noExecution(value);
  }finally{NativeWsFacade.prototype.follow=real;await oldSocket?.close();await newSocket?.close();await value.f.cleanup();}
});


test('COLD-RETAIN-11 rejected or changed exact read renewal ends only logical stream after original cleanup',async()=>{
  for(const kind of ['deny','epoch','signal']){
    const value=await cold(),abort=new AbortController();let iterator,instrument,calls=0;
    try{
      const business=value.catalog.owner.afosMainBusiness,owner=value.catalog.owner.isolate('afosMainBusiness');
      owner.provide('afosMainBusiness',{...business,ownedSessionRead:async(...args)=>{const actual=await business.ownedSessionRead(...args);calls++;if(calls>=3&&kind==='deny')throw Error('renewal denied');return Object.freeze({...actual,expiresAt:new Date(Date.now()+150).toISOString(),...(calls>=3&&kind==='epoch'?{epoch:Object.freeze({})}:{}),...(calls>=3&&kind==='signal'?{signal:new AbortController().signal}:{})});}});
      const catalog=new EnterpriseNativeReadCatalog(owner,value.catalog.controller,value.catalog.controllerContext,value.catalog.lifetime);instrument=countOriginal(catalog);iterator=catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.type,'snapshot');await assert.rejects(iterator.next());assert.equal(calls,3);assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});noExecution(value);
      assert.equal((await value.f.http('session/list',{args:{_request:{}}})).ok,true);
    }finally{abort.abort();try{await iterator?.return();}finally{instrument?.restore();await value.f.cleanup();}}
  }
});

test('COLD-RETAIN-12 selected content expiry/denial preserves other owned catalogs on actual same peer',async()=>{
 let selected,denySelected=false;const value=await cold({business:business=>Object.freeze({...business,ownedSessionRead:async(id,signal)=>{
  const actual=await business.ownedSessionRead(id,signal);if(denySelected&&id===selected)throw Error('selected Session read denied');return actual;
 }})});let socket;
 try{
  const started=await value.f.drafts('start',{sources:[value.f.ref],goal:'Independent selected Session.',operationId:'selected-content-boundary'});assert.equal(started.ok,true);selected=started.value.sessionId;
  await value.f.ctx().agents.get(selected).whenIdle();const bridge=value.f.ctx().get('afosNativeReadBridge'),oldPermit=await bridge.admitReadCarrier(new AbortController().signal);
  socket=await value.f.socket();socket.open('other-cold','session/follow',{args:{request:request(value.id)}});assert.equal((await socket.next()).value.header.id,value.id);
  await new Promise(resolve=>setTimeout(resolve,Math.max(1,oldPermit.expiresAt-Date.now()+60)));assert.throws(()=>oldPermit.assertCurrent());assert.equal(socket.ws.readyState,1);
  denySelected=true;
  socket.open('selected-denied','session/follow',{args:{request:request(selected)}});assert.equal((await socket.next()).type,'error');assert.equal(socket.ws.readyState,1);
  socket.open('healthy-control','session/control');const control=await socket.next();assert.equal(control.type,'item');assert.equal(control.value.type,'baseline');assert.equal(control.value.value.projections[selected],undefined);
  socket.open('healthy-other-cold','session/follow',{args:{request:request(value.id)}});assert.equal((await socket.next()).value.header.id,value.id);
  socket.open('healthy-workspace','workspace/follow');assert.equal((await socket.next()).value.type,'baseline');
  assert.equal((await value.f.http('session/projections',{args:{request:{sessionId:selected}}})).ok,false);assert.equal((await value.f.http('session/projections',{args:{request:{sessionId:value.id}}})).ok,true);
  assert.equal(value.f.created(),1);assert.equal(value.f.models(),value.models+1);assert.equal(value.f.ctx().agents.list().length,1);
 }finally{denySelected=false;await socket?.close();await value.f.cleanup();}
});

test('COLD-RETAIN-13 physical cancellation of pending read renewal returns after original source cleanup',async()=>{
 const value=await cold(),abort=new AbortController(),entered=Promise.withResolvers();let iterator,instrument,calls=0,hold=true;
 try{
  const business=value.catalog.owner.afosMainBusiness,owner=value.catalog.owner.isolate('afosMainBusiness');
  owner.provide('afosMainBusiness',{...business,ownedSessionRead:async(id,signal)=>{
   const actual=await business.ownedSessionRead(id,signal);if(++calls>=3&&hold){entered.resolve();await new Promise((resolve,reject)=>{
    if(signal.aborted)reject(Error('afos/main-ipc-outcome-unknown'));else signal.addEventListener('abort',()=>reject(Error('afos/main-ipc-outcome-unknown')),{once:true});
   });}return Object.freeze({...actual,expiresAt:new Date(Date.now()+150).toISOString()});
  }});
  const catalog=new EnterpriseNativeReadCatalog(owner,value.catalog.controller,value.catalog.controllerContext,value.catalog.lifetime);instrument=countOriginal(catalog);
  iterator=catalog.coldFollow(request(value.id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();assert.equal((await iterator.next()).value.type,'snapshot');
  const pending=iterator.next();await entered.promise;abort.abort(Error('physical caller ended'));assert.equal((await pending).done,true);hold=false;
  assert.deepEqual(instrument.counts,{next:1,returned:1,listeners:0});noExecution(value);assert.equal((await value.f.http('session/list',{args:{_request:{}}})).ok,true);
 }finally{abort.abort();try{await iterator?.return();}finally{instrument?.restore();await value.f.cleanup();}}
});

test('LIVE-RETAIN-01 original live iterator survives actual short grant expiry without new execution',async()=>{
 const f=await composed(),abort=new AbortController();let iterator;try{
  const started=await f.drafts('start',{sources:[f.ref],goal:'Existing live read renewal.',operationId:'live-renew'});assert.equal(started.ok,true);
  const id=started.value.sessionId,agent=f.ctx().agents.get(id);await agent.whenIdle();const models=f.models(),catalog=f.ctx().get('afosNativeReadBridge').catalog;
  const firstGrant=await f.business().ownedSessionRead(id,abort.signal);assert.ok(Date.parse(firstGrant.expiresAt)-Date.now()<=5000);
  iterator=catalog.liveFollow(request(id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();assert.equal((await iterator.next()).value.type,'snapshot');
  let ended=false;const pending=iterator.next().then(value=>{ended=true;return value;},error=>{ended=true;throw error;});
  await new Promise(resolve=>setTimeout(resolve,5300));assert.equal(ended,false);assert.equal(f.ctx().agents.get(id),agent);assert.equal(f.models(),models);assert.equal(f.ctx().agents.list().length,1);
  abort.abort(Error('live consumer cancelled'));await assert.rejects(pending);assert.equal((await f.http('session/list',{args:{_request:{}}})).ok,true);
 }finally{abort.abort();await iterator?.return();await f.cleanup();}
});

test('LIVE-RETAIN-02 renewal denial, epoch change or private query replacement aborts only original logical reader',async()=>{
 for(const kind of ['deny','epoch','query']){
  const f=await composed(),abort=new AbortController();let iterator;try{
   const started=await f.drafts('start',{sources:[f.ref],goal:'Existing live read boundary.',operationId:'live-'+kind});assert.equal(started.ok,true);
   const id=started.value.sessionId,agent=f.ctx().agents.get(id);await agent.whenIdle();const models=f.models(),source=f.ctx().get('afosNativeReadBridge').catalog;
   const business=source.owner.afosMainBusiness,owner=source.owner.isolate('afosMainBusiness'),captured=source.controllerContext.isolate('sessionQuery');captured.provide('sessionQuery',source.controllerContext.get('sessionQuery'));let calls=0;
   owner.provide('afosMainBusiness',{...business,ownedSessionRead:async(...args)=>{const actual=await business.ownedSessionRead(...args);calls++;if(calls>=3&&kind==='deny')throw Error('live renewal denied');if(calls>=3&&kind==='query')captured.sessionQuery=undefined;return Object.freeze({...actual,expiresAt:new Date(Date.now()+150).toISOString(),...(calls>=3&&kind==='epoch'?{epoch:Object.freeze({})}:{})});}});
   const catalog=new EnterpriseNativeReadCatalog(owner,source.controller,captured,source.lifetime);
   iterator=catalog.liveFollow(request(id),abort.signal,Date.now()+60000)[Symbol.asyncIterator]();assert.equal((await iterator.next()).value.type,'snapshot');await assert.rejects(iterator.next());assert.equal(calls,3);
   assert.equal(f.ctx().agents.get(id),agent);assert.equal(f.ctx().agents.list().length,1);assert.equal(f.models(),models);assert.equal((await f.http('session/list',{args:{_request:{}}})).ok,true);
  }finally{abort.abort();await iterator?.return();await f.cleanup();}
 }
});
