import { Plugin, type Application } from '@nocobase/server';
import { Transaction } from '@nocobase/database';
import { parseRequest } from '@nocobase/resourcer';
import { accessVerifier, bearerToken, isEnterpriseTokenCandidate, safeServerEpoch, type AccessEvidence, type ResourceConfig } from './auth.js';
import { AgentBridge, BridgeError, contractVersion, type BridgeStore, type Material, type MaterialSummary, type Project, type Tables, type Upload } from './core.js';
import { randomBytes } from 'node:crypto';

interface BridgeConfig extends ResourceConfig { releaseId: string; policyRevision:string }
interface RequestContext {
  path: string;
  method: string;
  request: { body?: unknown };
  query?: Record<string, unknown>;
  getBearerToken?(): string | undefined;
  state: { currentUser?: { get(key: string): unknown } };
  get(name: string): string;
  body: unknown;
  status: number;
  withoutDataWrapping?: boolean;
}
interface IdpService {
  registerResourceServer(name: string, config: {path: string; identifier: string; audience: string; scope: string; accessTokenFormat: 'jwt'; jwt: {sign: {alg: 'RS256'}}}): void;
  unregisterResourceServer(name: string): void;
  resolveClient(clientId: string): Promise<ClientMetadata | undefined>;
  runWithProviderContext<T>(ctx: RequestContext, callback: () => T): T;
}
interface ClientMetadata { client_id?:string; scope?:string; subject_type?:string; application_type?:string; token_endpoint_auth_method?:string; redirect_uris?:string[] }
interface Row { get(key: string): unknown; toJSON(): Record<string, unknown> }
const tableNames = { runs: 'afosRuns', uploads: 'afosUploads', receipts: 'afosReceipts', artifacts: 'afosArtifacts',commitRequests:'afosCommitRequests' } as const;
const privateCollections = new Set<string>([...Object.values(tableNames), 'afosAudit', 'afosClientAccess', 'afosRevokedTokens']);

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new BridgeError(500, 'afos/invalid-server-record');
  return value;
}
function projectRow(row: Row): Project { return { id: text(row.get('id')), organizationId: text(row.get('organizationId')), name: text(row.get('name')) }; }
function materialRow(row: Row): Material {
  const content = row.get('text');
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1_048_576) throw new BridgeError(500, 'afos/invalid-server-material');
  return { id: text(row.get('id')), projectId: text(row.get('projectId')), revisionId: text(row.get('revisionId')), hash: text(row.get('hash')), name: text(row.get('name')), text: content };
}

/** oidcStates uses unixTimestamp(second), whose getter may return a Date. */
function currentOidcRow(row: Row | null | undefined): boolean {
  if (!row) return false;
  const value = row.get('expiresAt');
  if (value === null || value === undefined) return true;
  const milliseconds = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value * 1_000
    : typeof value === 'string' ? /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1_000 : Date.parse(value)
    : NaN;
  return Number.isFinite(milliseconds) && milliseconds > Date.now();
}

