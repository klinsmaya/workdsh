import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { AgentBridge, digest } from '../core.ts';

function page(rows,after) {
  const selected=rows.filter(row=>!after||row.id>after).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,51);
  return {items:selected.slice(0,50),nextPosition:selected.length>50?selected[49].id:null};
}
function fixture() {
  const evidence = {issuer:'https://enterprise.example/api',principalId:'alice',clientId:'desktop',grantId:'grant1',issuedAt:Date.now(),tokenId:'token1',expiresAt:Date.now()+3600000};
  const allowed = new Set(['alice:p1','bob:p2','mallory:p3']);
  const projects = [{id:'p1',organizationId:'org1',name:'Allowed'}, {id:'p2',organizationId:'org1',name:'Other project'}, {id:'p3',organizationId:'org2',name:'Other organization'}];
  const material = {id:'m1',projectId:'p1',revisionId:'rev1',name:'Demonstration source',text:'Example source, requires human review.',hash:digest('Example source, requires human review.')};
  const tables = {runs:new Map(),uploads:new Map(),receipts:new Map(),artifacts:new Map(),commitRequests:new Map()};
  const audit=[];
  let active = true;
  let tail = Promise.resolve();
  const store = {
    tokenActive:async()=>active,
    deviceId:async()=>'device1',
    projects:async(e,after)=>page(projects.filter(p=>allowed.has(`${e.principalId}:${p.id}`)),after),
    project:async(e,id)=>allowed.has(`${e.principalId}:${id}`)?projects.find(p=>p.id===id):undefined,
    materials:async(e,id,after)=>page(allowed.has(`${e.principalId}:${id}`)&&id==='p1'?[structuredClone(material)]:[],after),
    material:async(e,id,revisionId)=>allowed.has(`${e.principalId}:${material.projectId}`)&&id===material.id&&revisionId===material.revisionId?structuredClone(material):undefined,
    get:async(t,id)=>structuredClone(tables[t].get(id)),
    insert:async(t,row)=>{if(tables[t].has(row.id))throw new Error('unique conflict');tables[t].set(row.id,structuredClone(row));},
    replaceUpload:async row=>tables.uploads.set(row.id,structuredClone(row)),
    transaction:callback=>{
      const operation=tail.then(async()=>{
        const backup=structuredClone(tables);
        try{return await callback(store);}catch(error){for(const key of Object.keys(tables))tables[key]=backup[key];throw error;}
      });tail=operation.catch(()=>{});return operation;
    },
    audit:async e=>audit.push(e),
  };
  const bridge=new AgentBridge(store,'fixed-release');
  const inputs=[{materialId:material.id,revisionId:material.revisionId,sha256:material.hash}];
  const authorize=()=>bridge.dispatch(evidence,'runs.authorizeLocal',{projectId:'p1',releaseId:'fixed-release',inputRefs:inputs,clientRequestId:'run-key'});
  async function staged(run,content='Draft: pending human review.') {
    const upload=await bridge.dispatch(evidence,'artifacts.stageUpload',{runId:run.runId,attempt:run.attempt,mime:'text/plain',bytes:Buffer.byteLength(content),sha256:digest(content)});
    await bridge.dispatch(evidence,'artifacts.upload',{runId:run.runId,attempt:run.attempt,uploadId:upload.uploadId,content});
    return {runId:run.runId,attempt:run.attempt,uploadId:upload.uploadId,inputRefs:inputs,clientRequestId:'commit-key'};
  }
  return {bridge,store,projects,evidence,inputs,material,allowed,tables,audit,authorize,staged,revoke:()=>{active=false;}};
}

