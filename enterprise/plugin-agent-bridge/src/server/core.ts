import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AccessEvidence } from './auth.js';

export type Action = 'identity.current' | 'projects.listAllowed' | 'materials.listAllowed' | 'materials.readRevision' | 'runs.authorizeLocal' | 'runs.getAuthorization' | 'artifacts.stageUpload' | 'artifacts.upload' | 'artifacts.commitDraft' | 'runs.getReceipt';
export const actions: readonly Action[] = Object.freeze(['identity.current','projects.listAllowed', 'materials.listAllowed', 'materials.readRevision', 'runs.authorizeLocal', 'runs.getAuthorization','artifacts.stageUpload', 'artifacts.upload', 'artifacts.commitDraft', 'runs.getReceipt']);
export const contractVersion = 'afos.bridge.v1';
export interface Project { id: string; organizationId: string; name: string }
export interface Material { id: string; projectId: string; revisionId: string; hash: string; name: string; text: string }
export type MaterialSummary = Omit<Material, 'text'>;
export interface InputRef { materialId: string; revisionId: string; hash: string }
export interface Run { id: string; principalId: string; issuer: string; organizationId: string; deviceId: string; projectId: string; releaseId: string; policyRevision: string; allowedActions:string[]; inputs: InputRef[]; issuedAt: number; expiresAt: number; attempt: number; requestHash: string }
export interface Upload { id: string; runId: string; principalId: string; hash: string; bytes: number; expiresAt: number; content?: string }
export interface Receipt { id: string; runId: string; attempt: number; artifactId: string; revisionId: string; hash: string; archivedAt: string; requestHash: string }
export interface Artifact { id: string; projectId: string; runId: string; revisionId: string; hash: string; content: string; sources: InputRef[]; releaseId: string; status: 'draft-needs-review' }
export interface CommitRequest { id:string; runId:string; requestHash:string }
export interface Tables { runs: Run; uploads: Upload; receipts: Receipt; artifacts: Artifact; commitRequests:CommitRequest }
export interface Actor { principalId: string; organizationId: string }
export interface StorePage<T> { items:T[]; nextPosition:string|null }

/** NocoBase adapter must implement current membership + record/field ACL, not cached roles. */
export interface BridgeStore {
  tokenActive(evidence: AccessEvidence): Promise<boolean>;
  deviceId(evidence: AccessEvidence): Promise<string | undefined>;
  projects(evidence: AccessEvidence, after?:string): Promise<StorePage<Project>>;
  project(evidence: AccessEvidence, projectId: string, mode: 'read' | 'archive'): Promise<Project | undefined>;
  materials(evidence: AccessEvidence, projectId: string, after?:string): Promise<StorePage<MaterialSummary>>;
  material(evidence: AccessEvidence, materialId: string, revisionId: string): Promise<Material | undefined>;
  get<K extends keyof Tables>(table: K, id: string): Promise<Tables[K] | undefined>;
  insert<K extends keyof Tables>(table: K, value: Tables[K]): Promise<void>;
  replaceUpload(value: Upload): Promise<void>;
  transaction<T>(callback: (store: BridgeStore) => Promise<T>): Promise<T>;
  audit(event: {principalId: string; action: string; outcome: 'allowed' | 'denied' | 'failed'; requestId: string; code: string}): Promise<void>;
}
export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
function fail(status: number, code: string): never { throw new BridgeError(status, code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'afos/invalid-parameters');
  return value as Record<string, unknown>;
}
function exact(value: Record<string,unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400,'afos/unexpected-parameter');
}
const parameterKeys: Record<Action,readonly string[]> = {
  'identity.current':['projectId'], 'runs.getAuthorization':['runId'],
  'projects.listAllowed':['cursor'], 'materials.listAllowed':['projectId','cursor'],
  'materials.readRevision':['materialId','revisionId'],
  'runs.authorizeLocal':['projectId','releaseId','inputRefs','clientRequestId'],
  'artifacts.stageUpload':['runId','attempt','mime','bytes','sha256'],
  'artifacts.upload':['runId','attempt','uploadId','content'],
  'artifacts.commitDraft':['runId','attempt','uploadId','inputRefs','clientRequestId'],
  'runs.getReceipt':['runId','projectId'],
};
function id(value: unknown, maximum=256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) fail(400, 'afos/invalid-id');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(400, 'afos/invalid-hash');
  return value;
}
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function inputRefs(value: unknown): InputRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail(400, 'afos/invalid-inputs');
  const refs = value.map(value => { const ref = object(value); exact(ref,['materialId','revisionId','sha256']); return { materialId: id(ref.materialId), revisionId: id(ref.revisionId), hash: hash(ref.sha256) }; });
  if (new Set(refs.map(ref => JSON.stringify([ref.materialId,ref.revisionId]))).size !== refs.length) fail(400, 'afos/duplicate-input');
  return refs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function wireInputs(inputs: InputRef[]) { return inputs.map(ref => ({materialId:ref.materialId,revisionId:ref.revisionId,sha256:ref.hash})); }
