import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ModelPolicy } from '@afos/model-adapter';
import type { GatewayAuthoritySnapshot } from 'workdsh-contracts';
import type { EnterpriseMaterialView, EnterpriseSourceRef } from 'workdsh-contracts/enterprise-drafts';
import type { MainBusinessCapabilities, MainSessionBindingLease, MainAsyncBusinessAccess, OfficialTurnEvent } from './main-capabilities.js';
import { IPC_VERSION, IPC_MAX_PENDING, IPC_CHUNK_BYTES, IPC_MODEL_BYTES, MainIpcError, denied,
  record, id, businessId, text, integer, stamp, source, sources, authority, runDto, run, draftDto, draft, snapshot, boundedJson,
  type MainSnapshot } from './main-ipc-data.js';

/** The owner adapts an existing private Node child channel; no public listener or Remote is installed. */
export interface MainIpcEndpoint {
  send(message: object): Promise<void>;
  messages(listener: (message: unknown) => void): () => void;
  disconnected(listener: () => void): () => void;
}
export interface MainIpcBootstrap { readonly root: string; readonly model: ModelPolicy }
const METHODS = {
  'authority.current': [], 'state.refresh': [], 'materials.list': [],
  'material.read': ['ref'], 'run.authorize': ['refs','operationId'], 'run.release': ['runId'],
  'publication.prepare': ['runId','sessionId'], 'publication.ack': ['ticket'], 'publication.release': ['ticket'],
  'session.run': ['sessionId'], 'session.read': ['sessionId'], 'snapshot.read': ['sessionId','ref'],
  'draft.prepare': ['sessionId','content','refs'], 'draft.edit': ['draftId','content'],
  'session.project': ['sessionId','event'], 'session.cancel': ['sessionId','stopped'],
  'draft.archive': ['draftId','sha256'], 'model.open': ['sessionId','request'],
  'model.next': ['streamId'], 'model.close': ['streamId'],
} as const;
type Method = keyof typeof METHODS;
function method(value:unknown):Method { if(typeof value!=='string'||!Object.hasOwn(METHODS,value))denied(); return value as Method; }
function eventDto(value:unknown):OfficialTurnEvent {
  const v=record(value,['type','seq','time','data']),data=record(v.data,['turn'],['reason']);
  if(v.type!=='turn/start'&&v.type!=='turn/end')denied();
  const reason=data.reason===undefined?undefined:record(data.reason,['kind']);
  return Object.freeze({type:v.type,seq:integer(v.seq,Number.MAX_SAFE_INTEGER),time:integer(v.time,Number.MAX_SAFE_INTEGER),
    data:Object.freeze({turn:integer(data.turn),...(reason?{reason:Object.freeze({kind:id(reason.kind)})}:{})})});
}
function policy(value:unknown):ModelPolicy {
  const v=record(value,['provider','model','maxTokens'],['maxRequestBytes']);
  const maxTokens=integer(v.maxTokens,1000000);if(!maxTokens)denied();
  return Object.freeze({provider:businessId(v.provider),model:businessId(v.model),maxTokens,
    ...(v.maxRequestBytes===undefined?{}:{maxRequestBytes:integer(v.maxRequestBytes,1048576)})});
}
function fixedModelRequest(value:unknown):object {
  const v=record(value,['contractVersion','run','callId','request']); const ref=record(v.run,['runId','attempt']);
  if(v.contractVersion!=='afos.model.v1'||integer(ref.attempt)!==1)denied();id(ref.runId);id(v.callId);
  record(v.request,['messages','maxTokens'],['system','tools','temperature','stop','purpose']); boundedJson(value);return v;
}
/** Validate nested caller DTOs before any Main/server business operation. */
function validateArgs(name:Method,args:Record<string,unknown>):void {
  if('sessionId' in args)businessId(args.sessionId);
  if('runId' in args)businessId(args.runId);
  if('draftId' in args)businessId(args.draftId);
  if('ticket' in args)id(args.ticket);
  if('streamId' in args)id(args.streamId);
  if('content' in args)text(args.content,65536);
  if('refs' in args)sources(args.refs);
  if('operationId' in args)businessId(args.operationId);
  if(name==='material.read')source(args.ref);
  if(name==='snapshot.read'){const ref=record(args.ref,['materialId','revisionId']);businessId(ref.materialId);businessId(ref.revisionId);}
  if(name==='session.project')eventDto(args.event);
  if(name==='session.cancel'&&args.stopped!==false)denied();
  if(name==='draft.archive')source({materialId:'hash',revisionId:'hash',sha256:args.sha256});
  if(name==='model.open')fixedModelRequest(args.request);
}
function safeCode(error:unknown):string {
  const codes=['enterprise/account-changed','enterprise/host-changed','enterprise/offline-restart-required',
    'enterprise/draft-session-not-owned','enterprise/session-run-unowned','enterprise/session-publication-denied',
    'broker/request-failed','broker/token-rejected','broker/project-access-denied','afos/main-ipc-refused'];
  return error instanceof Error&&codes.includes(error.message)?error.message:'afos/main-ipc-operation-refused';
}
interface ParentStream { readonly iterator:AsyncIterator<Uint8Array>; readonly abort:AbortController; busy:boolean; bytes:number; remainder:Uint8Array; }
/** Main retains credentials, leases, durable drafts and current authority. Requires a real captured Host signal. */
export async function attachMainBusinessIpc(endpoint:MainIpcEndpoint,business:MainBusinessCapabilities,
  startSignal:AbortSignal,bootstrap:MainIpcBootstrap):Promise<{readonly generation:string; close():Promise<void>}> {
  if(!(business.hostSignal instanceof AbortSignal)||!isAbsolute(bootstrap.root))denied();
  const model=policy(bootstrap.model),generation=randomUUID(),lifetime=new AbortController();
  const signal=AbortSignal.any([startSignal,business.hostSignal,lifetime.signal]); signal.throwIfAborted();
  const leases=new Map<string,{lease:MainSessionBindingLease;sessionId:string;expiresAt:string;committed:boolean;timer:ReturnType<typeof setTimeout>}>();
  const streams=new Map<string,ParentStream>(),pending=new Map<number,AbortController>();
  let revision=0,lastCall=0,hello=false,closed=false,writeTail:Promise<unknown>=Promise.resolve();
  const assert=()=>{if(closed||signal.aborted)throw new MainIpcError('afos/main-ipc-cutoff');};
  const currentSnapshot=():MainSnapshot=>{const local=business.localState();return snapshot({revision:++revision,local:{project:{id:local.project.id,name:local.project.name},authority:local.authority,lastSyncAt:local.lastSyncAt},drafts:business.drafts().map(draftDto)});};
  const send=async(message:object)=>{assert();boundedJson(message);await endpoint.send(message);assert();};
  let releaseMessages=()=>{},releaseDisconnect=()=>{},startupDeadline:ReturnType<typeof setTimeout>|undefined;
  const close=async():Promise<void>=>{
    if(closed)return;closed=true;clearTimeout(startupDeadline);lifetime.abort(new MainIpcError('afos/main-ipc-cutoff'));
    releaseMessages();releaseDisconnect();signal.removeEventListener('abort',cutoff);
    for(const call of pending.values())call.abort();pending.clear();
    for(const entry of leases.values()){clearTimeout(entry.timer);entry.lease.dispose();}leases.clear();
    for(const stream of streams.values()){stream.abort.abort();void stream.iterator.return?.().catch(()=>undefined);}streams.clear();
    try{await endpoint.send({contractVersion:IPC_VERSION,kind:'cutoff',generation});}catch{/* The owner also observes disconnect. */}
  };
  const cutoff=()=>{void close();};
  const perform=async(name:Method,args:Record<string,unknown>,caller:AbortSignal):Promise<unknown>=>{
    assert();caller.throwIfAborted();
    const grant=await business.currentAuthority(caller);assert();caller.throwIfAborted();
    if(Date.parse(grant.expiresAt)<=Date.now())denied();
    if(name==='authority.current')return authority(grant);
    if(name==='state.refresh')return null;
    if(name==='materials.list')return (await business.materials(caller)).map(v=>({ ...source({materialId:v.materialId,revisionId:v.revisionId,sha256:v.sha256}),name:text(v.name,2048) }));
    if(name==='material.read')return business.readRevision(source(args.ref),caller);
    if(name==='run.authorize')return runDto(await business.authorize(sources(args.refs),businessId(args.operationId),caller));
    if(name==='run.release'){business.releaseRunAdmission(businessId(args.runId));return null;}
    if(name==='publication.prepare'){
      if(leases.size>=1)denied();const runId=businessId(args.runId),sessionId=businessId(args.sessionId);
      const lease=await business.prepareSessionBinding(runId,sessionId,caller);
      try{assert();caller.throwIfAborted();const ticket=randomUUID(),expiresAt=grant.expiresAt;
        const timer=setTimeout(()=>{const stale=leases.get(ticket);if(!stale)return;stale.lease.dispose();leases.delete(ticket);},Math.max(1,Math.min(Date.parse(expiresAt)-Date.now(),10000)));timer.unref();
        leases.set(ticket,{lease,sessionId,expiresAt,committed:false,timer});return {ticket,sessionId,expiresAt};
      }catch(error){lease.dispose();throw error;}
    }
    if(name==='publication.ack'||name==='publication.release'){
      const ticket=id(args.ticket),entry=leases.get(ticket);if(!entry)denied();
      if(name==='publication.release'){clearTimeout(entry.timer);entry.lease.dispose();leases.delete(ticket);return null;}
      if(entry.committed||Date.parse(entry.expiresAt)<=Date.now())denied();entry.lease.commit();entry.committed=true;
      try{
        const owned=await business.sessionRun(entry.sessionId,caller);assert();caller.throwIfAborted();
        if(leases.get(ticket)!==entry||Date.parse(entry.expiresAt)<=Date.now())denied();
        const expiresAt=new Date(Math.min(Date.parse(owned.expiresAt),Date.now()+60000)).toISOString();
        if(Date.parse(expiresAt)<=Date.now())denied();clearTimeout(entry.timer);entry.expiresAt=expiresAt;
        entry.timer=setTimeout(()=>{void close();},Date.parse(expiresAt)-Date.now());entry.timer.unref();
        return {sessionId:entry.sessionId,expiresAt};
      }catch(error){if(leases.get(ticket)===entry){clearTimeout(entry.timer);entry.lease.dispose();leases.delete(ticket);}throw error;}
    }
    if(name==='session.run')return runDto(await business.sessionRun(businessId(args.sessionId),caller));
    if(name==='session.read'){
      const value=await business.ownedSessionRead(businessId(args.sessionId),caller);assert();caller.throwIfAborted();
      if(value.signal.aborted)denied();
      return {sessionId:value.sessionId,expiresAt:value.expiresAt};
    }
    if(name==='snapshot.read'){
      const ref=record(args.ref,['materialId','revisionId']);return business.readPinnedSnapshot(businessId(args.sessionId),{materialId:businessId(ref.materialId),revisionId:businessId(ref.revisionId)},caller);
    }
    if(name==='draft.prepare')return business.prepareDraft(businessId(args.sessionId),text(args.content,65536),sources(args.refs),caller);
    if(name==='draft.edit')return draftDto(business.editDraft(businessId(args.draftId),text(args.content,65536)));
    if(name==='session.project'){business.projectSessionEvent(businessId(args.sessionId),eventDto(args.event));return null;}
    if(name==='session.cancel'){if(args.stopped!==false)denied();const sessionId=businessId(args.sessionId),draft=business.drafts().find(item=>item.sessionId===sessionId);
      if(!draft)denied();if(['completed_local','failed','interrupted','cancelled'].includes(draft.localExecution))return null;
      business.markCancellation(sessionId,false);return null;}
    if(name==='draft.archive'){const sha=source({materialId:'hash',revisionId:'hash',sha256:args.sha256}).sha256;
      await business.archiveFromUser(businessId(args.draftId),sha,caller);return null;}
    if(name==='model.open'){
      if(streams.size)denied();const sessionId=businessId(args.sessionId),request=fixedModelRequest(args.request),streamId=randomUUID(),abort=new AbortController();
      const modelSignal=AbortSignal.any([signal,abort.signal]);
      await business.sessionRun(sessionId,caller);assert();caller.throwIfAborted();
      streams.set(streamId,{iterator:business.modelBytes(sessionId,request,modelSignal)[Symbol.asyncIterator](),abort,busy:false,bytes:0,remainder:new Uint8Array()});return {streamId};
    }
    const streamId=id(args.streamId),stream=streams.get(streamId);if(!stream)denied();
    if(name==='model.close'){stream.abort.abort();streams.delete(streamId);void stream.iterator.return?.().catch(()=>undefined);return null;}
    if(name!=='model.next'||stream.busy)denied();stream.busy=true;
    try{
      if(!stream.remainder.length){const result=await stream.iterator.next();assert();caller.throwIfAborted();stream.abort.signal.throwIfAborted();
        if(result.done){streams.delete(streamId);return {done:true};}
        if(!(result.value instanceof Uint8Array)||!result.value.length)denied();stream.bytes+=result.value.byteLength;
        if(stream.bytes>IPC_MODEL_BYTES)denied();stream.remainder=result.value;}
      const chunk=stream.remainder.subarray(0,IPC_CHUNK_BYTES);stream.remainder=stream.remainder.subarray(chunk.length);
      return {done:false,chunk:Buffer.from(chunk).toString('base64')};
    }finally{stream.busy=false;}
  };
  const accept=async(input:unknown):Promise<void>=>{
    try{
      assert();boundedJson(input);
      const base=record(input,['contractVersion','kind'],['generation','callId','method','args']);if(base.contractVersion!==IPC_VERSION)denied();
      if(base.kind==='hello'){
        record(input,['contractVersion','kind']);if(hello)denied();hello=true;
        const initial=await business.currentAuthority(signal);assert();
        await send({contractVersion:IPC_VERSION,kind:'welcome',generation,bootstrap:{root:bootstrap.root,model,authority:authority(initial)},snapshot:currentSnapshot()});clearTimeout(startupDeadline);return;
      }
      if(base.kind==='cancel'){
        record(input,['contractVersion','kind','generation','callId']);if(base.generation!==generation)denied();pending.get(integer(base.callId))?.abort();return;
      }
      const request=record(input,['contractVersion','kind','generation','callId','method','args']);
      if(!hello||request.kind!=='request'||request.generation!==generation)denied();
      const callId=integer(request.callId),name=method(request.method),args=record(request.args,METHODS[name]);validateArgs(name,args);
      if(callId<=lastCall||pending.size>=IPC_MAX_PENDING)denied();lastCall=callId;
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);pending.set(callId,controller);
      const deadline=setTimeout(()=>{controller.abort();void close();},10000);deadline.unref();
      try{
        const writes=['run.authorize','run.release','publication.prepare','publication.ack','publication.release','draft.prepare','draft.edit','session.project','session.cancel','draft.archive','model.open'];
        const work=()=>perform(name,args,combined);
        let value:unknown;
        if(writes.includes(name)){const operation=writeTail.then(work);writeTail=operation.catch(()=>undefined);value=await operation;}else value=await work();
        assert();combined.throwIfAborted();
        await send({contractVersion:IPC_VERSION,kind:'reply',generation,callId,method:name,ok:true,value,snapshot:currentSnapshot()});
      }catch(error){
        if(!closed&&!signal.aborted&&!controller.signal.aborted)await send({contractVersion:IPC_VERSION,kind:'reply',generation,callId,method:name,ok:false,code:safeCode(error)});
      }finally{clearTimeout(deadline);pending.delete(callId);}
    }catch{await close();}
  };
  startupDeadline=setTimeout(cutoff,10000);startupDeadline.unref();
  releaseMessages=endpoint.messages(input=>{void accept(input);});releaseDisconnect=endpoint.disconnected(cutoff);
  signal.addEventListener('abort',cutoff,{once:true});if(signal.aborted)await close();
  return Object.freeze({generation,close});
}