test('AFOS-CHECK-B01 authorized source to immutable draft and server receipt',async()=>{
  const f=fixture();
  assert.equal((await f.bridge.dispatch(f.evidence,'projects.listAllowed',{})).items.length,1);
  const source=await f.bridge.dispatch(f.evidence,'materials.readRevision',{materialId:'m1',revisionId:'rev1'});
  assert.equal(digest(source.text),source.sha256);
  const run=await f.authorize();
  const args=await f.staged(run);
  const receipts=await Promise.all([f.bridge.dispatch(f.evidence,'artifacts.commitDraft',args),f.bridge.dispatch(f.evidence,'artifacts.commitDraft',args)]);
  assert.deepEqual(receipts[0],receipts[1]);
  assert.equal(f.tables.artifacts.size,1);
  assert.equal((await f.bridge.dispatch(f.evidence,'runs.getReceipt',{runId:run.runId,projectId:'p1'})).status,'archived');
  const artifact=[...f.tables.artifacts.values()][0];assert.equal(artifact.status,'draft-needs-review');assert.deepEqual(artifact.sources,f.inputs.map(({sha256,...ref})=>({...ref,hash:sha256})));
});

test('AFOS-CHECK-B14 current identity is server-bound and rejects actor or project forgery',async()=>{
  const f=fixture();const snapshot=await f.bridge.dispatch(f.evidence,'identity.current',{projectId:'p1'});
  assert.deepEqual(snapshot.binding,{issuer:f.evidence.issuer,subject:'alice',organizationId:'org1',deviceId:'device1'});
  assert.deepEqual(snapshot.permissions,{read:true,archive:true});assert.match(snapshot.authorizationRevision,/^[a-f0-9]{64}$/);
  assert.ok(Date.parse(snapshot.expiresAt)>Date.now()&&Date.parse(snapshot.expiresAt)<=Date.now()+5000);
  await assert.rejects(f.bridge.dispatch(f.evidence,'identity.current',{projectId:'p1',role:'admin'}),/afos\/forged-context/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'identity.current',{projectId:'p2'}),/afos\/project-denied/);
  f.allowed.delete('alice:p1');await assert.rejects(f.bridge.dispatch(f.evidence,'identity.current',{projectId:'p1'}),/afos\/project-denied/);
});

test('AFOS-CHECK-B15 recovery rechecks release, source pins and device; receipt is project-bound',async()=>{
  const f=fixture();const run=await f.authorize();
  assert.deepEqual(await f.bridge.dispatch(f.evidence,'runs.getAuthorization',{runId:run.runId}),run);
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.getReceipt',{runId:run.runId,projectId:'p2'}),/afos\/run-project-mismatch/);
  f.store.deviceId=async()=>'other-device';
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.getAuthorization',{runId:run.runId}),/afos\/run-binding-changed/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.getReceipt',{runId:run.runId,projectId:'p1'}),/afos\/run-binding-changed/);
  f.store.deviceId=async()=>'device1';f.material.text='changed source';
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.getAuthorization',{runId:run.runId}),/afos\/input-revoked-or-changed/);
  const newRelease=new AgentBridge(f.store,'different-release');
  await assert.rejects(newRelease.dispatch(f.evidence,'runs.getAuthorization',{runId:run.runId}),/afos\/run-binding-changed/);
});

test('AFOS-CHECK-B12 commit request key is organization/action scoped across different runs',async()=>{
  const f=fixture();const first=await f.authorize();
  await f.bridge.dispatch(f.evidence,'artifacts.commitDraft',await f.staged(first));
  const second=await f.bridge.dispatch(f.evidence,'runs.authorizeLocal',{projectId:'p1',releaseId:'fixed-release',inputRefs:f.inputs,clientRequestId:'second-run'});
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.commitDraft',await f.staged(second)),/afos\/idempotency-conflict/);
  assert.equal(f.tables.artifacts.size,1);assert.equal(f.tables.receipts.size,1);assert.equal(f.tables.commitRequests.size,1);
});

test('AFOS-CHECK-B13 public run ID fields respect the supplied schema length limits',async()=>{
  const f=fixture();assert.throws(()=>new AgentBridge(f.store,'r'.repeat(129)),/afos\/invalid-id/);
  f.projects[0].id='p'.repeat(129);f.allowed.add(`alice:${f.projects[0].id}`);
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.authorizeLocal',{projectId:f.projects[0].id,releaseId:'fixed-release',inputRefs:f.inputs,clientRequestId:'long-project'}),/afos\/invalid-id/);
});