function wireRun(run: Run) {
  return {contractVersion:'afos.run.v1',runId:run.id,attempt:run.attempt,binding:{issuer:run.issuer,subject:run.principalId,organizationId:run.organizationId,deviceId:run.deviceId},projectId:run.projectId,releaseId:run.releaseId,policyRevision:run.policyRevision,inputRefs:wireInputs(run.inputs),allowedActions:run.allowedActions,issuedAt:new Date(run.issuedAt).toISOString(),expiresAt:new Date(run.expiresAt).toISOString()};
}
function wireReceipt(receipt: Receipt) { return {contractVersion:'afos.receipt.v1',receiptId:receipt.id,runId:receipt.runId,attempt:receipt.attempt,artifactId:receipt.artifactId,revisionId:receipt.revisionId,sha256:receipt.hash,committedAt:receipt.archivedAt}; }

export class AgentBridge {
  readonly store: BridgeStore;
  readonly releaseId: string;
  readonly policyRevision: string;
  private readonly cursorKey: Uint8Array;
  constructor(store: BridgeStore, releaseId: string, policyRevision = 'afos.policy.v1', cursorKey: Uint8Array = randomBytes(32), private readonly modelEnabled = false) { this.store = store; this.releaseId = id(releaseId,128); this.policyRevision=id(policyRevision,128); if(cursorKey.byteLength<32)throw new Error('afos/invalid-cursor-key');this.cursorKey=Uint8Array.from(cursorKey); }

  /** Trusted model gateway only; not a generic public permission query. */
  async authorizeModel(evidence:AccessEvidence,reference:{runId:string;attempt:number}):Promise<Run> {
    if(!this.modelEnabled)fail(403,'afos/model-disabled');
    return this.store.transaction(async store=>{
      if(evidence.expiresAt<=Date.now()||!await store.tokenActive(evidence))fail(401,'afos/access-revoked');
      const run=await this.run(store,evidence,id(reference.runId),'read');
      if(run.attempt!==reference.attempt||!run.allowedActions.includes('models.stream'))fail(403,'afos/run-action-denied');
      return run;
    });
  }

