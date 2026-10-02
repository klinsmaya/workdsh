import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sqlite3 from 'sqlite3';
import { Database } from '@nocobase/database';
import Plugin, { NocoBaseBridgeStore } from '../../../dist/server/plugin.js';
import { AgentBridge, digest } from '../../../dist/server/core.js';
import { NocoBaseModelUsageLedger } from '../../../dist/server/model.js';

// SQL and NocoBase repositories/hooks are real. The identity provider and ACL
// policy owner are bounded fixtures; this does not test a deployed IdP or ACL.
const issuer = 'https://enterprise.example/api';
const audience = `${issuer}/afos`;
const baseFields = [{ name: 'id', type: 'string', primaryKey: true }];
export const reservation = (callId = 'one', scopeKey = 'alice-org-project') => ({
  scopeKey, callId, run: { runId: 'run-one', attempt: 1 }, reservedTokens: 30, limitTokens: 50,
});
export const settlement = (callId = 'one', usage = { status: 'unknown' }) => ({
  scopeKey: reservation().scopeKey, callId, outcome: 'completed', usage, cost: { status: 'unknown' },
});
export const budgetId = createHash('sha256').update(JSON.stringify(reservation().scopeKey)).digest('hex');

export async function fixture(t, options = {}) {
  const directory = options.storage ? undefined : await mkdtemp(join(tmpdir(), 'afos-nocobase-sql-'));
  const storage = options.storage ?? join(directory, 'afos-test.sqlite');
  const sql = [];
  const databases = [];
  t.after(async () => {
    for (const db of databases) await db.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function connection() {
    const db = new Database({
      dialect: 'sqlite', storage, dialectModule: sqlite3,
      logging: statement => sql.push(statement), retry: { max: 0 },
    });
    databases.push(db);
    db.collection({ name: 'roles', autoGenId: false, fields: [...baseFields, { name: 'name', type: 'string' }] });
    db.collection({ name: 'users', autoGenId: false, fields: [
      ...baseFields, { name: 'roles', type: 'belongsToMany', target: 'roles' },
    ] });
    db.collection({ name: 'oidcStates', autoGenId: false, fields: [
      ...baseFields, { name: 'model', type: 'string' }, { name: 'oidcId', type: 'string' },
      { name: 'expiresAt', type: 'date' }, { name: 'payload', type: 'json' },
    ] });
    const middlewares = [], resources = [];
    const app = {
      db,
      pm: { get: () => ({ service: {
        registerResourceServer() {}, unregisterResourceServer() {},
        resolveClient: async () => ({
          client_id: 'desktop', scope: 'afos', subject_type: 'public', application_type: 'native',
          token_endpoint_auth_method: 'none', redirect_uris: ['http://127.0.0.1/oauth/callback'],
        }),
        runWithProviderContext: (_ctx, fn) => fn(),
      } }) },
      acl: {
        resolveActionParams: async (_ctx, request) => ({ mergedParams: request.params }),
        allow() {},
      },
      use: handler => middlewares.push(handler),
      resourceManager: { options: { prefix: '/api' }, define: config => resources.push(config) },
    };
    const plugin = new Plugin(app, { name: 'agent-bridge', bridge: {
      issuer, audience, jwksUrl: `${issuer}/jwks`, clientIds: ['desktop'], releaseId: 'release', policyRevision: 'policy',
    } });
    await plugin.beforeLoad();
    if (!options.noSync) await db.sync();
    const ctx = { state: { currentUser: { get: key => key === 'id' ? 'alice' : undefined }, currentRoles: ['member'] } };
    const store = new NocoBaseBridgeStore(app, ctx, audience);
    return { db, app, plugin, store, middlewares, resources, ledger: new NocoBaseModelUsageLedger(app) };
  }
  const primary = await connection();
  if (!options.noSeed) {
    const repo = name => primary.db.getRepository(name);
    await repo('roles').create({ values: { id: 'member', name: 'member' } });
    await repo('users').create({ values: { id: 'alice', roles: ['member'] } });
    await repo('oidcStates').create({ values: { id: 'grant-row', model: 'Grant', oidcId: 'grant',
      expiresAt: new Date(Date.now() + 3_600_000), payload: { kind: 'Grant', jti: 'grant', accountId: 'alice',
        clientId: 'desktop', exp: Math.floor(Date.now() / 1000) + 3600, resources: { [audience]: 'afos' } } } });
    await repo('afosClientAccess').create({ values: { id: 'client-access', principalId: 'alice', clientId: 'desktop',
      deviceId: 'device-one', active: true, notBefore: Date.now() - 10_000 } });
    await repo('afosProjects').create({ values: { id: 'project', organizationId: 'org', name: 'Project', active: true } });
    await repo('afosProjectMembers').create({ values: { id: 'membership', organizationId: 'org', projectId: 'project',
      principalId: 'alice', active: true, canArchive: true } });
    await repo('afosMaterials').create({ values: { id: 'material', projectId: 'project', revisionId: 'revision',
      hash: digest('source text'), name: 'Material', text: 'source text' } });
  }
  const evidence = { issuer, principalId: 'alice', clientId: 'desktop', grantId: 'grant', tokenId: 'token',
    issuedAt: Date.now(), expiresAt: Date.now() + 3_600_000 };
  const inputRefs = [{ materialId: 'material', revisionId: 'revision', sha256: digest('source text') }];
  const bridge = new AgentBridge(primary.store, 'release', 'policy', new Uint8Array(32).fill(1));
  const authorize = (clientRequestId = 'run-request') => bridge.dispatch(evidence, 'runs.authorizeLocal', {
    projectId: 'project', releaseId: 'release', inputRefs, clientRequestId,
  });
  async function upload(run, content = 'Local draft') {
    const staged = await bridge.dispatch(evidence, 'artifacts.stageUpload', {
      runId: run.runId, attempt: run.attempt, mime: 'text/plain', bytes: Buffer.byteLength(content), sha256: digest(content),
    });
    await bridge.dispatch(evidence, 'artifacts.upload', {
      runId: run.runId, attempt: run.attempt, uploadId: staged.uploadId, content,
    });
    return { runId: run.runId, attempt: run.attempt, uploadId: staged.uploadId, inputRefs, clientRequestId: 'commit-request' };
  }
  return { ...primary, sql, storage, connection, evidence, bridge, inputRefs, authorize, upload };
}