/** All internal rows are private bridge state; business records always pass current ACL. */
export class NocoBaseBridgeStore implements BridgeStore {
  readonly app: Application;
  readonly ctx: RequestContext;
  readonly tx: Transaction | undefined;
  readonly audience: string;
  constructor(app: Application, ctx: RequestContext, audience: string, tx?: Transaction) { this.app = app; this.ctx = ctx; this.audience = audience; this.tx = tx; }
  private transactionOptions() { return this.tx ? { transaction: this.tx } : {}; }
  async tokenActive(evidence: AccessEvidence): Promise<boolean> {
    const row = await this.app.db.getRepository('afosClientAccess').findOne({ filter: {principalId:evidence.principalId,clientId:evidence.clientId,active:true}, ...this.transactionOptions() });
    const revoked = await this.app.db.getRepository('afosRevokedTokens').findOne({filterByTk:evidence.tokenId,...this.transactionOptions()});
    const user = await this.app.db.getRepository('users').findOne({ filterByTk: evidence.principalId, ...this.transactionOptions() });
    const grant = await this.app.db.getRepository('oidcStates').findOne({filter:{model:'Grant',oidcId:evidence.grantId},...this.transactionOptions()});
    const payload = grant?.get('payload') as {kind?:unknown;jti?:unknown;accountId?:unknown;clientId?:unknown;exp?:unknown;resources?:Record<string,unknown>;rejected?:{resources?:Record<string,unknown>}} | undefined;
    const idp = (this.app.pm.get('idp-oauth') as unknown as {service?:IdpService} | undefined)?.service;
    if (!idp || !currentOidcRow(grant as Row | null) || !payload || payload.kind !== 'Grant' || payload.jti !== evidence.grantId
      || payload.accountId !== evidence.principalId || payload.clientId !== evidence.clientId
      || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp * 1_000 <= Date.now()
      || typeof payload.resources?.[this.audience] !== 'string') return false;
    const granted = (payload.resources[this.audience] as string).split(/\s+/u);
    const rejected = typeof payload.rejected?.resources?.[this.audience] === 'string' ? (payload.rejected.resources[this.audience] as string).split(/\s+/u) : [];
    if (!granted.includes('afos') || rejected.includes('afos')) return false;
    // Match the pinned provider's current resolver -> DB adapter read order.
    // Client.find caching and a removed resolver are not permission evidence.
    let client = await idp.runWithProviderContext(this.ctx, () => idp.resolveClient(evidence.clientId));
    if (!client) {
      const registered = await this.app.db.getRepository('oidcStates').findOne({filter:{model:'Client',oidcId:evidence.clientId},...this.transactionOptions()});
      if (currentOidcRow(registered as Row | null)) client = registered?.get('payload') as ClientMetadata | undefined;
    }
    if (client?.client_id !== evidence.clientId || !client.scope?.split(/\s+/u).includes('afos')
      || (client.subject_type ?? 'public') !== 'public' || client.application_type !== 'native'
      || client.token_endpoint_auth_method !== 'none'
      || !client.redirect_uris?.length || !client.redirect_uris.every(uri => {
        try { const url = new URL(uri); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/oauth/callback' && !url.username && !url.password && !url.search && !url.hash; }
        catch { return false; }
      })) return false;
    const notBefore = safeServerEpoch(row?.get('notBefore'));
    return Boolean(row && user && !revoked && notBefore !== undefined && evidence.issuedAt >= notBefore && evidence.expiresAt > Date.now());
  }
  async deviceId(evidence:AccessEvidence):Promise<string|undefined> {
    const row=await this.app.db.getRepository('afosClientAccess').findOne({filter:{principalId:evidence.principalId,clientId:evidence.clientId,active:true},...this.transactionOptions()});
    const value=row?.get('deviceId');
    return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/u.test(value)?value:undefined;
  }
  private async businessRows(resource: string, params: Record<string, unknown>): Promise<Row[]> {
    const permission = await this.app.acl.resolveActionParams(this.ctx, { resourceName: resource, actionName: 'list', params, useCurrentRepository: false });
    return this.app.db.getRepository(resource).find({ ...permission.mergedParams, ...this.transactionOptions() }) as Promise<Row[]>;
  }
  private async memberships(evidence: AccessEvidence, projectId?: string, archive = false): Promise<Row[]> {
    return this.app.db.getRepository('afosProjectMembers').find({ filter: {
      principalId: evidence.principalId, active: true,
      ...(projectId ? { projectId } : {}),
      ...(archive ? { canArchive: true } : {}),
    }, ...this.transactionOptions() }) as Promise<Row[]>;
  }
  async projects(evidence: AccessEvidence): Promise<Project[]> {
    const memberships = await this.memberships(evidence);
    if (!memberships.length) return [];
    const rows = await this.businessRows('afosProjects', { filter: { id: { $in: memberships.map(row => row.get('projectId')) }, active: true }, fields: ['id', 'organizationId', 'name'], sort: ['id'] });
    return rows.map(projectRow).filter(project => memberships.some(member => member.get('projectId') === project.id && member.get('organizationId') === project.organizationId));
  }
  async project(evidence: AccessEvidence, projectId: string, mode: 'read' | 'archive'): Promise<Project | undefined> {
    const members = await this.memberships(evidence, projectId, mode === 'archive');
    if (!members.length) return undefined;
    const rows = await this.businessRows('afosProjects', { filter: { id: projectId, active: true }, fields: ['id', 'organizationId', 'name'] });
    const project = rows[0] ? projectRow(rows[0]) : undefined;
    if (!project || !members.some(row => row.get('organizationId') === project.organizationId)) return undefined;
    if (mode === 'archive') {
      // Recheck the actual artifact create privilege; internal repository writes do not grant it.
      const permission = await this.app.acl.resolveActionParams(this.ctx, { resourceName: 'afosArtifacts', actionName: 'create', params: { values: { projectId } }, useCurrentRepository: false });
      const values = permission.mergedParams?.values as Record<string, unknown> | undefined;
      if (!values || values.projectId !== projectId) return undefined;
    }
    return project;
  }
  async materials(evidence: AccessEvidence, projectId: string): Promise<MaterialSummary[]> {
    if (!await this.project(evidence, projectId, 'read')) return [];
    const rows = await this.businessRows('afosMaterials', { filter: { projectId }, fields: ['id', 'projectId', 'revisionId', 'hash', 'name'], sort: ['id'] });
    return rows.map(row => ({id:text(row.get('id')),projectId:text(row.get('projectId')),revisionId:text(row.get('revisionId')),hash:text(row.get('hash')),name:text(row.get('name'))}));
  }
  async material(evidence: AccessEvidence, materialId: string, revisionId: string): Promise<Material | undefined> {
    const rows = await this.businessRows('afosMaterials', { filter: { id: materialId, revisionId }, fields: ['id', 'projectId', 'revisionId', 'hash', 'name', 'text'] });
    const material = rows[0] ? materialRow(rows[0]) : undefined;
    return material && await this.project(evidence, material.projectId, 'read') ? material : undefined;
  }
  async get<K extends keyof Tables>(table: K, id: string): Promise<Tables[K] | undefined> {
    const row = await this.app.db.getRepository(tableNames[table]).findOne({ filterByTk: id, ...this.transactionOptions(), ...(this.tx ? { lock: this.tx.LOCK.UPDATE } : {}) });
    return row?.get('payload') as Tables[K] | undefined;
  }
  async insert<K extends keyof Tables>(table: K, value: Tables[K]): Promise<void> {
    const values = { id: value.id, ...(table === 'artifacts' ? { projectId: (value as Tables['artifacts']).projectId } : {}), payload: value };
    if (table === 'artifacts') {
      const permission = await this.app.acl.resolveActionParams(this.ctx, {resourceName:tableNames.artifacts,actionName:'create',params:{values},useCurrentRepository:false});
      const merged = permission.mergedParams as {values?:unknown;whitelist?:unknown;blacklist?:unknown;filter?:unknown};
      const whitelist = Array.isArray(merged.whitelist) ? merged.whitelist : undefined;
      const blacklist = Array.isArray(merged.blacklist) ? merged.blacklist : undefined;
      if (JSON.stringify(merged.values) !== JSON.stringify(values)
        || whitelist && Object.keys(values).some(key => !whitelist.includes(key))
        || blacklist && Object.keys(values).some(key => blacklist.includes(key))
        || merged.filter && Object.keys(merged.filter).length > 0) throw new BridgeError(403, 'afos/artifact-fields-denied');
      await this.app.db.getRepository(tableNames.artifacts).create({...permission.mergedParams,...this.transactionOptions()});
      return;
    }
    await this.app.db.getRepository(tableNames[table]).create({ values, ...this.transactionOptions() });
  }
  async replaceUpload(value: Upload): Promise<void> {
    await this.app.db.getRepository(tableNames.uploads).update({ filterByTk: value.id, values: { payload: value }, ...this.transactionOptions() });
  }
  transaction<T>(callback: (store: BridgeStore) => Promise<T>): Promise<T> {
    if (this.tx) return callback(this);
    return this.app.db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, tx => callback(new NocoBaseBridgeStore(this.app, this.ctx, this.audience, tx)));
  }
  async audit(event: Parameters<BridgeStore['audit']>[0]): Promise<void> {
    await this.app.db.getRepository('afosAudit').create({ values: { id: crypto.randomUUID(), ...event } });
  }
}