test('AFOS-CHECK-B08 authorization satisfies the supplied independent JSON schema without private row fields',async()=>{
  const f=fixture();const run=await f.authorize();
  const ajv=new Ajv2020();ajv.addFormat('date-time',value=>/^\d{4}-\d{2}-\d{2}T/u.test(value)&&Number.isFinite(Date.parse(value)));
  const schema=JSON.parse(await readFile(new URL('../../../contracts/run-authorization.schema.json',import.meta.url),'utf8'));
  const validate=ajv.compile(schema);assert.equal(validate(run),true,JSON.stringify(validate.errors));
  assert.equal(run.binding.subject,'alice');assert.equal(run.binding.deviceId,'device1');
  assert.equal('requestHash' in run,false);assert.equal('principalId' in run,false);
  const receipt=await f.bridge.dispatch(f.evidence,'artifacts.commitDraft',await f.staged(run));
  for(const key of ['receiptId','runId','attempt','artifactId','revisionId','sha256','committedAt'])assert.ok(key in receipt);
  assert.equal('requestHash' in receipt,false);
});

test('AFOS-CHECK-B09 unexpected command/URL and nested input fields are rejected rather than ignored',async()=>{
  const f=fixture();
  for(const key of ['url','cmd','unregistered'])await assert.rejects(f.bridge.dispatch(f.evidence,'projects.listAllowed',{[key]:'forged'}),/afos\/unexpected-parameter/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.authorizeLocal',{projectId:'p1',releaseId:'fixed-release',inputRefs:[{...f.inputs[0],path:'/private'}],clientRequestId:'key'}),/afos\/unexpected-parameter/);
  const run=await f.authorize();
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.stageUpload',{runId:run.runId,attempt:2,mime:'text/plain',bytes:1,sha256:digest('x')}),/afos\/attempt-mismatch/);
});

test('AFOS-CHECK-B10 same subject/organization/request key cannot authorize a different project',async()=>{
  const f=fixture();await f.authorize();f.allowed.add('alice:p2');f.material.projectId='p2';
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.authorizeLocal',{projectId:'p2',releaseId:'fixed-release',inputRefs:f.inputs,clientRequestId:'run-key'}),/afos\/idempotency-conflict/);
  assert.equal(f.tables.runs.size,1);
});

test('AFOS-CHECK-B11 cursor is authenticated and bound to current subject, organization and query',async()=>{
  const f=fixture();
  for(let i=0;i<55;i++){const id=`page${i}`;f.projects.push({id,organizationId:'org1',name:id});f.allowed.add(`alice:${id}`);f.allowed.add(`bob:${id}`);}
  const page=await f.bridge.dispatch(f.evidence,'projects.listAllowed',{});assert.equal(page.items.length,50);assert.ok(page.nextCursor);
  const second=await f.bridge.dispatch(f.evidence,'projects.listAllowed',{cursor:page.nextCursor});assert.equal(second.items.length,6);
  await assert.rejects(f.bridge.dispatch({...f.evidence,principalId:'bob'},'projects.listAllowed',{cursor:page.nextCursor}),/afos\/invalid-cursor/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'materials.listAllowed',{projectId:'p1',cursor:page.nextCursor}),/afos\/invalid-cursor/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'projects.listAllowed',{cursor:'50'}),/afos\/invalid-cursor/);
});

test('AFOS-CHECK-B02 same-organization cross-project and second-organization denial',async()=>{
  const f=fixture();
  for(const projectId of ['p2','p3']) await assert.rejects(f.bridge.dispatch(f.evidence,'materials.listAllowed',{projectId}),/afos\/project-denied/);
  const run=await f.authorize();
  await assert.rejects(f.bridge.dispatch({...f.evidence,principalId:'bob'},'runs.getReceipt',{runId:run.runId,projectId:'p1'}),/afos\/run-not-found/);
});

