import { createHash } from 'node:crypto';
import { Transaction } from '@nocobase/database';
import type { Application } from '@nocobase/server';
import { FixedModelGateway, modelError, validateModelRequest, validateUsage, usageTokens,
  type FixedModelGatewayConfig, type ModelReservation, type ModelRunRef, type ModelStreamRequest,
  type ModelUsageLedger, type ModelUsageSettlement } from '@afos/model-adapter';
import type { AccessEvidence } from './auth.js';
import { AgentBridge } from './core.js';

export interface ManagedModelConfig extends FixedModelGatewayConfig {
  /** Trusted server secret owner; cannot be JSON/client request configuration. */
  readonly resolveVendorKey: () => Promise<string>;
}
interface Budget { readonly id:string; readonly charged:number }
interface Call { readonly id:string; readonly reservation:ModelReservation; readonly settlement?:ModelUsageSettlement }
type ModelChunk=ReturnType<FixedModelGateway['stream']> extends AsyncGenerator<infer Chunk>?Chunk:never;
function key(value:unknown):string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function positive(value:unknown):value is number { return typeof value==='number'&&Number.isSafeInteger(value)&&value>0; }
function identity(value:unknown):value is string { return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/u.test(value); }

/** Private NocoBase rows own durable model reservation and provider usage, never prompts. */
export class NocoBaseModelUsageLedger implements ModelUsageLedger {
  constructor(private readonly app:Application) {}
  async reserve(reservation:ModelReservation,signal?:AbortSignal):Promise<void> {
    if(!identity(reservation.scopeKey)||!identity(reservation.callId)||!identity(reservation.run.runId)
      ||!positive(reservation.run.attempt)||!positive(reservation.reservedTokens)||!positive(reservation.limitTokens)
      ||reservation.reservedTokens>reservation.limitTokens)throw modelError('MODEL_BUDGET_EXCEEDED');
    const input:ModelReservation={scopeKey:reservation.scopeKey,callId:reservation.callId,
      run:{runId:reservation.run.runId,attempt:reservation.run.attempt},reservedTokens:reservation.reservedTokens,limitTokens:reservation.limitTokens};
    signal?.throwIfAborted();
    await this.app.db.sequelize.transaction({isolationLevel:Transaction.ISOLATION_LEVELS.SERIALIZABLE},async tx=>{
      const budgets=this.app.db.getRepository('afosModelBudgets');
      const calls=this.app.db.getRepository('afosModelCalls');
      const id=key([input.scopeKey,input.callId]),budgetId=key(input.scopeKey);
      const current=await calls.findOne({filterByTk:id,transaction:tx,lock:tx.LOCK.UPDATE});
      if(current)throw modelError('MODEL_CALL_ALREADY_USED');
      const row=await budgets.findOne({filterByTk:budgetId,transaction:tx,lock:tx.LOCK.UPDATE});
      const payload=row?.get('payload') as Budget|undefined;
      if(payload&&(!Number.isSafeInteger(payload.charged)||payload.charged<0))throw modelError('MODEL_LEDGER_UNAVAILABLE');
      const charged=(payload?.charged??0)+input.reservedTokens;
      if(!Number.isSafeInteger(charged)||charged>input.limitTokens)throw modelError('MODEL_BUDGET_EXCEEDED');
      signal?.throwIfAborted();
      if(row)await budgets.update({filterByTk:budgetId,values:{payload:{id:budgetId,charged}},transaction:tx});
      else await budgets.create({values:{id:budgetId,payload:{id:budgetId,charged}},transaction:tx});
      await calls.create({values:{id,payload:{id,reservation:input}},transaction:tx});
      signal?.throwIfAborted();
    });
  }
  async settle(settlement:ModelUsageSettlement,signal?:AbortSignal):Promise<void> {
    if(!identity(settlement.scopeKey)||!identity(settlement.callId)||!['completed','aborted','failed','unknown'].includes(settlement.outcome)
      ||settlement.cost.status!=='unknown'||!['known','unknown'].includes(settlement.usage.status)
      ||settlement.usage.status==='known'&&settlement.usage.source!=='provider')throw modelError('MODEL_LEDGER_UNAVAILABLE');
    const input:ModelUsageSettlement={scopeKey:settlement.scopeKey,callId:settlement.callId,outcome:settlement.outcome,
      cost:{status:'unknown'},usage:settlement.usage.status==='known'?{status:'known',source:'provider',tokens:validateUsage(settlement.usage.tokens)}:{status:'unknown'}};
    const actual=input.usage.status==='known'?usageTokens(validateUsage(input.usage.tokens)):undefined;
    signal?.throwIfAborted();
    await this.app.db.sequelize.transaction({isolationLevel:Transaction.ISOLATION_LEVELS.SERIALIZABLE},async tx=>{
      const calls=this.app.db.getRepository('afosModelCalls'),budgets=this.app.db.getRepository('afosModelBudgets');
      const id=key([input.scopeKey,input.callId]),budgetId=key(input.scopeKey);
      const row=await calls.findOne({filterByTk:id,transaction:tx,lock:tx.LOCK.UPDATE});
      const payload=row?.get('payload') as Call|undefined;
      if(!payload||payload.reservation.scopeKey!==input.scopeKey||payload.reservation.callId!==input.callId)throw modelError('MODEL_RESERVATION_MISSING');
      if(payload.settlement){if(JSON.stringify(payload.settlement)===JSON.stringify(input))return;throw modelError('MODEL_SETTLEMENT_ALREADY_USED');}
      const budgetRow=await budgets.findOne({filterByTk:budgetId,transaction:tx,lock:tx.LOCK.UPDATE});
      const budget=budgetRow?.get('payload') as Budget|undefined;
      if(!budget||!Number.isSafeInteger(budget.charged)||budget.charged<payload.reservation.reservedTokens)throw modelError('MODEL_LEDGER_UNAVAILABLE');
      const charged=actual===undefined?budget.charged:budget.charged-payload.reservation.reservedTokens+actual;
      if(!Number.isSafeInteger(charged)||charged<0)throw modelError('MODEL_LEDGER_UNAVAILABLE');
      signal?.throwIfAborted();
      await budgets.update({filterByTk:budgetId,values:{payload:{id:budgetId,charged}},transaction:tx});
      await calls.update({filterByTk:id,values:{payload:{...payload,settlement:input}},transaction:tx});
      signal?.throwIfAborted();
    });
  }
}