export default class PluginAgentBridge extends Plugin {
  private readonly verified = new WeakMap<object, AccessEvidence>();
  private idp: IdpService | undefined;
  private bridgeEnabled = false;
  override async beforeLoad(): Promise<void> {
    const baseFields = [{ name: 'id', type: 'string', primaryKey: true }];
    const stringFields = (names: string[]) => names.map(name => ({name, type: 'string'}));
    this.db.collection({ name: 'afosProjects', autoGenId: false, fields: [...baseFields, ...stringFields(['organizationId', 'name']), { name: 'active', type: 'boolean', defaultValue: true }] });
    this.db.collection({ name: 'afosProjectMembers', autoGenId: false, fields: [...baseFields, ...stringFields(['organizationId', 'projectId', 'principalId']), { name: 'active', type: 'boolean', defaultValue: false }, { name: 'canArchive', type: 'boolean', defaultValue: false }] });
    this.db.collection({ name: 'afosMaterials', autoGenId: false, fields: [...baseFields, ...stringFields(['projectId', 'revisionId', 'hash', 'name']), { name: 'text', type: 'text' }] });
    this.db.collection({name:'afosClientAccess',autoGenId:false,indexes:[{unique:true,fields:['principalId','clientId']}],fields:[...baseFields,...stringFields(['principalId','clientId','deviceId']),{name:'active',type:'boolean',defaultValue:false},{name:'notBefore',type:'bigInt'}]});
    this.db.collection({name:'afosRevokedTokens',autoGenId:false,fields:[...baseFields]});
    for (const name of Object.values(tableNames)) this.db.collection({ name, autoGenId: false, fields: [...baseFields, ...(name === 'afosArtifacts' ? stringFields(['projectId']) : []), { name: 'payload', type: 'json' }] });
    this.db.collection({ name: 'afosAudit', autoGenId: false, fields: [...baseFields, ...stringFields(['principalId', 'action', 'outcome', 'requestId', 'code'])] });
    // Ordinary NocoBase CRUD also reaches these collections. Revisions are
    // append-only even when a role has broad collection update/delete ACL.
    for (const name of ['afosMaterials', 'afosArtifacts', 'afosReceipts']) {
      for (const hook of ['beforeUpdate', 'beforeBulkUpdate', 'beforeDestroy', 'beforeBulkDestroy']) {
        this.db.on(`${name}.${hook}`, () => { throw new BridgeError(409, 'afos/immutable-record'); });
      }
    }
  }
  override async load(): Promise<void> {
    const config = this.options.bridge as BridgeConfig | undefined;
    if (!config || typeof config.releaseId !== 'string'||!config.releaseId||config.releaseId.length>128||typeof config.policyRevision!=='string'||!config.policyRevision||config.policyRevision.length>128) throw new Error('afos/managed-config-required');
    const cursorKey=randomBytes(32);
    const verify = accessVerifier(config);
    const idp = this.app.pm.get('idp-oauth') as unknown as {service?: IdpService} | undefined;
    if (!idp?.service) throw new Error('afos/idp-required');
    this.idp = idp.service;
    this.idp.registerResourceServer('afos', { path: '/afos', identifier: config.audience, audience: config.audience, scope: 'afos offline_access', accessTokenFormat: 'jwt', jwt: {sign: {alg: 'RS256'}} });
    const gateway = `${new URL(config.issuer).pathname.replace(/\/$/u, '')}/afos`;
    // A create ACL is used by the domain operation, not a generic API grant.
    // Keep private state inaccessible even with a broad ordinary API role.
    for (const name of privateCollections) this.app.resourceManager.define({name,only:['afosPrivateDenied'],actions:{afosPrivateDenied:async (ctx:RequestContext)=>{ctx.status=403;ctx.body={code:'afos/private-resource'};}}});
    this.app.use(async (ctx: RequestContext, next: () => Promise<void>) => {
      let parsed: ReturnType<typeof parseRequest>;
      try { parsed = parseRequest({path:ctx.path,method:ctx.method},{prefix:this.app.resourceManager.options?.prefix ?? new URL(config.issuer).pathname}); }
      catch { ctx.status=400;ctx.body={code:'afos/invalid-route'};return; }
      if (parsed && [parsed.resourceName,parsed.associatedName].some(name => name?.split('.').some(part => privateCollections.has(part)))) {
        ctx.status=403;ctx.body={code:'afos/private-resource'};return;
      }
      const header = ctx.get('Authorization');
      const token = ctx.getBearerToken?.() ?? bearerToken(header) ?? '';
      const queryToken = typeof ctx.query?.token === 'string' ? ctx.query.token : '';
      const bridgePath = ctx.path === gateway;
      if (!bridgePath && !isEnterpriseTokenCandidate(token, config) && !isEnterpriseTokenCandidate(queryToken, config)) return next();
      if (!this.bridgeEnabled || !bridgePath || !['POST', 'GET'].includes(ctx.method) || queryToken || !bearerToken(header)
        || token !== bearerToken(header) || ctx.get('X-Role') || ctx.get('X-Data-Source')) {
        ctx.status = 403; ctx.body = { code: 'afos/resource-not-allowed' }; return;
      }
      try { this.verified.set(ctx, await verify(token)); }
      catch { ctx.status = 401; ctx.body = { code: 'afos/access-denied' }; return; }
      await next();
    }, { tag: 'afos-verified-resource', after: 'bodyParser', before: 'idp-oauth-resource-auth' });
    const handler = async (ctx: RequestContext) => {
      ctx.withoutDataWrapping = true;
      const evidence = this.verified.get(ctx);
      if (!this.bridgeEnabled || !evidence || String(ctx.state.currentUser?.get('id')) !== evidence.principalId) {
        ctx.status = 401; ctx.body = { code: 'afos/access-denied' }; return;
      }
      const body = ctx.method === 'GET' ? {contractVersion:ctx.get('X-AFOS-Contract'),action:'projects.listAllowed',params:{}} : ctx.request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 1_100_000) {
        ctx.status = 400; ctx.body = {code:'afos/invalid-request'}; return;
      }
      const request = body as {contractVersion?:unknown;action?:unknown;params?:unknown};
      if(request.contractVersion!==contractVersion||Object.keys(request).some(key=>!['contractVersion','action','params'].includes(key))){ctx.status=400;ctx.body={code:'afos/contract-not-supported'};return;}
      const bridge = new AgentBridge(new NocoBaseBridgeStore(this.app, ctx, config.audience), config.releaseId,config.policyRevision,cursorKey);
      try { ctx.body = await bridge.dispatch(evidence, request.action, request.params); }
      catch (error) { ctx.status = error instanceof BridgeError ? error.status : 503; ctx.body = {code:error instanceof BridgeError ? error.code : 'afos/request-unknown'}; }
    };
    this.app.resourceManager.define({ name: 'afos', only: ['list', 'create'], actions: { list: handler, create: handler } });
    this.app.acl.allow('afos', ['list', 'create'], 'loggedIn');
    this.bridgeEnabled = true;
  }
  override async afterDisable(): Promise<void> { this.bridgeEnabled=false;this.idp?.unregisterResourceServer('afos'); }
}
