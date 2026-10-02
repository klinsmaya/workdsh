import test from 'node:test';
import assert from 'node:assert/strict';
import { NocoBaseIdentityProvider, enterpriseNamespace } from '../dist/authority.js';

const binding = Object.freeze({ issuer: 'https://identity.example.test/oidc', subject: 'account-a', organizationId: 'org-a', deviceId: 'device-a' });
function state(selected = binding) {
  return {
    binding: selected, expiresAt: Date.now() + 60_000,
    profile: {
      principalId: selected.subject, principalKind: 'human', resolvedBy: 'server',
      organization: { id: selected.organizationId, kind: 'team', name: 'Enterprise', revision: 'org-r1' },
      membership: { organizationId: selected.organizationId, principalId: selected.subject, principalKind: 'human', role: 'member', state: 'active', revision: 'member-r1' },
    },
  };
}
function authority() {
  const controls = { current: state(), allow: true, currentCalls: 0, authorizeCalls: 0 };
  return {
    controls,
    async current() { controls.currentCalls += 1; return controls.current; },
    async authorize() { controls.authorizeCalls += 1; return { ...controls.current, decision: { effect: controls.allow ? 'allow' : 'deny', code: controls.allow ? 'server/current-allow' : 'server/current-deny', authorizationRevision: 'acl-r1', grantIds: [] } }; },
  };
}
function request(actor) {
  return { actor, action: 'use', resource: { domain: 'session', id: 'session-a' }, owner: { organizationId: 'org-a', ownerPrincipalId: 'account-a', scope: 'personal' } };
}

test('namespace separates every issuer/subject/organization/device tuple component', () => {
  const base = enterpriseNamespace(binding);
  assert.match(base, /^[a-f0-9]{64}$/u);
  for (const key of Object.keys(binding)) assert.notEqual(enterpriseNamespace({ ...binding, [key]: binding[key] + '-different' }), base);
  assert.throws(() => enterpriseNamespace({ ...binding, issuer: 'http://identity.example.test' }), /invalid-issuer/u);
});

test('current server establishes actor and each request has a fresh correlation; forged actor is rejected', async () => {
  const source = authority();
  const provider = new NocoBaseIdentityProvider(binding, source);
  const actor = await provider.resolve({ sessionId: 'session-a', principalId: 'forged', organizationId: 'forged' });
  const next = await provider.resolve();
  assert.equal(actor.principalId, 'account-a'); assert.equal(actor.organizationId, 'org-a');
  assert.notEqual(actor.requestId, next.requestId); assert.equal(source.controls.currentCalls, 2);
  assert.equal(Object.isFrozen(actor), true); assert.equal(Object.isFrozen(provider.profile().membership), true);
  assert.throws(() => provider.assertCurrentActor({ ...actor }), /stale-actor/u);
  assert.equal(provider.membership('org-b', 'account-a'), undefined);
});

test('owner status never bypasses current-server denial and no cached role authorizes a later operation', async () => {
  const source = authority(); const provider = new NocoBaseIdentityProvider(binding, source);
  const actor = await provider.resolve({ sessionId: 'session-a' });
  assert.equal((await provider.authorizeEnterprise(request(actor))).effect, 'allow');
  source.controls.allow = false;
  assert.equal((await provider.authorizeEnterprise(request(actor))).effect, 'deny');
  assert.equal(source.controls.authorizeCalls, 2);
  await assert.rejects(provider.authorizeSessionBinding(actor, { sessionId: 'session-a' }), /server\/current-deny/u);
  await assert.rejects(provider.authorizeSessionBinding(actor, { sessionId: 'different' }), /session-context-mismatch/u);
});

