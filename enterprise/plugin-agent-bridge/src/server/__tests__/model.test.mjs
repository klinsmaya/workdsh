import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHash } from 'node:crypto';
import { NocoBaseModelUsageLedger, NocoBaseModelStream } from '../../../../../enterprise/plugin-agent-bridge/dist/server/model.js';
import Plugin from '../../../dist/server/plugin.js';
import { AgentBridge as MountedBridge } from '../../../dist/server/core.js';
import { EventEmitter } from 'node:events';
import { AgentBridge, digest } from '../core.ts';

function database() {
  const tables={afosModelBudgets:new Map(),afosModelCalls:new Map()};let tail=Promise.resolve();
  const repository=name=>({findOne:async options=>{const v=tables[name].get(options.filterByTk);return v?{get:key=>structuredClone(v[key])}:undefined;},
    create:async({values})=>{if(tables[name].has(values.id))throw Error('unique');tables[name].set(values.id,structuredClone(values));},
    update:async({filterByTk,values})=>{const row=tables[name].get(filterByTk);if(!row)throw Error('missing');tables[name].set(filterByTk,{...row,...structuredClone(values)});}});
  const app={db:{getRepository:repository,sequelize:{transaction:(_options,callback)=>{const operation=tail.then(async()=>{const backup=structuredClone(tables);try{return await callback({LOCK:{UPDATE:'UPDATE'}});}catch(error){for(const name of Object.keys(tables))tables[name]=backup[name];throw error;}});tail=operation.catch(()=>{});return operation;}}}};
  return {app,tables,ledger:new NocoBaseModelUsageLedger(app)};
}
const reservation=(callId='one')=>({scopeKey:'server-derived-alice-org-project',callId,run:{runId:'run1',attempt:1},reservedTokens:30,limitTokens:50});
const settlement=(callId='one',usage={status:'unknown'})=>({scopeKey:reservation().scopeKey,callId,outcome:'completed',usage,cost:{status:'unknown'}});
const budgetId=createHash('sha256').update(JSON.stringify(reservation().scopeKey)).digest('hex');