  private page(evidence:AccessEvidence, action:Action, context:unknown, cursor:unknown) {
    const binding=digest(JSON.stringify([evidence.issuer,evidence.principalId,evidence.clientId,evidence.grantId,action,context,this.policyRevision]));
    let position:string|undefined;
    if(cursor!==undefined){
      if(typeof cursor!=='string'||cursor.length>1024)fail(400,'afos/invalid-cursor');
      const [encoded,signature,...extra]=cursor.split('.');
      if(!encoded||!signature||extra.length)fail(400,'afos/invalid-cursor');
      const expected=createHmac('sha256',this.cursorKey).update(encoded).digest();
      const received=Buffer.from(signature,'base64url');
      if(received.length!==expected.length||!timingSafeEqual(received,expected))fail(400,'afos/invalid-cursor');
      let decoded:Record<string,unknown>;
      try { decoded=object(JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'))); } catch { fail(400,'afos/invalid-cursor'); }
      exact(decoded,['position','binding','expiresAt']);
      if(decoded.binding!==binding||typeof decoded.expiresAt!=='number'||decoded.expiresAt<=Date.now())fail(400,'afos/invalid-cursor');
      position=id(decoded.position);
    }
    return {position,next:(nextPosition:string|null):string|null=>{
      if(nextPosition===null)return null;
      if(nextPosition===position)fail(503,'afos/non-advancing-page');
      const encoded=Buffer.from(JSON.stringify({position:id(nextPosition),binding,expiresAt:Math.min(evidence.expiresAt,Date.now()+10*60_000)})).toString('base64url');
      return `${encoded}.${createHmac('sha256',this.cursorKey).update(encoded).digest('base64url')}`;
    }};
  }

  async dispatch(evidence: AccessEvidence, actionValue: unknown, value: unknown): Promise<unknown> {
    const requestId = randomUUID();
    let action = 'unknown';
    try {
      if (typeof actionValue !== 'string' || !actions.includes(actionValue as Action)) fail(403, 'afos/action-not-allowed');
      action = actionValue;
      if (!evidence.principalId || evidence.expiresAt <= Date.now() || !await this.store.tokenActive(evidence)) fail(401, 'afos/access-revoked');
      const params = object(value);
      // Caller-selected identity, endpoint, role or storage paths never participate.
      for (const key of ['actor', 'principalId', 'organizationId', 'owner', 'role', 'endpoint', 'path', 'objectKey']) if (key in params) fail(400, 'afos/forged-context');
      exact(params,parameterKeys[action as Action]);
      const result = await this.store.transaction(async store => {
        if (!await store.tokenActive(evidence)) fail(401, 'afos/access-revoked');
        return this.execute(store, evidence, action as Action, params);
      });
      await this.store.audit({ principalId: evidence.principalId, action, outcome: 'allowed', requestId, code: 'afos/ok' });
      return result;
    } catch (error) {
      await this.store.audit({ principalId: evidence.principalId, action, outcome: error instanceof BridgeError && error.status < 500 ? 'denied' : 'failed', requestId, code: error instanceof BridgeError ? error.code : 'afos/internal-error' });
      throw error;
    }
  }
  private async project(store: BridgeStore, evidence: AccessEvidence, projectId: string, mode: 'read' | 'archive' = 'read'): Promise<Project> {
    const project = await store.project(evidence, projectId, mode);
    if (!project) fail(403, 'afos/project-denied');
    return project;
  }
  private async run(store: BridgeStore, evidence: AccessEvidence, runId: string, mode: 'read' | 'archive'): Promise<Run> {
    const run = await store.get('runs', runId);
    if (!run || run.principalId !== evidence.principalId) fail(404, 'afos/run-not-found');
    if (run.expiresAt <= Date.now()) fail(403, 'afos/run-expired');
    if (run.issuer!==evidence.issuer || run.deviceId!==await store.deviceId(evidence) || run.policyRevision!==this.policyRevision || run.releaseId!==this.releaseId) fail(403,'afos/run-binding-changed');
    const project = await this.project(store, evidence, run.projectId, mode);
    if (project.organizationId !== run.organizationId) fail(403, 'afos/organization-changed');
    for (const ref of run.inputs) {
      const material = await store.material(evidence, ref.materialId, ref.revisionId);
      if (!material || material.projectId !== run.projectId || material.hash !== ref.hash || digest(material.text) !== ref.hash) fail(403, 'afos/input-revoked-or-changed');
    }
    return run;
  }
  private async execute(store: BridgeStore, evidence: AccessEvidence, action: Action, p: Record<string, unknown>): Promise<unknown> {
    if (action === 'identity.current') {
      const project=await this.project(store,evidence,id(p.projectId));
      const deviceId=id(await store.deviceId(evidence));
      let archive=false;
      try { archive=Boolean(await store.project(evidence,project.id,'archive')); }
      catch(error) { if(!(error&&typeof error==='object'&&'status' in error&&error.status===403))throw error; }
      return {contractVersion:'afos.identity.v1',binding:{issuer:evidence.issuer,subject:evidence.principalId,organizationId:project.organizationId,deviceId},project,
        permissions:{read:true,archive},authorizationRevision:digest(JSON.stringify([evidence.issuer,evidence.principalId,evidence.clientId,evidence.grantId,deviceId,project.id,project.organizationId,archive,this.policyRevision])),expiresAt:new Date(Math.min(evidence.expiresAt,Date.now()+5_000)).toISOString()};
    }
    if(action==='runs.getAuthorization')return wireRun(await this.run(store,evidence,id(p.runId),'read'));
    if (action === 'projects.listAllowed') {
      const page=this.page(evidence,action,['current-memberships',await store.deviceId(evidence)],p.cursor);
      const projects = await store.projects(evidence,page.position);
      if(projects.items.length>50)fail(503,'afos/page-too-large');
      return {contractVersion, principalId: evidence.principalId, items: projects.items.map(({id, organizationId, name}) => ({id, organizationId, name})), nextCursor:page.next(projects.nextPosition)};
    }
    if (action === 'materials.listAllowed') {
      const projectId = id(p.projectId);
      const project=await this.project(store, evidence, projectId);
      const page=this.page(evidence,action,[project.organizationId,projectId,await store.deviceId(evidence)],p.cursor);
      const materials = await store.materials(evidence, projectId,page.position);
      if(materials.items.length>50)fail(503,'afos/page-too-large');
      return {contractVersion,items: materials.items.map(({id, revisionId, hash, name}) => ({id, revisionId, sha256:hash, name})), nextCursor:page.next(materials.nextPosition)};
    }
    if (action === 'materials.readRevision') {
      const material = await store.material(evidence, id(p.materialId), id(p.revisionId));
      if (!material) fail(404, 'afos/material-not-found');
      await this.project(store, evidence, material.projectId);
      if (digest(material.text) !== material.hash) fail(409, 'afos/material-integrity');
      return {contractVersion, materialId: material.id, revisionId: material.revisionId, sha256: material.hash, text: material.text };
    }
    if (action === 'runs.authorizeLocal') {
      const project = await this.project(store, evidence, id(p.projectId));
      id(project.id,128);
      if (p.releaseId !== this.releaseId) fail(403, 'afos/release-not-allowed');
      const deviceId=id(await store.deviceId(evidence));
      const allowedActions=['materials.readRevision','runs.getReceipt'];
      if(this.modelEnabled)allowedActions.push('models.stream');
      try { if(await store.project(evidence,project.id,'archive'))allowedActions.push('artifacts.stageUpload','artifacts.commitDraft'); }
      catch(error) { if(!(error&&typeof error==='object'&&'status' in error&&error.status===403))throw error; }
      const inputs = inputRefs(p.inputRefs);
      for (const ref of inputs) {
        const material = await store.material(evidence, ref.materialId, ref.revisionId);
        if (!material || material.projectId !== project.id || material.hash !== ref.hash || digest(material.text) !== ref.hash) fail(403, 'afos/input-denied');
      }
      const requestHash = digest(JSON.stringify([project.id, this.releaseId, this.policyRevision, deviceId, inputs]));
      const runId = digest(JSON.stringify([evidence.issuer,evidence.principalId,project.organizationId,action,id(p.clientRequestId)]));
      const previous = await store.get('runs', runId);
      if (previous) {
        if (previous.requestHash !== requestHash) fail(409, 'afos/idempotency-conflict');
        await this.run(store, evidence, runId, 'read');
        return wireRun(previous);
      }
      const run: Run = { id: runId, issuer:evidence.issuer, principalId: evidence.principalId, organizationId: project.organizationId, deviceId, projectId: project.id, releaseId: this.releaseId, policyRevision:this.policyRevision, allowedActions, inputs, issuedAt:Date.now(), expiresAt: Math.min(evidence.expiresAt, Date.now() + 30 * 60_000), attempt: 1, requestHash };
      await store.insert('runs', run);
      return wireRun(run);
    }
    if (action === 'runs.getReceipt') {
      const run = await store.get('runs', id(p.runId));
      if (!run || run.principalId !== evidence.principalId) fail(404, 'afos/run-not-found');
      if(run.issuer!==evidence.issuer||run.deviceId!==await store.deviceId(evidence))fail(403,'afos/run-binding-changed');
      if(run.projectId!==id(p.projectId))fail(403,'afos/run-project-mismatch');
      const project = await this.project(store, evidence, run.projectId);
      if (project.organizationId !== run.organizationId) fail(403, 'afos/organization-changed');
      const receipt = await store.get('receipts', run.id);
      return receipt ? {contractVersion, status: 'archived', authorization:wireRun(run),receipt:wireReceipt(receipt) } : {contractVersion, status: run.expiresAt <= Date.now() ? 'expired' : 'authorized', authorization:wireRun(run),runId: run.id, clientExecution: 'unknown' };
    }
    const run = await this.run(store, evidence, id(p.runId), 'archive');
    if(!run.allowedActions.includes(action==='artifacts.upload'?'artifacts.stageUpload':action))fail(403,'afos/run-action-denied');
    if(p.attempt!==run.attempt)fail(409,'afos/attempt-mismatch');
    if (action === 'artifacts.stageUpload') {
      const bytes = p.bytes;
      if (!Number.isSafeInteger(bytes) || typeof bytes !== 'number' || bytes < 1 || bytes > 1_048_576 || p.mime !== 'text/plain') fail(400, 'afos/invalid-upload');
      const upload: Upload = { id: randomUUID(), runId: run.id, principalId: evidence.principalId, bytes, hash: hash(p.sha256), expiresAt: Math.min(run.expiresAt, Date.now() + 10 * 60_000) };
      await store.insert('uploads', upload);
      return {contractVersion, uploadId: upload.id, expiresAt: new Date(upload.expiresAt).toISOString(), bytes: upload.bytes };
    }
    const upload = await store.get('uploads', id(p.uploadId));
    if (!upload || upload.runId !== run.id || upload.principalId !== evidence.principalId || upload.expiresAt <= Date.now()) fail(403, 'afos/upload-denied');
    if (action === 'artifacts.upload') {
      if (typeof p.content !== 'string' || Buffer.byteLength(p.content) !== upload.bytes || digest(p.content) !== upload.hash) fail(409, 'afos/upload-integrity');
      if (upload.content !== undefined && upload.content !== p.content) fail(409, 'afos/immutable-upload');
      await store.replaceUpload({ ...upload, content: p.content });
      return {contractVersion, uploadId: upload.id, received: true };
    }
    if (upload.content === undefined || Buffer.byteLength(upload.content) !== upload.bytes || digest(upload.content) !== upload.hash) fail(409, 'afos/upload-incomplete');
    const inputs = inputRefs(p.inputRefs);
    if (JSON.stringify(inputs) !== JSON.stringify(run.inputs)) fail(409, 'afos/source-mismatch');
    const requestHash = digest(JSON.stringify([run.id, upload.hash, inputs, id(p.clientRequestId)]));
    const requestId=digest(JSON.stringify([evidence.issuer,evidence.principalId,run.organizationId,action,id(p.clientRequestId)]));
    const request=await store.get('commitRequests',requestId);
    if(request&&(request.runId!==run.id||request.requestHash!==requestHash))fail(409,'afos/idempotency-conflict');
    const previous = await store.get('receipts', run.id);
    if (previous) {
      if (previous.requestHash !== requestHash) fail(409, 'afos/idempotency-conflict');
      return wireReceipt(previous);
    }
    if(request)fail(503,'afos/inconsistent-receipt');
    const artifact: Artifact = { id: randomUUID(), projectId: run.projectId, runId: run.id, revisionId: randomUUID(), hash: upload.hash, content: upload.content, sources: run.inputs, releaseId: run.releaseId, status: 'draft-needs-review' };
    const receipt: Receipt = { id: run.id, runId: run.id, attempt:run.attempt, artifactId: artifact.id, revisionId: artifact.revisionId, hash: artifact.hash, archivedAt: new Date().toISOString(), requestHash };
    await store.insert('commitRequests',{id:requestId,runId:run.id,requestHash});
    await store.insert('artifacts', artifact);
    await store.insert('receipts', receipt);
    return wireReceipt(receipt);
  }
}
