import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installLocalDraftIpc, LOCAL_DRAFT_CHANNELS, LOCAL_DRAFT_DOCUMENT } from '../src/enterprise-local-ipc.ts';
import { loadEnterpriseRuntimePolicy, createEnterpriseElectronHost, enterpriseRuntimePaths } from '../src/enterprise-electron.ts';
import { localAssetHandler } from '../src/enterprise-assets.ts';

const policy = { contractVersion: 'afos.host-runtime.v1', releaseId: 'release1', policyRevision: 'policy1', model: { provider: 'managed', model: 'fixed-model', maxTokens: 64 } };
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'afos-carrier-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function fixture({ projection = async value => value } = {}) {
  const handlers = new Map(), frame = { url: LOCAL_DRAFT_DOCUMENT }, messages = [];
  const owner = { mainFrame: frame, isDestroyed: () => false, send: name => messages.push(name) };
  let lifetime = new AbortController(), calls = 0, edits = 0;
  const row = { draftId: 'draft1', content: 'saved local draft' };
  const capabilities = () => { calls++; return { accountSignal: lifetime.signal, localState: () => ({ project: { id: 'project1', name: 'Project' }, authority: 'offline', lastSyncAt: '2026-10-03T00:00:00.000Z' }), drafts: () => [row], editDraft: (id, content) => { assert.equal(id, 'draft1'); edits++; return { ...row, content }; } }; };
  const handle = installLocalDraftIpc({ ipc: { handle(name, fn) { assert.ok(!handlers.has(name)); handlers.set(name, fn); }, removeHandler: name => handlers.delete(name) }, owner: () => owner, capabilities, projectDraft: projection });
  const event = { sender: owner, senderFrame: frame };
  return { owner, event, handlers, handle, messages, call: (name, ...args) => handlers.get(name)(event, ...args), cutoff() { lifetime.abort(); }, switchWithoutAbort() { lifetime = new AbortController(); }, calls: () => calls, edits: () => edits };
}
test('release-owned policy is strict, same release/policy, bounded and unavailable without a file', async t => {
  const dir = await directory(t), path = join(dir, 'policy.json');
  assert.throws(() => loadEnterpriseRuntimePolicy(path, policy), /carrier-refused/);
  await writeFile(path, JSON.stringify(policy)); assert.deepEqual(loadEnterpriseRuntimePolicy(path, policy), policy);
  for (const value of [{ ...policy, token: 'fixture' }, { ...policy, releaseId: 'other' }, { ...policy, model: { ...policy.model, endpoint: 'https://other.invalid' } }, { ...policy, model: { ...policy.model, model: '../path' } }, { ...policy, model: { ...policy.model, maxTokens: 0 } }]) { await writeFile(path, JSON.stringify(value)); assert.throws(() => loadEnterpriseRuntimePolicy(path, policy), /carrier-refused/); }
  await writeFile(path, JSON.stringify(policy)); await symlink(path, join(dir, 'linked.json')); assert.throws(() => loadEnterpriseRuntimePolicy(join(dir, 'linked.json'), policy), /carrier-refused/);
});
test('carrier delegates to the existing owner while production capability remains refused', async t => {
  const dir = await directory(t); let starts = 0, stops = 0, constructions = 0;
  const owner = createEnterpriseElectronHost({ appPath: dir, runtimeProfile: '/release/profile', executable: '/release/node', config: policy, writeLog() {}, createHost: value => { assert.deepEqual(value, policy); constructions++; return { capabilities: async () => ({ ingressValidated: true, sandbox: 'full' }), start: async () => { starts++; }, stop: async () => { stops++; } }; } });
  assert.deepEqual(await owner.capabilities(), { ingressValidated: false, sandbox: 'unavailable' }); await owner.stop(); assert.equal(constructions, 0);
  await assert.rejects(owner.start(), /carrier-refused/); assert.equal(starts, 0);
  await writeFile(join(dir, 'afos-host-runtime.json'), JSON.stringify(policy)); await owner.start(); await owner.stop(); assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(constructions, 1);
  assert.deepEqual(await owner.capabilities(), { ingressValidated: false, sandbox: 'unavailable' });
});
test('enterprise release paths are fixed separately from personal runtime environment overrides', () => {
  assert.deepEqual(enterpriseRuntimePaths('/app', '/resources', true, 'win32'), { runtimeProfile: '/resources/workdsh-runtime/profiles/workdsh', executable: '/resources/workdsh-runtime/primary-runtime/dependencies/node/bin/node.exe' });
  assert.ok(enterpriseRuntimePaths('/app', '/resources', false).runtimeProfile.startsWith('/app/build/'));
});
test('local IPC accepts only the exact owning window, top frame and managed document', async () => {
  const f = fixture();
  for (const event of [{ sender: {}, senderFrame: f.owner.mainFrame }, { sender: f.owner, senderFrame: { url: LOCAL_DRAFT_DOCUMENT } }, { sender: f.owner, senderFrame: null }]) await assert.rejects(f.handlers.get(LOCAL_DRAFT_CHANNELS.state)(event), /local-draft-refused/);
  f.owner.mainFrame.url = 'https://untrusted.invalid/'; await assert.rejects(f.call(LOCAL_DRAFT_CHANNELS.state), /local-draft-refused/); assert.equal(f.calls(), 0); f.handle.close();
});
test('only state/edit are registered; extra arguments, payload keys, accessors and excessive bytes refuse', async () => {
  const f = fixture(); assert.deepEqual([...f.handlers.keys()].sort(), [LOCAL_DRAFT_CHANNELS.state, LOCAL_DRAFT_CHANNELS.edit].sort());
  const state = await f.call(LOCAL_DRAFT_CHANNELS.state); assert.equal(state.authority, 'offline'); assert.equal(state.drafts[0].content, 'saved local draft');
  await assert.rejects(f.call(LOCAL_DRAFT_CHANNELS.state, {}), /refused/);
  for (const payload of [{ draftId: 'draft1', content: 'x', path: '/secret' }, { draftId: 'draft1', content: '界'.repeat(21846) }, { get draftId() { throw Error('accessor'); }, content: '' }]) await assert.rejects(f.call(LOCAL_DRAFT_CHANNELS.edit, payload), /refused/);
  assert.equal(f.edits(), 0); const value = await f.call(LOCAL_DRAFT_CHANNELS.edit, { draftId: 'draft1', content: '界'.repeat(21845) }); assert.equal(Buffer.byteLength(value.content), 65535); assert.equal(f.edits(), 1); f.handle.close();
});
test('account cutoff rejects a pending projection immediately and late results never disclose the old state', async () => {
  const pending = Promise.withResolvers(), f = fixture({ projection: () => pending.promise });
  const state = f.call(LOCAL_DRAFT_CHANNELS.state); f.cutoff(); await assert.rejects(state, /local-draft-refused/); pending.resolve({ content: 'old account' }); f.handle.close();
});
test('switching the captured account signal and window disposal reject post-await results', async () => {
  const pending = Promise.withResolvers(), f = fixture({ projection: () => pending.promise });
  const state = f.call(LOCAL_DRAFT_CHANNELS.state); f.switchWithoutAbort(); pending.resolve({ content: 'old account' }); await assert.rejects(state, /refused/);
  const later = Promise.withResolvers(), g = fixture({ projection: () => later.promise }), edit = g.call(LOCAL_DRAFT_CHANNELS.edit, { draftId: 'draft1', content: 'saved' }); g.handle.close(); await assert.rejects(edit, /refused/); later.resolve({ content: 'saved' }); f.handle.close();
});
test('notifications contain no account/body payload and disposed handlers disappear', () => {
  const f = fixture(); f.handle.changed(); assert.deepEqual(f.messages, [LOCAL_DRAFT_CHANNELS.changed]); f.handle.close(); f.handle.changed(); assert.equal(f.handlers.size, 0); assert.equal(f.messages.length, 1);
});
test('Main account signal abort proactively invalidates the view without relying on a later RPC', async () => {
  const f = fixture(); await f.call(LOCAL_DRAFT_CHANNELS.state); f.cutoff(); assert.deepEqual(f.messages, [LOCAL_DRAFT_CHANNELS.changed]); f.handle.close();
});
test('partial IPC installation failure releases only its own first registration', () => {
  const registered = new Map([['other-channel', 'other-owner']]);
  assert.throws(() => installLocalDraftIpc({ ipc: { handle(name, fn) { if (name === LOCAL_DRAFT_CHANNELS.edit) throw Error('existing second owner'); registered.set(name, fn); }, removeHandler: name => registered.delete(name) }, owner: () => undefined, capabilities: () => { throw Error('unused'); }, projectDraft: async value => value }), /existing second owner/);
  assert.deepEqual([...registered.keys()], ['other-channel']);
});
test('local asset handler serves hashed release assets and refuses every remote/file/mutation route', async t => {
  const dir = await directory(t), body = Buffer.from('<h1>Local</h1>'); await writeFile(join(dir, 'index.html'), body);
  await writeFile(join(dir, 'assets.json'), JSON.stringify({ contractVersion: 'afos.local-assets.v1', files: [{ file: 'index.html', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), type: 'text/html' }] }));
  const serve = localAssetHandler(dir), response = serve(new Request(LOCAL_DRAFT_DOCUMENT)); assert.equal(response.status, 200); assert.equal(await response.text(), body.toString()); assert.ok(response.headers.get('content-security-policy').includes("connect-src 'none'"));
  for (const path of ['/api/file', '/api/remote.mux', '/api/afos/drafts/start', '/%69ndex.html', '/index.html?token=fixture', '/index.html#fragment']) assert.equal(serve(new Request('afos-local://drafts' + path)).status, 404);
  assert.equal(serve(new Request(LOCAL_DRAFT_DOCUMENT, { method: 'POST' })).status, 404); assert.equal(serve(new Request('afos-local://other/index.html')).status, 404);
  await writeFile(join(dir, 'index.html'), '<h1>Changed</h1>'); assert.equal(serve(new Request(LOCAL_DRAFT_DOCUMENT)).status, 404);
});
test('asset manifest rejects path traversal and symlink release files', async t => {
  const dir = await directory(t); await mkdir(join(dir, 'assets')); await writeFile(join(dir, 'plain'), 'x');
  await writeFile(join(dir, 'assets.json'), JSON.stringify({ contractVersion: 'afos.local-assets.v1', files: [{ file: '../plain', bytes: 1, sha256: 'a'.repeat(64), type: 'text/html' }] })); assert.throws(() => localAssetHandler(dir), /refused/);
  await symlink(join(dir, 'plain'), join(dir, 'index.html')); await writeFile(join(dir, 'assets.json'), JSON.stringify({ contractVersion: 'afos.local-assets.v1', files: [{ file: 'index.html', bytes: 1, sha256: createHash('sha256').update('x').digest('hex'), type: 'text/html' }] })); assert.equal(localAssetHandler(dir)(new Request(LOCAL_DRAFT_DOCUMENT)).status, 404);
});


