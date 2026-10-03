import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EnterpriseMainSession } from '../src/enterprise-main.ts';
import { RefreshTokenVault } from '../src/desktop-auth.ts';

// Real Main/Auth/Broker/Recovery, mocked HTTPS business responses and OS encryption.
// Only the OAuth callback uses a real loopback HTTP connection; no external network.
export const issuer = 'https://enterprise.example/api';
export const binding = { issuer, subject: 'alice', organizationId: 'org1', deviceId: 'device1' };
export const sourceText = 'Approved cold history source';
export const digest = text => createHash('sha256').update(text).digest('hex');
export const ref = { materialId: 'm1', revisionId: 'v1', sha256: digest(sourceText) };
export function fixture(base) {
  const config = { contractVersion: 'afos.desktop-config.v1', auth: { issuer, clientId: 'desktop', resource: `${issuer}/afos`, scope: 'afos offline_access' }, releaseId: 'fixed-release', policyRevision: 'afos.policy.v1' };
  const projects = ['p1', 'p2'].map(id => ({ id, name: `Allowed ${id}`, organizationId: 'org1' }));
  const vault = new RefreshTokenVault(join(base, 'vault'), { available: () => true, encrypt: text => Buffer.from(text.split('').reverse().join('')), decrypt: bytes => bytes.toString().split('').reverse().join('') });
  let subject = 'alice', connected = true, denied = false, challenge = '', business, identityHook;
  const calls = [], runs = new Map();
  const fetcher = async (url, init) => {
    if (!connected) throw new TypeError('fixture/offline');
    if (String(url).endsWith('openid-configuration')) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, code_challenge_methods_supported: ['S256'] });
    if (String(url) === `${issuer}/token`) {
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.has('client_secret'), false);
      if (params.get('grant_type') === 'authorization_code') assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'afos offline_access' });
    }
    assert.equal(String(url), `${issuer}/afos`);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-access');
    const request = JSON.parse(init.body); calls.push(request.action);
    if (denied) return Response.json({ code: 'afos/read-denied' }, { status: 403 });
    const params = request.params;
    switch (request.action) {
      case 'projects.listAllowed': return Response.json({ contractVersion: 'afos.bridge.v1', principalId: subject, items: projects, nextCursor: null });
      case 'identity.current': {
        const hook = identityHook; identityHook = undefined;
        await hook?.(init.signal);
        return Response.json({ contractVersion: 'afos.identity.v1', binding: { ...binding, subject }, project: projects.find(p => p.id === params.projectId), permissions: { read: true, archive: true }, authorizationRevision: digest('fixture-current-acl'), expiresAt: new Date(Date.now() + 4000).toISOString() });
      }
      case 'materials.listAllowed': return Response.json({ contractVersion: 'afos.bridge.v1', items: [{ id: ref.materialId, revisionId: ref.revisionId, sha256: ref.sha256, name: 'Source' }], nextCursor: null });
      case 'materials.readRevision': return Response.json({ contractVersion: 'afos.bridge.v1', ...ref, text: sourceText });
      case 'runs.authorizeLocal': {
        const time = Date.now(), run = { contractVersion: 'afos.run.v1', runId: `fixture-run-${randomUUID()}`, attempt: 1, binding: { ...binding, subject }, projectId: params.projectId, releaseId: params.releaseId, policyRevision: config.policyRevision, inputRefs: params.inputRefs, allowedActions: ['materials.readRevision', 'artifacts.stageUpload', 'artifacts.commitDraft', 'runs.getReceipt', 'models.stream'], issuedAt: new Date(time).toISOString(), expiresAt: new Date(time + 1800000).toISOString() };
        runs.set(run.runId, run); return Response.json(run);
      }
      case 'runs.getAuthorization': return Response.json(runs.get(params.runId));
      default: throw new Error(`fixture/unexpected-action:${request.action}`);
    }
  };
  const browser = async href => {
    const auth = new URL(href); challenge = auth.searchParams.get('code_challenge');
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code' }).toString();
    assert.equal((await fetch(callback)).status, 200);
  };
  const host = { stop: async () => {}, capabilities: async () => ({ ingressValidated: true, sandbox: 'full' }), start: async (_layout, _authority, _signal, callbacks) => { business = callbacks; } };
  const main = new EnterpriseMainSession(config, base, vault, host, browser, fetcher);
  return { main, calls, config, vault, business: () => business, subject: value => { subject = value; }, disconnect: () => { connected = false; }, reconnect: () => { connected = true; }, revoke: () => { denied = true; }, holdIdentity: hook => { identityHook = hook; } };
}
