import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import Tools from '@deepseek-ai/dsh-tools';
import { NocoBaseIdentityProvider } from '../dist/authority.js';
import { NocoBaseIdentityService } from '../dist/index.js';
import { AccessManager, SessionAccessBridge, ToolAccessBridge } from '../../../plugins/access/dist/index.js';
import { AuditJournal } from '../../../plugins/audit/dist/index.js';

const binding = { issuer: 'https://identity.example.test/oidc', subject: 'account-a', organizationId: 'org-a', deviceId: 'device-a' };
function authority() {
  const controls = { allow: true, calls: 0 };
  const state = () => ({ binding, expiresAt: Date.now() + 60_000, profile: {
    principalId: 'account-a', principalKind: 'human', resolvedBy: 'server',
    organization: { id: 'org-a', kind: 'team', name: 'Enterprise', revision: 'org-r1' },
    membership: { organizationId: 'org-a', principalId: 'account-a', principalKind: 'human', role: 'member', state: 'active', revision: 'member-r1' },
  } });
  return { controls, async current() { return state(); }, async authorize() {
    controls.calls += 1;
    return { ...state(), decision: { effect: controls.allow ? 'allow' : 'deny', code: controls.allow ? 'server/allow' : 'server/revoked', authorizationRevision: 'acl-r1', grantIds: [] } };
  } };
}
async function boot(root, source, options = {}) {
  const ctx = new Context();
  try {
    const provider = new NocoBaseIdentityProvider(binding, source, options.freshnessMs ?? 1000);
    ctx.provide('workdshIdentity', provider);
    ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root });
    await ctx.plugin(StorageDomain, { backend: 'json' }); await ctx.plugin(Tools);
    await ctx.plugin(AuditJournal); await ctx.plugin(AccessManager, { enterprise: true });
    await ctx.plugin(ToolAccessBridge, { autoBindPersonalSessions: false });
    return { ctx, provider };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
