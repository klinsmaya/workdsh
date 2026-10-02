// Independent public API review probe. Real AgentRegistry and Tools are used,
// but the registered driver, authority, and business bridge remain fixtures.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import Tools from '@deepseek-ai/dsh-tools';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { EnterpriseProfileIngress, fixedEnterpriseComposition } from '../dist/index.js';

const ctx = new Context();
const caller = new AbortController();
const authorityLifetime = new AbortController();
let cancellations = 0;
const actors = new WeakSet();
try {
  ctx.provide('afosProfileAuthority', {
    identity: {
      enterprise: true,
      async resolve(evidence) { const actor = { principalId: 'alice', organizationId: 'org-a', resolvedBy: 'workdsh-identity-nocobase', requestId: 'review', ...evidence }; actors.add(actor); return actor; },
      assertCurrentActor(actor) { assert.ok(actors.has(actor)); },
      actorSignal() { return authorityLifetime.signal; },
    },
    access: {
      sessionOwner(id) { return id === 'session-a' ? { organizationId: 'org-a', ownerPrincipalId: 'alice', sessionId: id, revision: 'review' } : undefined; },
      async authorize() { return { effect: 'allow' }; },
    },
  });
  ctx.provide('afosProfileBridge', { async createSession() { return { sessionId: 'session-a' }; } });
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
  await ctx.plugin(HostConnectionService, { fixture: true });
  await ctx.plugin(Tools);
  await ctx.plugin(AgentRegistry);
  const agent = { id: 'session-a', session: { id: 'session-a' }, ctx, cancel() { cancellations++; caller.abort(); } };
  const detach = await ctx.agents.register(agent);
  await ctx.plugin(EnterpriseProfileIngress, fixedEnterpriseComposition());
  await ctx.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: caller.signal }, () => Promise.resolve({ kind: 'enter', messages: [] }));
  ctx.afosEnterpriseIngress.cutoff();
  assert.equal(caller.signal.aborted, false);
  assert.equal(cancellations, 0);
  console.log(JSON.stringify({ probe: 'accepted native-loop signal remains live when Host cutoff occurs outside tool window', callerAborted: caller.signal.aborted, cancellations, result: 'GAP_CONFIRMED', scope: 'Real public AgentRegistry with fixture driver; no real official loop acceptance.' }));
  const handler = ctx.connection.createSharedFetchHandler('/api');
  let exactEffects = 0;
  const release = ctx.connection.fetch.register({ path: '/api/terminal/spawn', methods: ['POST'], requestBody: 'buffered', async fetch() { exactEffects++; return new Response('review exact route'); } });
  const response = await handler.fetch(new Request('http://127.0.0.1/api/terminal/spawn', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 200);
  assert.equal(exactEffects, 1);
  console.log(JSON.stringify({ probe: 'exact Fetch owner has precedence over shared RPC interceptor even after profile cutoff', status: response.status, exactEffects, result: 'COMPOSITION_BOUNDARY_CONFIRMED', scope: 'Requires trusted same-process route registration; demonstrates why real loader/route composition must be restricted.' }));
  await release();
  await detach();
} finally { await ctx.fiber.dispose(); }
