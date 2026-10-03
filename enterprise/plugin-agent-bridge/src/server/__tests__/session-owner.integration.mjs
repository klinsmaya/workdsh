import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture } from './desktop-fixture.mjs';
import { bootEnterpriseCore } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/assembly.js';
import { fixedEnterpriseComposition } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/profile-policy.js';

// Actual original Core/Agent/JSONL/JSON storage. Server identity/model replies
// remain test fixtures; this does not certify NocoBase or a native desktop.
const require=createRequire(fileURLToPath(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/package.json',import.meta.url)));
const { runtimeBindingDomainSpec }=await import(pathToFileURL(require.resolve('workdsh-plugin-access')).href);
const policy={provider:'afos-managed',model:'fixed-model',maxTokens:64};
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const signal=()=>AbortSignal.timeout(5000);

async function composed(options={}){
 let ctx,root,models=0;
 const f=await fixture({base:options.base,keepBase:options.keepBase,
  stopHost:async()=>{if(ctx){const prior=ctx;ctx=undefined;await prior.fiber.dispose();}},
  model:async()=>{models++;return [{type:'finish',reason:{kind:'stop'}}];}});
 await f.ready();
 f.capability({ingressValidated:true,sandbox:'full'}); // Main fixture only.
 f.startHook(async(lifetime,layout,authority,business)=>{
  root=layout.profile;
  ctx=await bootEnterpriseCore({root,binding:authority.binding,projectId:authority.project.id,business,model:policy,signal:lifetime});
 });
 await f.main.startHost();
 const invoke=(method,payload={})=>ctx.afosDraftRuntime.invoke('afos/drafts/'+method,payload,signal());
 let cookie;
 const rpc=async(method,payload={})=>{
  const base='http://127.0.0.1:'+ctx.webServer.port;
  if(!cookie){
   const release=ctx.webServer.register({kind:'exact',path:'/',handler(req,res){if(ctx.connection.authorizeIndex(req,res)){res.writeHead(200);res.end('owned test entry');}}});
   try{const login=await fetch(ctx.connection.authenticatedUrl(base+'/'),{redirect:'manual',signal:signal()});assert.equal(login.status,303);cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);}
   finally{release();}
  }
  const response=await fetch(base+'/api/'+method,{method:'POST',headers:{cookie,'content-type':'application/json'},
   body:JSON.stringify({type:'client-request',rpcId:'session-owner-test',method,payload}),signal:signal()});
  if(response.status!==200)return {status:response.status};
  return (await response.json()).result;
 };
 return {...f,ctx:()=>ctx,root:()=>root,models:()=>models,invoke,rpc};
}

async function persisted(f,ids){
 const persistence=f.ctx().sessionPersistence;
 assert.equal(persistence.name,'session-persistence-jsonl');
 const domain=f.ctx().storageDomain.get(runtimeBindingDomainSpec.name);assert.ok(domain);
 const owners=domain.table('sessions');
 const result=[];
 for(const id of ids){
  const handle=await persistence.open(id,'read');
  let logical;
  try{logical={header:handle.header,events:(await handle.read()).events};assert.equal(handle.header.id,id);}
  finally{await handle.close();}
  const path=await persistence.resolveCurrentLog(id);assert.equal(typeof path,'string');
  const within=relative(join(f.root(),'sessions'),path);assert.ok(within&&!within.startsWith('..')&&!isAbsolute(within));
  const info=await lstat(path);assert.equal(info.isFile(),true);assert.equal(info.isSymbolicLink(),false);assert.ok(info.size>0&&info.size<65536);
  const raw=await readFile(path),owner=f.ctx().workdshAccess.sessionOwner(id)??null;
  assert.deepEqual(owners.get(id)??null,owner);
  result.push({id,owner,logicalSha256:sha(JSON.stringify(logical)),file:{relativePath:within,bytes:raw.length,mode:info.mode&0o777,sha256:sha(raw)}});
 }
 return result;
}

async function denyCallerSelections(f,ids){
 const models=f.models(),runs=f.tables.runs.size,agents=f.ctx().agents.list().length;
 const state=await f.rpc('afos/drafts/state');assert.equal(state.ok,true,JSON.stringify(state));
 let rejected=0;
 for(const id of ids){
  for(const extension of [{sessionId:id},{resumeSessionId:id},{owner:{principalId:'alice',sessionId:id}}]){
   const result=await f.rpc('afos/drafts/start',{sources:[f.ref],goal:'Caller cannot adopt history.',operationId:'forged-'+randomUUID(),...extension});
   assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.error.code,'afos/drafts-operation-denied');rejected++;
  }
  for(const method of ['session/create','session/restore','sessionController/create']){
   const result=await f.rpc(method,{sessionId:id,owner:'alice'});
   assert.ok(result.status===404||result.ok===false,JSON.stringify(result));rejected++;
  }
  const legacy=await f.rpc('afos/createSession',{sessionId:id});assert.equal(legacy.ok,false,JSON.stringify(legacy));rejected++;
 }
 const legacy=await f.rpc('afos/createSession',{});assert.equal(legacy.ok,false);assert.equal(legacy.error.code,'afos/profile-select-materials-required');rejected++;
 assert.equal(f.models(),models);assert.equal(f.tables.runs.size,runs);assert.equal(f.ctx().agents.list().length,agents);
 assert.equal(f.ctx().get('sessionController'),undefined);assert.equal(f.ctx().get('workdshSessionAccess'),undefined);
 assert.equal(fixedEnterpriseComposition().autoBindPersonalSessions,false);
 return rejected;
}