function fixture(ctx, counters) {
  ctx.tools.register({ name: 'enterprise_fixture', description: 'Offline enterprise policy test.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute() { counters.calls += 1; return {}; },
  });
}
const execute = (ctx, sessionId) => ctx.tools.execute({ name: 'enterprise_fixture', arguments: {}, callId: 'fixture-' + Math.random(), signal: new AbortController().signal, ...(sessionId ? { agent: { id: sessionId } } : {}) });
async function harness(callback, options) {
  const root = await mkdtemp(join(tmpdir(), 'afos-identity-access-')); let ctx;
  try { const source = authority(); const booted = await boot(root, source, options); ctx = booted.ctx; await callback({ ...booted, source }); }
  finally { if (ctx) await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
}

test('explicit Cordis identity service uses trusted authority and cutoffs on disposal', async () => {
  const ctx = new Context(); const source = authority(); ctx.provide('afosIdentityAuthority', source);
  await ctx.plugin(NocoBaseIdentityService, { binding });
  const service = ctx.workdshIdentity; const actor = await service.resolve();
  assert.equal(actor.principalId, 'account-a'); assert.equal(service.profile().organization.kind, 'team');
  await ctx.fiber.dispose(); await assert.rejects(service.resolve(), /cutoff/u);
});

test('enterprise refuses automatic ownership and missing agents through the real official tool pipeline', async () => {
  await harness(async ({ ctx, provider }) => {
    const counts = { calls: 0 }; fixture(ctx, counts);
    assert.equal((await execute(ctx, 'unknown-session')).isError, true);
    assert.equal(ctx.workdshAccess.sessionOwner('unknown-session'), undefined);
    assert.equal((await execute(ctx)).isError, true); assert.equal(counts.calls, 0);
    const actor = await provider.resolve({ sessionId: 'owned-session' });
    await ctx.workdshAccess.bindSession(actor, { sessionId: 'owned-session' });
    assert.equal((await execute(ctx, 'owned-session')).isError, false); assert.equal(counts.calls, 1);
    assert.equal(ctx.workdshAccess.sessionOwner('owned-session').ownerPrincipalId, 'account-a');
    await assert.rejects(ctx.workdshAccess.bindSession({ ...actor, principalId: 'account-b' }, { sessionId: 'owned-session' }), /stale-actor/u);
  });
});

test('current-server denial applies to an existing Session owner; local enterprise grant writes are disabled', async () => {
  await harness(async ({ ctx, provider, source }) => {
    const actor = await provider.resolve({ sessionId: 'owned-session' });
    await ctx.workdshAccess.bindSession(actor, { sessionId: 'owned-session' });
    const counts = { calls: 0 }; fixture(ctx, counts);
    assert.equal((await execute(ctx, 'owned-session')).isError, false);
    source.controls.allow = false;
    assert.equal((await execute(ctx, 'owned-session')).isError, true); assert.equal(counts.calls, 1);
    assert.ok(source.controls.calls >= 3);
    await assert.rejects(ctx.workdshAccess.putGrant(actor, {}, {}), { code: 'access/enterprise-grants-server-owned' });
    await assert.rejects(ctx.workdshAccess.revokeGrant(actor, {}, 'grant', 'revision'), { code: 'access/enterprise-grants-server-owned' });
  });
});

test('official final guard denies cutoff during a later asynchronous policy and cannot be force-allowed', async () => {
  await harness(async ({ ctx, provider }) => {
    const actor = await provider.resolve({ sessionId: 'owned-session' });
    await ctx.workdshAccess.bindSession(actor, { sessionId: 'owned-session' });
    const counts = { calls: 0 }; fixture(ctx, counts);
    ctx.on('tools/pre-execute', async (_exec, next) => { const result = await next(); provider.cutoff(); return { ...result, kind: 'allow' }; });
    const result = await execute(ctx, 'owned-session');
    assert.equal(result.isError, true); assert.equal(counts.calls, 0);
    assert.match(result.error.message, /enterprise-tool-stale/u);
  });
});

test('official final guard denies stale authority after a later policy delay', async () => {
  await harness(async ({ ctx, provider }) => {
    const actor = await provider.resolve({ sessionId: 'owned-session' });
    await ctx.workdshAccess.bindSession(actor, { sessionId: 'owned-session' });
    const counts = { calls: 0 }; fixture(ctx, counts);
    ctx.on('tools/pre-execute', async (_exec, next) => { const result = await next(); await new Promise(resolve => setTimeout(resolve, 1050)); return result; });
    const result = await execute(ctx, 'owned-session');
    assert.equal(result.isError, true); assert.equal(counts.calls, 0);
  }, { freshnessMs: 1000 });
});

test('trusted Session bridge rejects existing unowned or bound creation and resumes only under current authority', async () => {
  await harness(async ({ ctx, provider, source }) => {
    const existing = new Set(['orphan']); const creates = []; const resumes = [];
    ctx.provide('sessionController', {
      async inspect(sessionId) { if (!existing.has(String(sessionId))) throw { code: 'session/not-found' }; return {}; },
      async create(request) { creates.push(request.sessionId); existing.add(String(request.sessionId)); return { sessionId: request.sessionId }; },
      async resolveAgent(sessionId) { resumes.push(sessionId); return { agent: { id: sessionId } }; },
    });
    await ctx.plugin(SessionAccessBridge);
    await assert.rejects(ctx.workdshSessionAccess.create({ sessionId: 'orphan' }), { code: 'access/unbound-session-adoption' });
    assert.equal(ctx.workdshAccess.sessionOwner('orphan'), undefined);
    const created = await ctx.workdshSessionAccess.create({ sessionId: 'new-session' });
    assert.equal(created.sessionId, 'new-session'); assert.deepEqual(creates, ['new-session']);
    await assert.rejects(ctx.workdshSessionAccess.create({ sessionId: 'new-session' }), { code: 'access/unbound-session-adoption' });
    await assert.rejects(ctx.workdshSessionAccess.resolveAgent('orphan'), { code: 'access/runtime-unbound' });
    assert.ok('agent' in await ctx.workdshSessionAccess.resolveAgent('new-session'));
    source.controls.allow = false;
    await assert.rejects(ctx.workdshSessionAccess.resolveAgent('new-session'), { code: 'server/revoked' });
    assert.deepEqual(resumes, ['new-session']);
    const owner = ctx.workdshAccess.sessionOwner('new-session');
    provider.cutoff(); assert.equal(ctx.workdshAccess.sessionOwner('new-session'), owner);
  });
});


test('around-dispatch cooperative signal prevents body start after cutoff in a preserving wrapper', async () => {
  await harness(async ({ ctx, provider }) => {
    const actor = await provider.resolve({ sessionId: 'owned-session' });
    await ctx.workdshAccess.bindSession(actor, { sessionId: 'owned-session' });
    const counts = { calls: 0 }; fixture(ctx, counts);
    ctx.on('tools/execute', async (_exec, next) => { provider.cutoff(); await new Promise(resolve => setTimeout(resolve, 10)); return next(); });
    const result = await execute(ctx, 'owned-session');
    assert.equal(result.isError, true); assert.equal(counts.calls, 0);
    assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH');
  });
});

test('around-dispatch cooperative signal prevents body start after deadline in a preserving wrapper', async () => {
  await harness(async ({ ctx, provider }) => {
    const actor = await provider.resolve({ sessionId: 'owned-session' });
    await ctx.workdshAccess.bindSession(actor, { sessionId: 'owned-session' });
    const counts = { calls: 0 }; fixture(ctx, counts);
    ctx.on('tools/execute', async (_exec, next) => { await new Promise(resolve => setTimeout(resolve, 1050)); return next(); });
    const result = await execute(ctx, 'owned-session');
    assert.equal(result.isError, true); assert.equal(counts.calls, 0);
    assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH');
  });
});
