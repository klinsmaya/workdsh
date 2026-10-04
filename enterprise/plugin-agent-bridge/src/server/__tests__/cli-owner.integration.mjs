import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fixture } from './desktop-fixture.mjs';
import { runtimeEnvironment } from '../../../../../dsh-plugin-desktop/src/runtime-security.ts';
import { MainCallerProofIssuer, NATIVE_WITNESS_HEADER } from '../../../../../dsh-plugin-desktop/src/enterprise-caller-proof.ts';
import { attachMainBusinessIpc } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/main-ipc.js';
import { managedCliProfilePatch } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/cli-profile.js';
import { fixedEnterpriseComposition } from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/profile-policy.js';

const providerRoot = fileURLToPath(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/', import.meta.url));
const require = createRequire(join(providerRoot, 'package.json'));
const cli = require.resolve('@deepseek-ai/dsh/lib/bin.js');
const WebSocket = createRequire(require.resolve('@deepseek-ai/dsh-api-gateway'))('ws');
const policy = { provider: 'afos-managed', model: 'fixed-model', maxTokens: 64 };
const bounded = async (promise, label, ms = 5000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
};

async function composed(t) {
  let child, channel, issuer, ready, profileRoot, generation = 0, models = 0, snapshotReads = 0, requestId = 0;
  const children = [], pending = new Map(), sockets = new Set(), mainReadDenials = [];
  const stop = async () => {
    issuer?.close(); issuer = undefined;
    for (const ws of sockets) ws.terminate(); sockets.clear();
    await channel?.close(); channel = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGTERM');
      try { await bounded(closed, 'CLI shutdown'); } catch (error) { child.kill('SIGKILL'); await closed; throw error; }
    }
  };
  const f = await fixture({ stopHost: stop, model: async () => { models++; return [{ type: 'finish', reason: { kind: 'stop' } }]; } });
  t.after(() => f.cleanup()); await f.ready();
  f.capability({ ingressValidated: true, sandbox: 'full' }); // Test-only capability; no activation certification.
  f.startHook(async (signal, layout, authority, business) => {
    const home = join(layout.cache, 'owner-cli-' + ++generation), profile = join(home, 'profiles', 'afos-managed');
    profileRoot = layout.profile;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'afos-test-profile', private: true, type: 'module', dsh: { profile: { bundles: [] } } }) + '\n', { mode: 0o600, flag: 'wx' });
    const patch = managedCliProfilePatch({ root: profileRoot, binding: authority.binding, model: policy, signal, nativeCaller: true });
    patch[0].insert[0].config.push({ id: 'afos-cli-owner-fixture', name: pathToFileURL(join(providerRoot, 'tests/fixtures/cli-owner-consumer.mjs')).href, config: { root: profileRoot } });
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patch) + '\n', { mode: 0o600, flag: 'wx' });
    await symlink(join(providerRoot, 'node_modules'), join(profile, 'node_modules'), 'dir');
    const current = spawn(process.execPath, [cli, '--profile', 'afos-managed'], { cwd: home,
      env: { ...runtimeEnvironment(process.env), DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
    child = current;
    const first = Promise.withResolvers(), app = Promise.withResolvers(); first.promise.catch(() => {}); app.promise.catch(() => {});
    let observedBytes = 0;
    const cap = b => { observedBytes += b.length; if (observedBytes > 262144) current.kill('SIGKILL'); };
    current.stdout.on('data', cap); current.stderr.on('data', cap); // Do not persist private ready/cookie frames.
    createInterface({ input: current.stdout }).on('line', line => {
      if (line.startsWith('AFOS_OWNER_READY ')) first.resolve(JSON.parse(line.slice(17)));
      if (line.startsWith('AFOS_OWNER_RESULT ')) {
        const result = JSON.parse(line.slice(18)), wait = pending.get(result.id);
        if (wait) { pending.delete(result.id); result.ok ? wait.resolve(result.value) : wait.reject(Error(result.code + ' at fixture line ' + result.failureLine)); }
      }
    });
    current.once('close', (code, signal) => {
      const error = Error('Original CLI closed: code=' + code + ', signal=' + signal);
      first.reject(error); app.reject(error);
      for (const wait of pending.values()) wait.reject(error); pending.clear();
    });
    const endpoint = { send: message => new Promise((resolve, reject) => current.send(message, error => error ? reject(error) : resolve())),
      messages: listener => { current.on('message', listener); return () => current.off('message', listener); },
      disconnected: listener => { current.on('disconnect', listener); return () => current.off('disconnect', listener); } };
    // Observe the real Main rejection before its existing finite IPC error mapping.
    const observedBusiness = { ...business, readPinnedSnapshot: async (...args) => {
      snapshotReads++; return business.readPinnedSnapshot(...args);
    }, ownedSessionRead: async (id, s) => {
      try { return await business.ownedSessionRead(id, s); }
      catch (error) { mainReadDenials.push({ id, code: error.code }); throw error; }
    } };
    channel = await attachMainBusinessIpc(endpoint, observedBusiness, signal, { root: profileRoot, model: policy },
      { assertRequest: (request, s) => { if (!issuer) throw Error('caller issuer not bound'); return issuer.assertRequest(request, s); } }, undefined, () => app.resolve());
    ready = await bounded(first.promise, 'Original CLI owner ready'); await bounded(app.promise, 'Original CLI app ready');
    assert.equal(ready.ppid, process.pid); assert.notEqual(ready.pid, process.pid);
    assert.equal(ready.pid, current.pid); assert.equal(ready.root, profileRoot);
    assert.equal(ready.originalLoader, true); assert.equal(ready.rootPrivate, true);
    children.push({ pid: ready.pid, ppid: ready.ppid, profileRoot });
  });
  const start = async () => {
    await f.main.startHost();
    const account = new AbortController(), window = new AbortController();
    const frame = { detached: false, url: 'http://' + ready.authority + '/', top: null }; frame.top = frame;
    const session = {}, contents = { id: 19, session, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
    issuer = new MainCallerProofIssuer({ contents, session, partition: 'afos-enterprise-ui', authority: ready.authority,
      uiUrl: frame.url, accountSignal: account.signal, hostSignal: f.business().hostSignal, windowSignal: window.signal });
    return { frame, contents };
  };
  let carrier = await start();
  const stamp = (path, method = 'POST') => issuer.stampRequest({ id: ++requestId, url: (method === 'GET' ? 'ws://' : 'http://') + ready.authority + path,
    method, resourceType: method === 'GET' ? 'webSocket' : 'xhr', webContentsId: 19, webContents: carrier.contents, frame: carrier.frame, requestHeaders: {} })[NATIVE_WITNESS_HEADER];
  const http = (method, payload = {}, witness) => fetch('http://' + ready.authority + '/api/' + method, { method: 'POST',
    headers: { cookie: ready.cookie, 'content-type': 'application/json', ...(witness ? { [NATIVE_WITNESS_HEADER]: witness } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'owner-cli-test', method, payload }), signal: AbortSignal.timeout(5000) });
  const unary = async (method, payload = {}) => {
    const response = await http(method, payload, stamp('/api/' + method)); assert.equal(response.status, 200, method);
    return (await response.json()).result;
  };
  const control = async (method, payload = {}) => {
    const id = ++requestId, wait = Promise.withResolvers(); pending.set(id, wait);
    child.stdin.write(JSON.stringify({ id, method, payload }) + '\n');
    try { return await bounded(wait.promise, 'CLI observer ' + method); } finally { pending.delete(id); }
  };
  const follow = async id => {
    const ws = new WebSocket('ws://' + ready.authority + '/api/remote.mux', { headers: { cookie: ready.cookie,
      [NATIVE_WITNESS_HEADER]: stamp('/api/remote.mux', 'GET') } }); sockets.add(ws);
    try {
      await bounded(once(ws, 'open'), 'Original Gateway socket');
      const first = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'open', streamId: 'owner-' + ++requestId, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: id }, assistantStream: true, maxMessages: 500 } } } }));
      const [raw] = await bounded(first, 'Original follow opening'); return JSON.parse(raw);
    } finally { ws.terminate(); sockets.delete(ws); }
  };
  return { ...f, children, mainReadDenials, models: () => models, snapshotReads: () => snapshotReads, control, unary, http, follow,
    restart: async () => { carrier = await start(); } };
}