if(process.env.AFOS_AT16_COLD_BASE){
 test('AT16-CHILD fresh process loads actual owners and refuses caller adoption',{timeout:20000},async()=>{
  const f=await composed({base:process.env.AFOS_AT16_COLD_BASE,keepBase:true});
  try{
   const expected=JSON.parse(await readFile(join(f.base,'at16.expected.json'),'utf8'));
   assert.notEqual(process.pid,expected.parentPid);assert.equal(process.ppid,expected.parentPid);
   assert.equal(f.root(),expected.profileRoot);assert.equal(f.ctx().agents.list().length,0);assert.equal(f.ctx().sessions.list().length,0);assert.equal(f.models(),0);
   const before=await persisted(f,expected.ids);assert.deepEqual(before,expected.before);
   const rejected=await denyCallerSelections(f,expected.ids);
   assert.deepEqual(await persisted(f,expected.ids),before);
   assert.equal(f.ctx().agents.list().length,0);assert.equal(f.ctx().sessions.list().length,0);assert.equal(f.models(),0);
   console.log('AT16_COLD '+JSON.stringify({pid:process.pid,parentPid:process.ppid,rejected,ownersAndPhysicalBytesUnchanged:true,agents:0,sessions:0,models:0}));
  }finally{await f.cleanup();}
 });
}else{
 test('AT16 actual fixed Core rejects existing and ownerless ids across cold process',{timeout:45000},async()=>{
  const f=await composed();let child;
  try{
   const publications=[];
   const release=f.ctx().on('agent/created',({agent})=>{publications.push({id:String(agent.id),owner:f.ctx().workdshAccess.sessionOwner(String(agent.id))});});
   let started;
   try{started=await f.invoke('start',{sources:[f.ref],goal:'Owned persisted Session positive control.',operationId:'trusted-'+randomUUID()});}
   finally{release();}
   assert.equal(started.ok,true,JSON.stringify(started));
   const owned=started.value.sessionId,agent=f.ctx().agents.get(owned);assert.ok(agent);
   await agent.whenIdle();await f.ctx().sessionPersistence.flush();
   assert.equal(f.models(),1);assert.equal(publications.length,1);assert.equal(publications[0].id,owned);
   assert.equal(publications[0].owner.ownerPrincipalId,'alice');assert.equal(publications[0].owner.organizationId,'org1');
   const foreign='foreign-'+randomUUID(),orphan='ownerless-'+randomUUID(),ids=[owned,foreign,orphan];
   for(const id of [foreign,orphan]){
    const handle=await f.ctx().sessionPersistence.create({...agent.session.header,id});
    try{await handle.flush();}finally{await handle.close();}
   }
   // Controlled existing foreign data is seeded through the real public domain.
   // This is fixture preparation, not a caller-facing trusted bind operation.
   const domain=f.ctx().storageDomain.get(runtimeBindingDomainSpec.name);assert.ok(domain);
   await domain.table('sessions').put(foreign,{...publications[0].owner,sessionId:foreign,ownerPrincipalId:'bob',revision:'fixture-existing-foreign-owner'});
   assert.equal(f.ctx().workdshAccess.sessionOwner(orphan),undefined);
   const before=await persisted(f,ids),rejected=await denyCallerSelections(f,ids);
   assert.deepEqual(await persisted(f,ids),before);
   const actor=await f.ctx().workdshIdentity.resolve({sessionId:foreign},signal());
   await assert.rejects(f.ctx().workdshAccess.resolveRuntime(actor,{sessionId:foreign,runtimeId:'fixture-current',isolation:'local-trusted'},signal()));
   await assert.rejects(f.ctx().workdshAccess.resolveRuntime(actor,{sessionId:orphan,runtimeId:'fixture-current',isolation:'local-trusted'},signal()));
   assert.deepEqual(await persisted(f,ids),before);
   const expected={ids,before,profileRoot:f.root(),parentPid:process.pid};
   await writeFile(join(f.base,'at16.expected.json'),JSON.stringify(expected)+'\n',{mode:0o600,flag:'wx'});
   await f.main.suspend();
   assert.equal(f.ctx(),undefined);
   const env={PATH:process.env.PATH,LANG:'C.UTF-8',HOME:f.base,TMPDIR:process.env.TMPDIR,
    AFOS_AT16_COLD_BASE:f.base,DSH_TELEMETRY_DISABLED:'1'};
   child=spawn(process.execPath,['--experimental-transform-types','--test','--test-isolation=none','--test-concurrency=1',fileURLToPath(import.meta.url)],{env,stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';const capture=(kind,data)=>{if(kind==='stdout')stdout+=data;else stderr+=data;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>262144)child.kill('SIGKILL');};
   child.stdout.on('data',b=>capture('stdout',b));child.stderr.on('data',b=>capture('stderr',b));
   const deadline=setTimeout(()=>child.kill('SIGKILL'),20000);deadline.unref();
   let outcome;
   try{outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}finally{clearTimeout(deadline);}
   assert.deepEqual(outcome,{code:0,signal:null},stdout+stderr);assert.ok(stdout.includes('AT16_COLD '),stdout+stderr);
   console.log(stdout.trim());
   console.log('AT16_PARENT '+JSON.stringify({pid:process.pid,childPid:child.pid,rejected,normalAgentPublishedWithOwner:true,ownersAndPhysicalBytesUnchanged:true,fixtureIdentity:true,formalAT16:'NOT_RUN'}));
  }finally{
   if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   await f.cleanup();
  }
 });
}