test('AFOS-CHECK-M01 NocoBase ledger serializes quota reservations and preserves unknown charge',async()=>{
  const f=database();const results=await Promise.allSettled([f.ledger.reserve(reservation('one')),f.ledger.reserve(reservation('two'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.tables.afosModelCalls.size,1);assert.equal(f.tables.afosModelBudgets.get(budgetId).payload.charged,30);
  await f.ledger.settle(settlement());assert.equal(f.tables.afosModelBudgets.get(budgetId).payload.charged,30);
  await assert.rejects(f.ledger.reserve(reservation('next')),{code:'MODEL_BUDGET_EXCEEDED'});
});

test('AFOS-CHECK-M02 provider usage settlement is durable, identical replay idempotent and conflict denied',async()=>{
  const f=database();await f.ledger.reserve(reservation());
  const value=settlement('one',{status:'known',source:'provider',tokens:{inputTokens:12,outputTokens:5,totalTokens:17}});
  await f.ledger.settle(value);await f.ledger.settle(value);assert.equal(f.tables.afosModelBudgets.get(budgetId).payload.charged,17);
  await assert.rejects(f.ledger.settle(settlement()),{code:'MODEL_SETTLEMENT_ALREADY_USED'});
  await f.ledger.reserve(reservation('next'));assert.equal(f.tables.afosModelBudgets.get(budgetId).payload.charged,47);
  assert.doesNotMatch(JSON.stringify([...f.tables.afosModelCalls.values()]),/private prompt|vendor key/);
});

test('AFOS-CHECK-M03 cancelled reservation has no rows and malformed provider counters cannot release quota',async()=>{
  const f=database();const controller=new AbortController();controller.abort();await assert.rejects(f.ledger.reserve(reservation(),controller.signal));assert.equal(f.tables.afosModelCalls.size,0);
  await f.ledger.reserve(reservation());await assert.rejects(f.ledger.settle(settlement('one',{status:'known',source:'provider',tokens:{inputTokens:-1,outputTokens:5}})),{code:'MALFORMED_MODEL_STREAM'});
  assert.equal(f.tables.afosModelBudgets.get(budgetId).payload.charged,30);
});

function streamFixture() {
  const evidence={issuer:'https://enterprise.example/api',principalId:'alice',clientId:'desktop',grantId:'grant',tokenId:'token',issuedAt:Date.now(),expiresAt:Date.now()+3600000};
  const source={id:'m1',projectId:'p1',revisionId:'v1',name:'M',text:'private source',hash:digest('private source')};
  const tables={runs:new Map(),uploads:new Map(),receipts:new Map(),artifacts:new Map(),commitRequests:new Map()};let active=true;
  const store={tokenActive:async()=>active,deviceId:async()=>'device1',projects:async()=>({items:[],nextPosition:null}),project:async()=>({id:'p1',organizationId:'org1',name:'P'}),materials:async()=>({items:[source],nextPosition:null}),material:async()=>source,
    get:async(t,id)=>structuredClone(tables[t].get(id)),insert:async(t,v)=>tables[t].set(v.id,structuredClone(v)),replaceUpload:async()=>{},transaction:async fn=>fn(store),audit:async()=>{}};
  const bridge=new AgentBridge(store,'release','policy',new Uint8Array(32).fill(1),true);
  const policy={provider:'afos-fixed',model:'deepseek-v4-flash',maxTokens:10,enabled:true,vendorEndpoint:'https://models.example.com/anthropic',contextWindow:20,budgetLimitTokens:100,resolveVendorKey:async()=>'FAKE_SERVER_ONLY_MODEL_KEY'};
  const db=database();const model=new NocoBaseModelStream(policy,db.ledger);
  const authorize=()=>bridge.dispatch(evidence,'runs.authorizeLocal',{projectId:'p1',releaseId:'release',inputRefs:[{materialId:'m1',revisionId:'v1',sha256:source.hash}],clientRequestId:'run-key'});
  return {bridge,evidence,model,db,policy,authorize,revoke:()=>{active=false;}};
}
const vendorEvents=[{type:'message_start',message:{id:'msg1',model:'deepseek-v4-flash',usage:{input_tokens:12,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Draft'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}},{type:'message_stop'}];
const request=run=>({contractVersion:'afos.model.v1',run:{runId:run.runId,attempt:run.attempt},callId:'call1',request:{messages:[{role:'user',content:[{type:'text',text:'private prompt'}]}],maxTokens:10}});

test('AFOS-CHECK-M04 mounted model stream uses current run ACL and the durable repository ledger with official Adapter',async t=>{
  const f=streamFixture();const run=await f.authorize();assert.ok(run.allowedActions.includes('models.stream'));
  let vendorCalls=0;mock.method(globalThis,'fetch',async(url,init)=>{vendorCalls++;assert.equal(String(url),'https://models.example.com/anthropic/v1/messages');assert.equal(init.redirect,'error');assert.equal(init.headers['x-api-key'],'FAKE_SERVER_ONLY_MODEL_KEY');return new Response(vendorEvents.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});});t.after(()=>mock.restoreAll());
  const chunks=[];for await(const chunk of f.model.stream(request(run),f.evidence,f.bridge,new AbortController().signal))chunks.push(chunk);
  assert.equal(vendorCalls,1);assert.equal(chunks.at(-1).reason.kind,'stop');const calls=[...f.db.tables.afosModelCalls.values()];assert.equal(calls[0].payload.settlement.usage.status,'known');
  assert.doesNotMatch(JSON.stringify({chunks,calls}),/FAKE_SERVER_ONLY_MODEL_KEY|private prompt/);
  f.revoke();await assert.rejects(async()=>{for await(const _chunk of f.model.stream({...request(run),callId:'another'},f.evidence,f.bridge,new AbortController().signal)){};});assert.equal(vendorCalls,1);
});

test('AFOS-CHECK-M05 model execution is disabled by default and cannot be inferred from caller scope',async()=>{
  const f=streamFixture();const run=await f.authorize();const disabled=new AgentBridge(f.bridge.store,'release','policy');
  await assert.rejects(disabled.authorizeModel(f.evidence,{runId:run.runId,attempt:1}),/afos\/model-disabled/);
  const gateway=new NocoBaseModelStream({...f.policy,enabled:false},f.db.ledger);assert.throws(()=>gateway.validate(request(run)),{code:'MODEL_EXECUTION_DISABLED'});
});


test('AFOS-CHECK-M06 disconnect during mounted admission never publishes SSE or calls the vendor',async t=>{
  const f=streamFixture();const definitions=[];let vendorCalls=0;let entered,release;
  const waiting=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  const app={pm:{get:()=>({service:{registerResourceServer(){},unregisterResourceServer(){}}})},use(){},resourceManager:{define:value=>definitions.push(value)},acl:{allow(){}}};
  const plugin=new Plugin(app,{name:'agent-bridge',bridge:{issuer:f.evidence.issuer,audience:`${f.evidence.issuer}/afos`,jwksUrl:`${f.evidence.issuer}/jwks`,clientIds:['desktop'],releaseId:'release',policyRevision:'policy',model:f.policy}});
  await plugin.load();
  mock.method(MountedBridge.prototype,'authorizeModel',async()=>{entered();await gate;return {};});
  mock.method(globalThis,'fetch',async()=>{vendorCalls++;throw Error('vendor must not start');});t.after(()=>mock.restoreAll());
  const req=new EventEmitter(),res=new EventEmitter();const headers=[];
  const ctx={method:'POST',request:{body:request({runId:'run1',attempt:1})},state:{currentUser:{get:()=> 'alice'}},req,res,set:(...args)=>headers.push(args)};
  plugin.verified.set(ctx,f.evidence);
  const operation=definitions.find(d=>d.name==='afos').actions.create(ctx);await waiting;res.emit('close');release();await operation;
  assert.equal(ctx.status,403);assert.equal(headers.length,0);assert.equal(vendorCalls,0);assert.equal(plugin.activeModelStreams.size,0);
  assert.equal(res.listenerCount('close'),0);assert.equal(req.listenerCount('aborted'),0);
});

test('AFOS-CHECK-M07 private ledger stores only canonical accounting fields',async()=>{
  const f=database();await f.ledger.reserve({...reservation(),prompt:'private prompt',vendorKey:'vendor key',run:{...reservation().run,unexpected:'secret'}});
  await f.ledger.settle({...settlement(),prompt:'private prompt',cost:{status:'unknown',vendorKey:'vendor key'}});
  assert.doesNotMatch(JSON.stringify([...f.tables.afosModelCalls.values()]),/private prompt|vendor key|unexpected/);
});