test('AT16 original CLI restart preserves owners and cold Native reads never adopt history', { timeout: 40000 }, async t => {
  const f = await composed(t);
  const started = await f.unary('afos/drafts/start', { sources: [f.ref], goal: 'Original CLI durable owner control.', operationId: 'owner-cli-positive' });
  assert.equal(started.ok, true);
  const { ids, before, stats } = await f.control('seed', { sessionId: started.value.sessionId });
  assert.equal(stats.publications.length, 1); assert.equal(stats.publications[0].owner.ownerPrincipalId, 'alice');
  assert.equal(before[0].owner.organizationId, 'org1'); assert.equal(before[1].owner.ownerPrincipalId, 'bob'); assert.equal(before[2].owner, null);
  assert.equal(f.models(), 1); assert.equal(fixedEnterpriseComposition().autoBindPersonalSessions, false);
  const models = f.models(), runs = f.tables.runs.size;
  const deny = async () => {
    const registryBefore = await f.control('stats'); let refused = 0;
    for (const id of ids) {
      for (const extra of [{ sessionId: id }, { resumeSessionId: id }, { owner: { principalId: 'alice', sessionId: id } }]) {
        const result = await f.unary('afos/drafts/start', { sources: [f.ref], goal: 'Cannot adopt history.', operationId: 'forged-' + ++refused, ...extra });
        assert.equal(result.ok, false); assert.equal(result.error.code, 'afos/drafts-operation-denied');
      }
      // Raw routes never obtain a Main witness; keep the actual finite allowlist.
      for (const method of ['session/create', 'session/restore', 'sessionController/create']) {
        const calls = f.calls.length, response = await f.http(method, { sessionId: id });
        assert.equal(response.status, 403); await response.arrayBuffer(); assert.equal(f.calls.length, calls); refused++;
      }
    }
    assert.equal(f.models(), models); assert.equal(f.tables.runs.size, runs);
    assert.deepEqual(await f.control('stats'), registryBefore);
    assert.deepEqual(await f.control('persisted', { ids }), before); return refused;
  };
  const warmRefused = await deny();
  await f.restart();
  assert.equal(f.children.length, 2); assert.notEqual(f.children[0].pid, f.children[1].pid);
  assert.equal(f.children[0].profileRoot, f.children[1].profileRoot);
  const cold = await f.control('stats');
  assert.equal(cold.agents, 0); assert.equal(cold.sessions, 0); assert.equal(cold.publications.length, 0);
  assert.equal(cold.personalAutoBindService, false); assert.equal(cold.selected, null);
  assert.deepEqual(await f.control('persisted', { ids }), before);
  const coldRefused = await deny();
  const listed = await f.unary('session/list', { args: { _request: {} } }); assert.equal(listed.ok, true);
  assert.deepEqual(listed.value.items.map(row => row.sessionId), [ids[0]]); assert.equal(listed.value.items[0].agentAvailable, false);
  const projection = await f.unary('session/projections', { args: { request: { sessionId: ids[0] } } }); assert.equal(projection.ok, true);
  const page = await f.unary('session/page', { args: { request: { address: { kind: 'session', sessionId: ids[0] }, throughSeq: projection.value.asOfSeq, maxMessages: 500 } } });
  assert.equal(page.ok, true); assert.ok(page.value.records.length > 0);
  const opening = await f.follow(ids[0]); assert.equal(opening.type, 'item'); assert.equal(opening.value.type, 'snapshot');
  assert.equal(opening.value.header.id, ids[0]); assert.deepEqual(opening.value.assistantStream, { revision: 0 });
  for (const id of ids.slice(1)) {
    const denials = f.mainReadDenials.length;
    const result = await f.unary('session/projections', { args: { request: { sessionId: id } } });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'afos/profile-operation-failed');
    assert.deepEqual(f.mainReadDenials.slice(denials), [{ id, code: 'enterprise/draft-session-not-owned' }]);
    // Original Gateway's remote error boundary maps this private IPC error to internal.
    const refused = await f.follow(id); assert.equal(refused.type, 'error'); assert.equal(refused.error.code, 'gateway/internal');
    assert.deepEqual(f.mainReadDenials.slice(denials), [{ id, code: 'enterprise/draft-session-not-owned' }, { id, code: 'enterprise/draft-session-not-owned' }]);
  }
  // Flush original socket cancellation before examining actual Core registries.
  await new Promise(resolve => setImmediate(resolve));
  const final = await f.control('stats'); assert.equal(final.agents, 0); assert.equal(final.sessions, 0);
  assert.equal(final.publications.length, 0); assert.equal(final.personalAutoBindService, false);
  assert.deepEqual(await f.control('persisted', { ids }), before);
  assert.equal(f.models(), models); assert.equal(f.tables.runs.size, runs); assert.equal(f.tables.artifacts.size, 0);
  console.log('AT16_ORIGINAL_CLI ' + JSON.stringify({ children: f.children.map(({ pid, ppid }) => ({ pid, ppid })),
    warmRefused, coldRefused, sameProfile: true, ownersAndJsonlBytesUnchanged: true, coldAgents: 0, coldSessions: 0,
    coldPublications: 0, coldModelCalls: 0, originalNativeColdSnapshot: true, fixtureIdentityModelAndFrame: true, formalAT16: 'NOT_RUN' }));
});

