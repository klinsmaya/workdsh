import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection';
import { randomUUID } from 'node:crypto';
import type { MainBusinessCapabilities } from './main-capabilities.js';
import type { NativeCallerProof, NativeCallerGrant } from './native-ws-admission.js';
import { finiteCallerRequest, callerRequestFromHttp, type NativeCallerIssuer } from './native-caller-ipc.js';
import { record, id, integer, denied } from './main-ipc-data.js';

type CallerMethod='caller.admit'|'caller.assert'|'caller.release';
interface ParentLease { readonly signal:AbortSignal; readonly expiresAt:number; readonly assertCurrent:()=>void; close():void }
/** A non-cooperative fresh Main reply cannot keep a revoked caller request pending. */
async function within<T>(operation:Promise<T>,signal:AbortSignal):Promise<T> {
 let reject!:(error:Error)=>void;
 const cancelled=new Promise<never>((_resolve,fail)=>{reject=fail;});
 const cutoff=()=>reject(new Error('afos/native-read-denied'));
 signal.addEventListener('abort',cutoff,{once:true});if(signal.aborted)cutoff();
 try{return await Promise.race([operation,cancelled]);}finally{signal.removeEventListener('abort',cutoff);}
}
/** Strict finite adapter over the already owned private Node channel; no network listener. */
export function parentCallerIpc(issuer:NativeCallerIssuer|undefined,business:MainBusinessCapabilities,signal:AbortSignal,
  sendCutoff:(leaseId:string)=>Promise<void>) {
  const leases=new Map<string,ParentLease>();let closed=false;
  const active=()=>{if(closed)denied();signal.throwIfAborted();};
  const perform=async(method:CallerMethod,args:Record<string,unknown>,caller:AbortSignal):Promise<unknown>=>{
    active();caller.throwIfAborted();
    if(method==='caller.admit'){
      const request=finiteCallerRequest(args.request);if(!issuer||leases.size>=32)denied();
      // A consumed Main witness is required BEFORE asking Main enterprise authority.
      const raw=await issuer.assertRequest(request,caller);
      let timer:ReturnType<typeof setTimeout>|undefined,release=()=>{},closeCreated:(()=>void)|undefined;
      try {
        active();caller.throwIfAborted();if(leases.size>=32)denied();
        const expiresAt=raw.expiresAt;
        if(!(raw.signal instanceof AbortSignal)||raw.signal.aborted||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+60000)denied();
        const check=()=>{active();raw.signal.throwIfAborted();raw.assertCurrent?.();if(Date.now()>=expiresAt)denied();};
        check();const freshSignal=AbortSignal.any([caller,raw.signal,signal]);
        const current=await within(business.currentAuthority(freshSignal),freshSignal);check();caller.throwIfAborted();
        const bounded=Math.min(expiresAt,Date.parse(current.expiresAt));if(!Number.isFinite(bounded)||bounded<=Date.now())denied();
        const abort=new AbortController(),combined=AbortSignal.any([signal,raw.signal,abort.signal]),leaseId=randomUUID();
        const assertCurrent=()=>{check();combined.throwIfAborted();if(Date.now()>=bounded)denied();};
        let ended=false;
        const close=()=>{if(ended)return;ended=true;clearTimeout(timer);release();leases.delete(leaseId);abort.abort();raw.close?.();void sendCutoff(leaseId).catch(()=>undefined);};
        const lease:ParentLease=Object.freeze({signal:combined,expiresAt:bounded,assertCurrent,close});
        leases.set(leaseId,lease);closeCreated=close;
        raw.signal.addEventListener('abort',close,{once:true});signal.addEventListener('abort',close,{once:true});
        release=()=>{raw.signal.removeEventListener('abort',close);signal.removeEventListener('abort',close);};
        timer=setTimeout(close,Math.max(1,bounded-Date.now()));timer.unref();
        assertCurrent();return {leaseId,expiresAt:bounded};
      }catch(error){if(closeCreated)closeCreated();else{clearTimeout(timer);release();raw.close?.();}throw error;}
    }
    const leaseId=id(args.leaseId),lease=leases.get(leaseId);if(!lease)denied();
    if(method==='caller.release'){lease.close();return null;}
    lease.assertCurrent();
    const freshSignal=AbortSignal.any([caller,lease.signal]);
    const current=await within(business.currentAuthority(freshSignal),freshSignal);lease.assertCurrent();caller.throwIfAborted();if(!Number.isFinite(Date.parse(current.expiresAt))||Date.parse(current.expiresAt)<=Date.now())denied();return null;
  };
  return Object.freeze({perform,close(){closed=true;for(const lease of leases.values())lease.close();leases.clear();}});
}

/** Child receives only a one-caller bounded private lease, with explicit revocation. */
export function childCallerIpc(call:(method:CallerMethod,args:object,signal:AbortSignal)=>Promise<unknown>,signal:AbortSignal) {
  const leases=new Map<string,{abort:AbortController;close:()=>void}>();
  const proof:NativeCallerProof=Object.freeze({async assertRequest(request:ConnectionTrustRequest,caller:AbortSignal):Promise<NativeCallerGrant>{
    signal.throwIfAborted();caller.throwIfAborted();
    const value=record(await call('caller.admit',{request:callerRequestFromHttp(request)},caller),['leaseId','expiresAt']);
    const leaseId=id(value.leaseId),expiresAt=integer(value.expiresAt,Number.MAX_SAFE_INTEGER);
    if(leases.has(leaseId)||leases.size>=32||expiresAt<=Date.now()||expiresAt>Date.now()+60000)denied();
    const abort=new AbortController(),combined=AbortSignal.any([signal,caller,abort.signal]);let ended=false;
    const timer=setTimeout(()=>abort.abort(),Math.max(1,expiresAt-Date.now()));timer.unref();
    const close=()=>{if(ended)return;ended=true;clearTimeout(timer);caller.removeEventListener('abort',close);signal.removeEventListener('abort',close);leases.delete(leaseId);abort.abort();};
    leases.set(leaseId,{abort,close});caller.addEventListener('abort',close,{once:true});signal.addEventListener('abort',close,{once:true});
    const assertCurrent=()=>{combined.throwIfAborted();if(Date.now()>=expiresAt)denied();};
    try{assertCurrent();return Object.freeze({signal:combined,expiresAt,
      assertFresh:async (freshSignal:AbortSignal)=>{assertCurrent();await call('caller.assert',{leaseId},AbortSignal.any([freshSignal,combined]));assertCurrent();},
      close:()=>{close();if(!signal.aborted)void call('caller.release',{leaseId},signal).catch(()=>undefined);},
    });}catch(error){close();throw error;}
  }});
  return Object.freeze({proof,cutoff(value:unknown){const leaseId=id(value);leases.get(leaseId)?.close();},close(){for(const lease of leases.values())lease.close();leases.clear();}});
}