test('a top-document lifetime change immediately refuses pending state while a new document can read its own local scope', async () => {
  const handlers = new Map(), pending=Promise.withResolvers();let lifetime=new AbortController(), held=true;
  const account=new AbortController(), frame={url:LOCAL_DRAFT_DOCUMENT},owner={mainFrame:frame,isDestroyed:()=>false,send() {}};
  const cap={accountSignal:account.signal,localState:()=>({project:{id:'p1',name:'Local'},authority:'offline',lastSyncAt:new Date().toISOString()}),drafts:()=>['record'],editDraft() {throw Error('unused')}};
  const ipc=installLocalDraftIpc({ipc:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},owner:()=>owner,capabilities:()=>cap,documentSignal:()=>lifetime.signal,projectDraft:async()=>held?pending.promise:{content:'fresh'}});
  const old=handlers.get(LOCAL_DRAFT_CHANNELS.state)({sender:owner,senderFrame:frame});
  lifetime.abort();lifetime=new AbortController();await assert.rejects(old,/local-draft-refused/);
  held=false;pending.resolve({content:'old'});const fresh=await handlers.get(LOCAL_DRAFT_CHANNELS.state)({sender:owner,senderFrame:frame});assert.deepEqual(fresh.drafts,[{content:'fresh'}]);ipc.close();
});