interface Pending { readonly name:Method; readonly resolve:(value:unknown)=>void; readonly reject:(error:MainIpcError)=>void; readonly release:()=>void; }
/** Child proxy exposes only fixed business operations; it never receives an OAuth/provider credential. */
export async function connectMainBusinessIpc(endpoint:MainIpcEndpoint,startSignal:AbortSignal):Promise<{
  readonly business:MainBusinessCapabilities;readonly bootstrap:MainIpcBootstrap;readonly authority:GatewayAuthoritySnapshot;readonly signal:AbortSignal;close():void;
}> {
  const lifetime=new AbortController(),signal=AbortSignal.any([startSignal,lifetime.signal]),epoch=Object.freeze({});
  let generation:string|undefined,current:MainSnapshot|undefined,sequence=0,closed=false;
  const pending=new Map<number,Pending>(),cancelled=new Set<number>();
  let resolveWelcome!:(value:{bootstrap:MainIpcBootstrap;authority:GatewayAuthoritySnapshot})=>void,rejectWelcome!:(error:MainIpcError)=>void;
  const welcome={promise:new Promise<{bootstrap:MainIpcBootstrap;authority:GatewayAuthoritySnapshot}>((resolve,reject)=>{resolveWelcome=resolve;rejectWelcome=reject;}),resolve:(value:{bootstrap:MainIpcBootstrap;authority:GatewayAuthoritySnapshot})=>resolveWelcome(value),reject:(error:MainIpcError)=>rejectWelcome(error)};
  const assert=()=>{if(closed||signal.aborted||!generation)throw new MainIpcError('afos/main-ipc-cutoff');};
  let releaseMessages=()=>{},releaseDisconnect=()=>{};
  const close=()=>{
    if(closed)return;closed=true;lifetime.abort(new MainIpcError('afos/main-ipc-cutoff'));releaseMessages();releaseDisconnect();
    signal.removeEventListener('abort',close);for(const entry of pending.values()){entry.release();entry.reject(new MainIpcError('afos/main-ipc-cutoff'));}pending.clear();
    current=undefined;welcome.reject(new MainIpcError('afos/main-ipc-cutoff'));
  };
  const accept=(input:unknown)=>{
    try{
      boundedJson(input);const base=record(input,['contractVersion','kind'],['generation','bootstrap','snapshot','callId','method','ok','value','code']);
      if(base.contractVersion!==IPC_VERSION)denied();
      if(base.kind==='welcome'){
        const v=record(input,['contractVersion','kind','generation','bootstrap','snapshot']);if(generation||closed)denied();
        const init=record(v.bootstrap,['root','model','authority']),root=text(init.root,4096);if(!isAbsolute(root))denied();
        const initial=authority(init.authority);if(Date.parse(initial.expiresAt)<=Date.now())denied();
        generation=id(v.generation);current=snapshot(v.snapshot);welcome.resolve({bootstrap:Object.freeze({root,model:policy(init.model)}),authority:initial});return;
      }
      if(base.kind==='cutoff'){record(input,['contractVersion','kind','generation']);if(base.generation!==generation)denied();close();return;}
      assert();if(base.generation!==generation||base.kind!=='reply')denied();
      const callId=integer(base.callId);if(cancelled.has(callId)){cancelled.delete(callId);return;}
      const entry=pending.get(callId);if(!entry||base.method!==entry.name)denied();
      if(base.ok===false){record(input,['contractVersion','kind','generation','callId','method','ok','code']);
        const code=text(base.code,128);if(!/^(?:afos|enterprise|broker)\/[a-z-]{1,80}$/u.test(code))denied();pending.delete(callId);entry.release();entry.reject(new MainIpcError(code));return;}
      const v=record(input,['contractVersion','kind','generation','callId','method','ok','value','snapshot']);if(v.ok!==true)denied();
      const next=snapshot(v.snapshot);if(!current||next.revision>current.revision)current=next;
      pending.delete(callId);entry.release();entry.resolve(v.value);
    }catch{close();}
  };
  releaseMessages=endpoint.messages(accept);releaseDisconnect=endpoint.disconnected(close);signal.addEventListener('abort',close,{once:true});
  const startupTimer=setTimeout(close,10000);startupTimer.unref();
  try{signal.throwIfAborted();await endpoint.send({contractVersion:IPC_VERSION,kind:'hello'});}
  catch{close();}
  let initialized:{bootstrap:MainIpcBootstrap;authority:GatewayAuthoritySnapshot};
  try{initialized=await welcome.promise;}finally{clearTimeout(startupTimer);}
  const call=(name:Method,args:object,caller:AbortSignal):Promise<unknown>=>{
    assert();caller.throwIfAborted();boundedJson(args);if(pending.size>=IPC_MAX_PENDING||sequence>=1000000)denied();const callId=++sequence;
    return new Promise((resolve,reject)=>{
      const abort=()=>{if(closed||!pending.delete(callId))return;release();cancelled.add(callId);if(cancelled.size>32)close();
        void endpoint.send({contractVersion:IPC_VERSION,kind:'cancel',generation,callId}).catch(close);reject(new MainIpcError('afos/main-ipc-outcome-unknown'));};
      const timer=setTimeout(abort,10000);timer.unref();
      const release=()=>{clearTimeout(timer);caller.removeEventListener('abort',abort);};
      pending.set(callId,{name,resolve,reject,release});caller.addEventListener('abort',abort,{once:true});
      if(caller.aborted){abort();return;}
      void endpoint.send({contractVersion:IPC_VERSION,kind:'request',generation,callId,method:name,args}).catch(()=>{abort();close();});
    }).then(value=>{assert();caller.throwIfAborted();return value;});
  };
  const cached=()=>{assert();if(!current)denied();return current;};
  const freshSource=async(value:Promise<unknown>):Promise<EnterpriseSourceRef&{readonly text:string}>=>{
    const v=record(await value,['materialId','revisionId','sha256','text']);return Object.freeze({...source({materialId:v.materialId,revisionId:v.revisionId,sha256:v.sha256}),text:text(v.text)});
  };
  const noSyncWrite=():never=>{throw new MainIpcError('afos/main-ipc-write-ack-required');};
  const business:MainBusinessCapabilities={
    hostSignal:signal,currentAuthority:async caller=>authority(await call('authority.current',{},caller)),
    localState:()=>cached().local,drafts:()=>cached().drafts,
    authorize:async(refs,operationId,caller)=>run(await call('run.authorize',{refs,operationId},caller)),
    releaseRunAdmission:noSyncWrite,projectSessionEvent:noSyncWrite,editDraft:noSyncWrite,markCancellation:noSyncWrite,
    prepareSessionBinding:async(runId,sessionId,caller)=>{
      const prepared=record(await call('publication.prepare',{runId,sessionId},caller),['ticket','sessionId','expiresAt']);
      const ticket=id(prepared.ticket),owned=businessId(prepared.sessionId);let expiresAt=Date.parse(stamp(prepared.expiresAt)),status:'prepared'|'consumed'|'ready'|'disposed'='prepared';
      if(owned!==sessionId||expiresAt<=Date.now())denied();
      const active=()=>{assert();if(status!=='ready'||expiresAt<=Date.now())denied();};
      return Object.freeze<MainSessionBindingLease>({signal,commit:()=>{assert();caller.throwIfAborted();if(status!=='prepared'||expiresAt<=Date.now())denied();status='consumed';},
        dispose:()=>{status='disposed';},assertReady:active,
        acknowledge:async ackSignal=>{if(status!=='consumed')denied();const ack=record(await call('publication.ack',{ticket},ackSignal),['sessionId','expiresAt']);
          assert();if(status!=='consumed'||ack.sessionId!==sessionId)denied();expiresAt=Date.parse(stamp(ack.expiresAt));status='ready';active();},
        release:async releaseSignal=>{status='disposed';await call('publication.release',{ticket},releaseSignal);}});
    },
    sessionRun:async(sessionId,caller)=>run(await call('session.run',{sessionId},caller)),
    ownedSessionRead:async(sessionId,caller)=>{const v=record(await call('session.read',{sessionId},caller),['sessionId','expiresAt']);
      if(v.sessionId!==sessionId)denied();return Object.freeze({sessionId,expiresAt:stamp(v.expiresAt),epoch,signal});},
    readPinnedSnapshot:(sessionId,ref,caller)=>freshSource(call('snapshot.read',{sessionId,ref},caller)),
    readRevision:(ref,caller)=>freshSource(call('material.read',{ref},caller)),
    materials:async caller=>{const list=await call('materials.list',{},caller);if(!Array.isArray(list)||list.length>100)denied();
      return Object.freeze(list.map((value):EnterpriseMaterialView=>{const v=record(value,['materialId','revisionId','sha256','name']);
        return Object.freeze({...source({materialId:v.materialId,revisionId:v.revisionId,sha256:v.sha256}),name:text(v.name,2048)});}));},
    prepareDraft:async(sessionId,content,refs,caller)=>{const v=record(await call('draft.prepare',{sessionId,content,refs},caller),['text','sources','status']);
      if(v.status!=='local-draft')denied();return Object.freeze({text:text(v.text,65536),sources:sources(v.sources),status:'local-draft'});},
    archiveFromUser:async(draftId,sha256,caller)=>call('draft.archive',{draftId,sha256},caller),
    asyncAccess:Object.freeze<MainAsyncBusinessAccess>({refreshLocalState:async caller=>{await call('state.refresh',{},caller);},
      editDraft:async(draftId,content,caller)=>draft(await call('draft.edit',{draftId,content},caller)),
      projectSessionEvent:async(sessionId,event,caller)=>{const value=eventDto({type:event.type,seq:event.seq,time:event.time,data:{turn:event.data.turn,
        ...(event.data.reason?{reason:{kind:event.data.reason.kind}}:{})}});await call('session.project',{sessionId,event:value},caller);},
      markCancellation:async(sessionId,stopped,caller)=>{await call('session.cancel',{sessionId,stopped},caller);},
      releaseRunAdmission:async(runId,caller)=>{await call('run.release',{runId},caller);}}),
    modelBytes:async function*(sessionId,request,caller){
      const opened=record(await call('model.open',{sessionId,request},caller),['streamId']),streamId=id(opened.streamId);let total=0;
      try{while(true){const value=record(await call('model.next',{streamId},caller),['done'],['chunk']);
        if(value.done===true){if(value.chunk!==undefined)denied();break;}if(value.done!==false)denied();
        const encoded=text(value.chunk,IPC_CHUNK_BYTES*2);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))denied();
        const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.byteLength>IPC_CHUNK_BYTES||bytes.toString('base64')!==encoded)denied();
        total+=bytes.byteLength;if(total>IPC_MODEL_BYTES)denied();assert();caller.throwIfAborted();yield new Uint8Array(bytes);}
      }finally{if(!closed)try{await call('model.close',{streamId},signal);}catch{/* A completed stream is already closed; no retry of model writes. */}}
    },
  };
  return Object.freeze({business:Object.freeze(business),bootstrap:initialized.bootstrap,authority:initialized.authority,signal,close});
}