test('AT16 original CLI real unowned Agent is denied by ingress and original tools pipeline', { timeout: 20000 }, async t => {
  const f = await composed(t), before = await f.control('stats');
  assert.equal(before.agents, 0); assert.equal(before.sessions, 0); assert.equal(before.personalAutoBindService, false);
  assert.equal(fixedEnterpriseComposition().autoBindPersonalSessions, false);
  const result = await f.control('unownedTool', { ref: f.ref });
  assert.equal(result.realRegisteredAgent, true); assert.equal(result.originalFrozenTool, true);
  assert.equal(result.ingressCode, 'afos/profile-session-unowned');
  assert.equal(result.direct.isError, true); assert.equal(result.observed.preExecute, 1);
  assert.equal(result.observed.execute, 0); assert.equal(result.observed.results, 1); assert.equal(result.ownerBeforeAndAfter, null);
  const after = await f.control('stats');
  assert.equal(after.agents, 0); assert.equal(after.sessions, 0); assert.equal(after.personalAutoBindService, false);
  assert.equal(after.publications.length, 1); assert.equal(after.publications[0].id, result.id); assert.equal(after.publications[0].owner, null);
  assert.equal(f.models(), 0); assert.equal(f.snapshotReads(), 0);
  for (const table of ['runs', 'uploads', 'receipts', 'artifacts', 'commitRequests']) assert.equal(f.tables[table].size, 0);
  console.log('AT16_UNOWNED_TOOL ' + JSON.stringify({ pid: f.children[0].pid, ppid: f.children[0].ppid,
    originalAgentAndTool: true, ingressCode: result.ingressCode, originalPreExecuteDenied: true,
    originalExecuteStage: 0, models: 0, mainSnapshotReads: 0, businessWrites: 0, ownerUnbound: true,
    agentDisposed: true, fixtureIdentityAndFrame: true, formalAT16: 'NOT_RUN' }));
});
