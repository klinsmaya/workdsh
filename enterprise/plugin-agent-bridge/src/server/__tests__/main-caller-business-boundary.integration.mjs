import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './desktop-fixture.mjs';
import { MainCallerProofIssuer, NATIVE_WITNESS_HEADER } from '../../../../../dsh-plugin-desktop/src/enterprise-caller-proof.ts';
import { bootEnterpriseNativeWsCore } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/assembly.js';
import { callerRequestFromHttp } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/native-caller-ipc.js';

// Real Main mint/Broker/Core/Connection/physical HTTP. Frame, IdP, ACL repository,
// short grant and wall-clock are controlled components, never native OS/AT PASS.
const policy = { provider: 'afos-managed', model: 'fixed-model', maxTokens: 64 };
const finish = [{ type: 'finish', reason: { kind: 'stop' } }];
const tool = (name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call-' + name, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-' + name, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
];
async function composed(options = {}) {
  const realNow = Date.now; let ctx, issuer, attack = false, minted = 0, closed = 0, jumped = false;
  const account = new AbortController(), window = new AbortController();
  const trigger = () => { if (!attack) return; jumped = true; if (options.cutoff === 'window') window.abort();
    else if (options.cutoff === 'account') account.abort(); else Date.now = () => realNow() + 1000; };
  const f = await fixture({ model: options.model ?? (async () => finish), stopHost: async () => {
    if (ctx) { const old = ctx; ctx = undefined; await old.fiber.dispose(); }
  } });
  await f.ready(); f.capability({ ingressValidated: true, sandbox: 'full' }); // Test switch; production remains false.
  f.startHook(async (signal, layout, authority, business) => {
    const wrapped = { ...business };
    if (options.after === 'localState') wrapped.localState = () => { const result = business.localState(); trigger(); return result; };
    for (const name of ['materials', 'readRevision', 'authorize', 'readPinnedSnapshot', 'prepareDraft']) {
      if (options.after === name) wrapped[name] = async (...args) => {
        const result = await business[name](...args);
        if (attack) { options.entered?.(); await options.pause; }
        trigger(); return result;
      };
    }
    ctx = await bootEnterpriseNativeWsCore({ root: layout.profile, binding: authority.binding, projectId: authority.project.id,
      model: policy, signal, business: wrapped, nativeCaller: { async assertRequest(request, caller) {
        const raw = await issuer.assertRequest(callerRequestFromHttp(request), caller); minted++;
        const expiresAt = Math.min(raw.expiresAt, realNow() + (attack && options.short !== false ? 250 : 60_000));
        return { signal: raw.signal, expiresAt,
          assertFresh: async () => { raw.assertCurrent(); if (Date.now() >= expiresAt) throw Error('private-caller-expired'); },
          close: () => { closed++; raw.close(); },
        };
      } } });
  }); await f.main.startHost();
  const base = 'http://127.0.0.1:' + ctx.webServer.port, auth = new URL(ctx.connection.authenticatedUrl(base + '/'));
  let status, headers;
  assert.equal(ctx.connection.authorizeIndex({ method: 'GET', url: auth.pathname + auth.search, headers: { host: auth.host } },
    { writeHead(s, h) { status = s; headers = h; }, end() {} }), false); assert.equal(status, 303);
  const cookies = headers['Set-Cookie'] ?? headers['set-cookie'], cookie = (Array.isArray(cookies) ? cookies[0] : cookies).split(';')[0];
  const session = {}, frame = { detached: false, url: base + '/', top: undefined }; frame.top = frame;
  const contents = { id: 41, session, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  issuer = new MainCallerProofIssuer({ contents, session, partition: 'afos-business-boundary', authority: auth.host, uiUrl: frame.url,
    accountSignal: account.signal, windowSignal: window.signal, hostSignal: f.business().hostSignal });
  let requestId = 0;
  const http = async (endpoint, payload = {}) => {
    const witness = issuer.stampRequest({ id: ++requestId, url: base + '/api/' + endpoint, method: 'POST', resourceType: 'xhr',
      webContentsId: contents.id, webContents: contents, frame, requestHeaders: {} })[NATIVE_WITNESS_HEADER];
    return fetch(base + '/api/' + endpoint, { method: 'POST', headers: { cookie, 'content-type': 'application/json', [NATIVE_WITNESS_HEADER]: witness },
      body: JSON.stringify({ type: 'client-request', rpcId: 'business-boundary', method: endpoint, payload }) })
      .then(async response => ({ status: response.status, body: await response.json() }), error => ({ error: error.cause?.code ?? error.name }));
  };
  return { ...f, ctx: () => ctx, http, account, window, attack: () => { attack = true; }, reset: () => { attack = false; Date.now = realNow; },
    facts: () => ({ minted, closed, jumped }), cleanup: async () => { Date.now = realNow; issuer.close(); await f.cleanup(); } };
}
const start = f => ({ sources: [f.ref], goal: 'Use the existing owned Agent.', operationId: 'caller-boundary-start' });
test('window close settles HTTP while a noncooperative business read is pending and discards its late data', async () => {
  let entered, release; const called = new Promise(r => entered = r), paused = new Promise(r => release = r);
  const f = await composed({ after: 'materials', cutoff: 'window', short: false, entered, pause: paused });
  // The options retain the original resolve function, not a renderer event.
  try {
    f.attack(); const pending = f.http('afos/drafts/materials'); await called; f.window.abort();
    let timer; const refused = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cutoff did not settle pending HTTP')), 1000); })]).finally(() => clearTimeout(timer));
    assert.notEqual(refused.body?.result?.ok, true); release(); await new Promise(r => setImmediate(r));
    assert.equal(f.tables.runs.size, 0); assert.equal(f.tables.artifacts.size, 0);
  } finally { release(); await f.cleanup(); }
});
for (const [endpoint, after, payload] of [['state', 'localState', f => ({})], ['materials', 'materials', f => ({})], ['snapshot', 'readRevision', f => ({ ref: f.ref })]]) {
  test('Main caller expiry after ' + after + ' refuses finite ' + endpoint + ' output before original serialization', async () => {
    const f = await composed({ after }); try {
      f.attack(); const result = await f.http('afos/drafts/' + endpoint, payload(f));
      assert.equal(f.facts().minted, 1); assert.equal(f.facts().jumped, true); assert.notEqual(result.body?.result?.ok, true);
      assert.equal(f.tables.runs.size, 0); assert.equal(f.tables.artifacts.size, 0);
    } finally { await f.cleanup(); }
  });
}
for (const cutoff of ['expiry', 'window', 'account']) {
  test('Main caller ' + cutoff + ' after read await refuses next Run/Agent action', async () => {
    const f = await composed({ after: 'readRevision', cutoff }); try {
      f.attack(); const result = await f.http('afos/drafts/start', start(f));
      assert.equal(f.facts().minted, 1); assert.equal(f.facts().jumped, true); assert.notEqual(result.body?.result?.ok, true);
      assert.equal(f.tables.runs.size, 0); assert.equal(f.ctx().agents.list().length, 0); assert.equal(f.tables.artifacts.size, 0);
    } finally { await f.cleanup(); }
  });
}
test('already dispatched Run admission on a late reply is recorded and released without claiming remote rollback', async () => {
  const f = await composed({ after: 'authorize' }); try {
    f.attack(); const denied = await f.http('afos/drafts/start', start(f)); assert.notEqual(denied.body?.result?.ok, true);
    assert.equal(f.tables.runs.size, 1, 'The server action already dispatched while caller was valid is retained');
    assert.equal(f.ctx().agents.list().length, 0); assert.equal(f.business().drafts().length, 0);
    f.reset(); const next = await f.http('afos/drafts/start', { ...start(f), operationId: 'fresh-after-released-admission' });
    assert.equal(next.body?.result?.ok, true, JSON.stringify(next)); await f.ctx().agents.get(next.body.result.value.sessionId).whenIdle();
    assert.equal(f.tables.runs.size, 2); assert.equal(f.tables.artifacts.size, 0);
  } finally { await f.cleanup(); }
});
for (const [endpoint, after] of [['afos/readSnapshot', 'readPinnedSnapshot'], ['afos/renderDraft', 'prepareDraft']]) {
  test('legacy finite ' + endpoint + ' refuses caller expiry inside its definition-owned bridge', async () => {
    let entered, release; const called = new Promise(r => entered = r), paused = new Promise(r => release = r);
    const f = await composed({ after, model: async () => { entered(); await paused; return finish; } }); try {
      const initialized = await f.ctx().afosDraftRuntime.invoke('afos/drafts/start', start(f), new AbortController().signal);
      assert.equal(initialized.ok, true); await called; f.attack();
      const request = endpoint === 'afos/readSnapshot' ? { materialId: f.ref.materialId, revisionId: f.ref.revisionId }
        : { text: 'Owned local draft.', sources: [f.ref] };
      const result = await f.http(endpoint, { sessionId: initialized.value.sessionId, request });
      assert.equal(f.facts().minted, 1); assert.equal(f.facts().jumped, true); assert.notEqual(result.body?.result?.ok, true);
      assert.equal(f.tables.artifacts.size, 0);
    } finally { release(); await f.cleanup(); }
  });
}
test('HTTP proof release leaves authorized original Agent and fixed tools governed by original Run/Host', async () => {
  let entered, release, phase = 0, source;
  const called = new Promise(r => entered = r), paused = new Promise(r => release = r);
  const f = await composed({ short: false, model: async () => {
    const n = phase++; if (n === 0) { entered(); await paused; return tool('afos_read_snapshot', { materialId: source.materialId, revisionId: source.revisionId }); }
    return n === 1 ? tool('afos_render_draft', { text: 'Original fixed tools after HTTP ended.', sources: [source] }) : finish;
  } }); source = f.ref;
  try {
    const started = await f.http('afos/drafts/start', start(f)); assert.equal(started.body?.result?.ok, true, JSON.stringify(started));
    await called; assert.ok(f.facts().closed >= 1, 'HTTP ended and released its proof before the model continued'); release();
    const agent = f.ctx().agents.get(started.body.result.value.sessionId); await agent.whenIdle();
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'tool/result').length, 2);
    assert.equal(f.business().drafts()[0].content, 'Original fixed tools after HTTP ended.');
    assert.equal(phase, 3); assert.equal(f.tables.artifacts.size, 0);
  } finally { release(); await f.cleanup(); }
});
