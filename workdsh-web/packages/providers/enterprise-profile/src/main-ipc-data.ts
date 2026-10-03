import type { EnterpriseBinding, GatewayAuthoritySnapshot } from 'workdsh-contracts';
import type { EnterpriseDraftView, EnterpriseSourceRef } from 'workdsh-contracts/enterprise-drafts';
import type { MainBusinessCapabilities, MainDraftRecord, OwnedEnterpriseRun } from './main-capabilities.js';

export const IPC_VERSION = 'afos.main-ipc.v1';
export const IPC_MAX_BYTES = 8 * 1048576;
export const IPC_CHUNK_BYTES = 65536;
export const IPC_MODEL_BYTES = 4 * 1048576;
export const IPC_MAX_PENDING = 8;
export class MainIpcError extends Error {
  constructor(readonly code = 'afos/main-ipc-refused') { super(code); }
}
export function denied(): never { throw new MainIpcError(); }
export function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) denied();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) denied();
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) denied(); }
  return value as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) denied();
  return value;
}
export function text(value: unknown, max = 1048576): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) denied(); return value;
}
export function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) denied(); return value; }
export function stamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) denied(); return value;
}
export function integer(value: unknown, maximum = 1000000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) denied(); return value;
}
export function source(value: unknown): EnterpriseSourceRef {
  const v = record(value, ['materialId','revisionId','sha256']);
  return Object.freeze({materialId:businessId(v.materialId),revisionId:businessId(v.revisionId),sha256:hash(v.sha256)});
}
export function sources(value: unknown): readonly EnterpriseSourceRef[] {
  boundedJson(value); if (!Array.isArray(value) || value.length > 32) denied(); return Object.freeze(value.map(source));
}
export function businessId(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) denied(); return value;
}
export function binding(value: unknown): EnterpriseBinding {
  const v=record(value,['issuer','subject','organizationId','deviceId']); const issuer=businessId(v.issuer,1024);
  const url=new URL(issuer); if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) denied();
  return Object.freeze({issuer,subject:businessId(v.subject),organizationId:businessId(v.organizationId),deviceId:businessId(v.deviceId)});
}
export function authority(value: unknown): GatewayAuthoritySnapshot {
  const v=record(value,['contractVersion','binding','project','permissions','authorizationRevision','expiresAt']);
  const project=record(v.project,['id','organizationId','name']),permissions=record(v.permissions,['read','archive']);
  if(v.contractVersion!=='afos.identity.v1'||permissions.read!==true||typeof permissions.archive!=='boolean')denied();
  return Object.freeze({contractVersion:'afos.identity.v1',binding:binding(v.binding),
    project:Object.freeze({id:businessId(project.id),organizationId:businessId(project.organizationId),name:text(project.name,2048)}),
    permissions:Object.freeze({read:true,archive:permissions.archive}),authorizationRevision:hash(v.authorizationRevision),expiresAt:stamp(v.expiresAt)});
}
export function run(value: unknown): OwnedEnterpriseRun {
  const v=record(value,['runId','attempt','projectId','releaseId','policyRevision','inputRefs','expiresAt','binding']);
  if(integer(v.attempt)!==1) denied();
  return Object.freeze({runId:businessId(v.runId),attempt:1,projectId:businessId(v.projectId),releaseId:businessId(v.releaseId),policyRevision:businessId(v.policyRevision),
    inputRefs:sources(v.inputRefs),expiresAt:stamp(v.expiresAt),binding:binding(v.binding)});
}
export function runDto(v: OwnedEnterpriseRun): OwnedEnterpriseRun {
  return run({runId:v.runId,attempt:v.attempt,projectId:v.projectId,releaseId:v.releaseId,policyRevision:v.policyRevision,
    inputRefs:v.inputRefs,expiresAt:v.expiresAt,binding:v.binding});
}
function receipt(value: unknown): EnterpriseDraftView['receipt'] {
  const v=record(value,['receiptId','artifactId','revisionId','sha256','committedAt']);
  return Object.freeze({receiptId:businessId(v.receiptId),artifactId:businessId(v.artifactId),revisionId:businessId(v.revisionId),sha256:hash(v.sha256),committedAt:stamp(v.committedAt)});
}
const EXECUTIONS=['local_queued','running','cancel_requested','completed_local','failed','interrupted','cancelled'] as const;
const ARCHIVES=['local-only','needs-reconciliation','receipt-recorded'] as const;
export function draft(value: unknown): MainDraftRecord {
  const v=record(value,['draftId','sessionId','run','content','sha256','generatedAt','updatedAt','inputSnapshots','localExecution','archive'],['lastSyncAt','receipt']);
  const execution=EXECUTIONS.find(item=>item===v.localExecution), archive=ARCHIVES.find(item=>item===v.archive); if(!execution||!archive)denied();
  return Object.freeze({draftId:businessId(v.draftId),sessionId:businessId(v.sessionId),run:run(v.run),content:text(v.content,65536),sha256:hash(v.sha256),
    generatedAt:stamp(v.generatedAt),updatedAt:stamp(v.updatedAt),inputSnapshots:sources(v.inputSnapshots),localExecution:execution,archive,
    ...(v.lastSyncAt===undefined?{}:{lastSyncAt:stamp(v.lastSyncAt)}),...(v.receipt===undefined?{}:{receipt:receipt(v.receipt)})});
}
export function draftDto(v: MainDraftRecord): MainDraftRecord {
  return draft({draftId:v.draftId,sessionId:v.sessionId,run:runDto(v.run),content:v.content,sha256:v.sha256,generatedAt:v.generatedAt,updatedAt:v.updatedAt,
    inputSnapshots:v.inputSnapshots.map(ref=>source({materialId:ref.materialId,revisionId:ref.revisionId,sha256:ref.sha256})),localExecution:v.localExecution,archive:v.archive,
    ...(v.lastSyncAt?{lastSyncAt:v.lastSyncAt}:{}),...(v.receipt?{receipt:{receiptId:v.receipt.receiptId,artifactId:v.receipt.artifactId,
      revisionId:v.receipt.revisionId,sha256:v.receipt.sha256,committedAt:v.receipt.committedAt}}:{})});
}
export interface MainSnapshot {
  readonly revision:number;
  readonly local:ReturnType<MainBusinessCapabilities['localState']>;
  readonly drafts:readonly MainDraftRecord[];
}
export function snapshot(value:unknown):MainSnapshot {
  const v=record(value,['revision','local','drafts']),local=record(v.local,['project','authority','lastSyncAt']),project=record(local.project,['id','name']);
  if(local.authority!=='current'&&local.authority!=='offline'||!Array.isArray(v.drafts)||v.drafts.length>8)denied();
  return Object.freeze({revision:integer(v.revision),local:Object.freeze({project:Object.freeze({id:businessId(project.id),name:text(project.name,2048)}),
    authority:local.authority,lastSyncAt:stamp(local.lastSyncAt)}),drafts:Object.freeze(v.drafts.map(draft))});
}
/** Validate data before JSON serialization, including accessors and non-JSON values. */
export function boundedJson(value:unknown):void {
  const seen=new Set<object>(); let nodes=0, bytes=0;
  const add=(size:number)=>{bytes+=size;if(bytes>IPC_MAX_BYTES)denied();};
  const stringBytes=(item:string)=>{add(2);for(const char of item){const n=char.codePointAt(0)!;add(n<32?([8,9,10,12,13].includes(n)?2:6):n===34||n===92?2:n>=0xd800&&n<=0xdfff?6:Buffer.byteLength(char));}};
  const visit=(item:unknown,depth:number):void=>{
    if(++nodes>100000||depth>32)denied();
    if(item===null){add(4);return;}if(typeof item==='string'){stringBytes(item);return;}
    if(typeof item==='boolean'){add(item?4:5);return;}if(typeof item==='number'&&Number.isFinite(item)){add(String(item).length);return;}
    if(typeof item!=='object'||!item||seen.has(item))denied(); seen.add(item);
    add(2);if(Array.isArray(item)){
      add(Math.max(0,item.length-1));if(item.length>8192||Reflect.ownKeys(item).length!==item.length+1)denied();
      for(let i=0;i<item.length;i++){const d=Object.getOwnPropertyDescriptor(item,i);if(!d||!('value'in d))denied();visit(d.value,depth+1);}
    }else{
      if(Object.getPrototypeOf(item)!==Object.prototype)denied();
      const keys=Reflect.ownKeys(item);add(Math.max(0,keys.length-1));for(const key of keys){if(typeof key!=='string'||['__proto__','constructor','prototype','access_token','refresh_token','authorization','cookie','client_secret'].includes(key))denied();
        stringBytes(key);add(1);const d=Object.getOwnPropertyDescriptor(item,key);if(!d||!('value'in d)||!d.enumerable)denied();visit(d.value,depth+1);}
    }
    seen.delete(item);
  };visit(value,0);if(Buffer.byteLength(JSON.stringify(value))>IPC_MAX_BYTES)denied();
}
