import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection';
import { EnterpriseProfileError } from './snapshot-authority.js';
export const NATIVE_WITNESS_HEADER = 'x-afos-native-witness';
export const CALLER_HTTP_PATHS = Object.freeze([
  '/api/session/list', '/api/session/page', '/api/session/projections',
  ...['state', 'materials', 'snapshot', 'start', 'edit', 'cancel', 'archive'].map(name => '/api/afos/drafts/' + name),
  '/api/afos/createSession', '/api/afos/readSnapshot', '/api/afos/renderDraft',
]);
export const CALLER_MUX_PATH = '/api/remote.mux';
export interface NativeCallerRequest { readonly witness:string; readonly method:string; readonly path:string; readonly authority:string }
export interface NativeCallerIssuer { assertRequest(request:NativeCallerRequest,signal:AbortSignal):Promise<{readonly signal:AbortSignal;readonly expiresAt:number; assertCurrent?():void; close?():void}> }
const refuse=():never=>{throw new EnterpriseProfileError('afos/native-read-denied');};
export function finiteCallerRequest(value:unknown):NativeCallerRequest {
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype
    ||Reflect.ownKeys(value).length!==4||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!['witness','method','path','authority'].includes(key))
    ||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!('value'in d)))refuse();
  const v=value as NativeCallerRequest;
  if(typeof v.witness!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(v.witness)
    ||typeof v.authority!=='string'||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(v.authority))refuse();
  const url=new URL('http://'+v.authority);if(url.host!==v.authority||Number(url.port)>65535)refuse();
  if(!(v.method==='POST'&&CALLER_HTTP_PATHS.includes(v.path)||v.method==='GET'&&v.path===CALLER_MUX_PATH))refuse();
  return Object.freeze({witness:v.witness,method:v.method,path:v.path,authority:v.authority});
}
/** Trusted HTTP/upgrade facts, never an arbitrary browser DTO or original cookie proof. */
export function callerRequestFromHttp(request:ConnectionTrustRequest):NativeCallerRequest {
  const facts=request as ConnectionTrustRequest & {method?:unknown;url?:unknown};
  const header=(name:string):string=>{
    if(request.headers instanceof Headers){const value=request.headers.get(name);if(value===null)return refuse();return value;}
    const keys=Object.keys(request.headers).filter(key=>key.toLowerCase()===name);
    if(keys.length!==1)refuse();const value=request.headers[keys[0]!];if(typeof value!=='string')return refuse();return value;
  };
  if(typeof facts.method!=='string'||typeof facts.url!=='string'||!facts.url.startsWith('/'))refuse();
  return finiteCallerRequest({witness:header(NATIVE_WITNESS_HEADER),method:facts.method,path:facts.url,authority:header('host')});
}