test('changed account, organization, issuer, device or inactive membership cuts off the Host permanently', async () => {
  for (const key of Object.keys(binding)) {
    const source = authority(); const provider = new NocoBaseIdentityProvider(binding, source);
    const actor = await provider.resolve();
    source.controls.current = state({ ...binding, [key]: binding[key] + '-other' });
    await assert.rejects(provider.resolve(), /authority-changed-or-revoked/u);
    assert.throws(() => provider.assertCurrentActor(actor), /stale-actor/u);
    source.controls.current = state();
    await assert.rejects(provider.resolve(), /cutoff/u);
  }
  const source = authority(); const provider = new NocoBaseIdentityProvider(binding, source);
  await provider.resolve(); source.controls.current.profile.membership.state = 'suspended';
  await assert.rejects(provider.resolve(), /authority-changed-or-revoked/u);
});

test('cutoff aborts an in-flight current-server read and its late response cannot resurrect identity', async () => {
  let finish; let pendingSignal;
  const provider = new NocoBaseIdentityProvider(binding, {
    current: async (_binding, signal) => { pendingSignal = signal; return new Promise(resolve => { finish = resolve; }); },
    authorize: async () => { throw new Error('unused'); },
  });
  const pending = provider.resolve();
  provider.cutoff(); assert.equal(pendingSignal.aborted, true);
  finish(state()); await assert.rejects(pending);
  assert.throws(() => provider.profile(), /not-current/u);
  await assert.rejects(provider.resolve(), /cutoff/u);
});

test('caller cancellation does not silently create an actor, while unavailable authority fails closed', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  const provider = new NocoBaseIdentityProvider(binding, authority());
  await assert.rejects(provider.resolve(undefined, cancelled.signal), error => error.name === 'AbortError');
  assert.equal((await provider.resolve()).principalId, 'account-a');
  const source = authority(); source.current = async () => { throw new Error('offline'); };
  const unavailable = new NocoBaseIdentityProvider(binding, source);
  await assert.rejects(unavailable.resolve(), /offline/u);
  await assert.rejects(unavailable.resolve(), /cutoff/u);
});

test('expired grants, invalid server responses and freshness expiration fail closed', async () => {
  const source = authority(); source.controls.current.expiresAt = Date.now() - 1;
  await assert.rejects(new NocoBaseIdentityProvider(binding, source).resolve(), /authority-changed-or-revoked/u);
  const malformed = authority(); malformed.controls.current.profile.organization = undefined;
  await assert.rejects(new NocoBaseIdentityProvider(binding, malformed).resolve(), /authority-changed-or-revoked/u);
  const provider = new NocoBaseIdentityProvider(binding, authority(), 250);
  const actor = await provider.resolve();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.throws(() => provider.assertCurrentActor(actor), /stale-actor/u);
  assert.throws(() => provider.profile(), /not-current/u);
  assert.throws(() => new NocoBaseIdentityProvider(binding, authority(), 5001), /invalid-freshness/u);
});


test('late successful current or authorize responses cannot renew a stale server check', async () => {
  const delayedCurrent = authority();
  delayedCurrent.current = async () => { const verified = state(); await new Promise(resolve => setTimeout(resolve, 40)); return verified; };
  const currentProvider = new NocoBaseIdentityProvider(binding, delayedCurrent, 20);
  await assert.rejects(currentProvider.resolve(), /stale-authority/u);
  assert.throws(() => currentProvider.profile(), /not-current/u);

  const delayedAuthorize = authority();
  const authorizeProvider = new NocoBaseIdentityProvider(binding, delayedAuthorize, 20);
  const actor = await authorizeProvider.resolve({ sessionId: 'session-a' });
  delayedAuthorize.authorize = async () => {
    const verified = { ...state(), decision: { effect: 'allow', code: 'server/old-allow', authorizationRevision: 'acl-r1', grantIds: [] } };
    await new Promise(resolve => setTimeout(resolve, 40)); return verified;
  };
  await assert.rejects(authorizeProvider.authorizeEnterprise(request(actor)), /stale-authority/u);
  assert.throws(() => authorizeProvider.assertCurrentActor(actor), /stale-actor/u);
});