test('AFOS-CHECK-B03 revocation rejects reads, archive and receipt replay',async()=>{
  const f=fixture();const run=await f.authorize();const args=await f.staged(run);
  f.allowed.delete('alice:p1');
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.commitDraft',args),/afos\/project-denied/);
  assert.equal(f.tables.artifacts.size,0);
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.getReceipt',{runId:run.runId,projectId:'p1'}),/afos\/project-denied/);
  f.revoke();await assert.rejects(f.bridge.dispatch(f.evidence,'projects.listAllowed',{}),/afos\/access-revoked/);
});

test('AFOS-CHECK-B04 forged identity, generic CRUD and input fabrication rejected',async()=>{
  const f=fixture();
  for(const key of ['actor','organizationId','owner','endpoint','path','objectKey'])await assert.rejects(f.bridge.dispatch(f.evidence,'projects.listAllowed',{[key]:'forged'}),/afos\/forged-context/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'users.update',{}),/afos\/action-not-allowed/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.authorizeLocal',{projectId:'p1',releaseId:'fixed-release',inputRefs:[{...f.inputs[0],sha256:'0'.repeat(64)}],clientRequestId:'key'}),/afos\/input-denied/);
});

test('AFOS-CHECK-B05 missing upload, changed source and duplicate-key conflicts fail closed',async()=>{
  const f=fixture();const run=await f.authorize();const args=await f.staged(run);
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.commitDraft',{...args,inputRefs:[{...f.inputs[0],sha256:'0'.repeat(64)}]}),/afos\/source-mismatch/);
  await f.bridge.dispatch(f.evidence,'artifacts.commitDraft',args);
  const other=await f.staged(run,'Other edited draft');
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.commitDraft',other),/afos\/idempotency-conflict/);
  assert.equal(f.tables.artifacts.size,1);
  const upload=await f.bridge.dispatch(f.evidence,'artifacts.stageUpload',{runId:run.runId,attempt:run.attempt,mime:'text/plain',bytes:1,sha256:digest('x')});
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.commitDraft',{...args,uploadId:upload.uploadId}),/afos\/upload-incomplete/);
});

test('AFOS-CHECK-B06 release pin, quotas, actual content digest and audit privacy',async()=>{
  const f=fixture();const run=await f.authorize();
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.authorizeLocal',{projectId:'p1',releaseId:'other',inputRefs:f.inputs,clientRequestId:'other'}),/afos\/release-not-allowed/);
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.stageUpload',{runId:run.runId,attempt:run.attempt,mime:'text/plain',bytes:2000000,sha256:digest('x')}),/afos\/invalid-upload/);
  const upload=await f.bridge.dispatch(f.evidence,'artifacts.stageUpload',{runId:run.runId,attempt:run.attempt,mime:'text/plain',bytes:1,sha256:digest('x')});
  await assert.rejects(f.bridge.dispatch(f.evidence,'artifacts.upload',{runId:run.runId,attempt:run.attempt,uploadId:upload.uploadId,content:'z'}),/afos\/upload-integrity/);
  assert.ok(!JSON.stringify(f.audit).includes('Example source'));
  assert.ok(!JSON.stringify(f.audit).includes('token1'));
});

test('AFOS-CHECK-B07 durable archive receipt survives expired task and changed source, with current project check',async()=>{
  const f=fixture();const run=await f.authorize();const args=await f.staged(run);
  const receipt=await f.bridge.dispatch(f.evidence,'artifacts.commitDraft',args);
  f.tables.runs.get(run.runId).expiresAt=Date.now()-1;
  f.material.text='changed';
  assert.deepEqual((await f.bridge.dispatch(f.evidence,'runs.getReceipt',{runId:run.runId,projectId:'p1'})).receipt,receipt);
  f.allowed.delete('alice:p1');
  await assert.rejects(f.bridge.dispatch(f.evidence,'runs.getReceipt',{runId:run.runId,projectId:'p1'}),/afos\/project-denied/);
});