/** Fixed mounted capability; identity and model scope are never accepted from the wire. */
export class NocoBaseModelStream {
  private readonly config:ManagedModelConfig;
  constructor(config:ManagedModelConfig,private readonly ledger:ModelUsageLedger) {
    if(typeof config.resolveVendorKey!=='function')throw modelError('MODEL_CREDENTIAL_UNAVAILABLE');
    this.config=Object.freeze({...config});
    // Validate the fixed managed route at load time, before granting a run its model action.
    new FixedModelGateway(this.config,{authorize:async()=>{throw modelError('MODEL_AUTHORIZATION_DENIED');},ledger,resolveVendorKey:this.config.resolveVendorKey});
  }
  validate(raw:unknown):ModelStreamRequest {
    if(this.config.enabled!==true)throw modelError('MODEL_EXECUTION_DISABLED');
    return validateModelRequest(raw,this.config);
  }
  async* stream(raw:ModelStreamRequest,evidence:AccessEvidence,bridge:AgentBridge,callerSignal:AbortSignal):AsyncGenerator<ModelChunk> {
    const request=this.validate(raw);
    const controller=new AbortController();
    const signal=AbortSignal.any([callerSignal,controller.signal]);
    let polling=false;
    const authorize=async(reference:ModelRunRef,checkSignal:AbortSignal)=>{
      checkSignal.throwIfAborted();
      const run=await bridge.authorizeModel(evidence,reference);
      checkSignal.throwIfAborted();
      return {scopeKey:key([run.issuer,run.principalId,run.organizationId,run.projectId]),allowedTools:['afos_read_snapshot','afos_render_draft'],expiresAt:Math.min(run.expiresAt,evidence.expiresAt),signal};
    };
    // Permission polling cancels an idle vendor stream too. It owns no Agent/LLM execution state.
    const poll=setInterval(()=>{
      if(polling||signal.aborted)return;
      polling=true;
      void authorize(request.run,signal).catch(()=>controller.abort()).finally(()=>{polling=false;});
    },1000);
    poll.unref();
    try {
      const gateway=new FixedModelGateway(this.config,{authorize,ledger:this.ledger,resolveVendorKey:this.config.resolveVendorKey});
      yield* gateway.stream(request,signal);
    } finally {clearInterval(poll);controller.abort();}
  }
}
