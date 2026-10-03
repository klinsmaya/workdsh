import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs';
import { installLocalDraftIpc, LOCAL_DRAFT_CHANNELS, LOCAL_DRAFT_DOCUMENT } from '../src/enterprise-local-ipc.ts';
import { runtimeDraftProjection } from '../src/enterprise-electron.ts';

const runtimeProfile = fileURLToPath(new URL('../../workdsh-web/packages/providers/enterprise-profile/', import.meta.url));
async function seeded(t, { stop = true, projection } = {}) {
  const f = await fixture(); t.after(() => f.cleanup()); await f.ready();
  await f.main.readRevision(f.ref); const run = await f.main.authorize([f.ref], 'local-ui-fixture-run'); await f.bind(run.runId, 'local-owned-session');
  const record = await f.main.createDraft(run.runId, 'local-owned-session', 'Local Main-owned draft <img src=x onerror=alert(1)>', 'local-ui-fixture-draft');
  if (stop) await f.main.stopEnterprise();
  const frame = { url: LOCAL_DRAFT_DOCUMENT }, owner = { mainFrame: frame, isDestroyed: () => false, send() {} }, handlers = new Map();
  const ipc = installLocalDraftIpc({ ipc: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }, owner: () => owner, capabilities: () => f.main.localDraftCapabilities(), projectDraft: projection ?? runtimeDraftProjection(runtimeProfile) });
  t.after(() => ipc.close()); const event = { sender: owner, senderFrame: frame };
  return { ...f, record, ipc, handlers, event, call: (channel, ...args) => handlers.get(channel)(event, ...args) };
}
test('real Main/Recovery local state survives confirmed Host stop and uses the unique public draftView', async t => {
  const f = await seeded(t), before = f.calls.length, state = await f.call(LOCAL_DRAFT_CHANNELS.state);
  assert.equal(state.authority, 'offline'); assert.equal(state.project.id, 'p1'); assert.equal(state.drafts[0].draftId, f.record.draftId); assert.equal(state.drafts[0].execution, 'interrupted');
  const wire = JSON.stringify(state); for (const forbidden of ['fixture-access', 'fixture-refresh', 'organizationId', 'deviceId', 'binding', 'inputSnapshots', f.base]) assert.ok(!wire.includes(forbidden));
  assert.equal(f.calls.length, before); assert.equal(f.tables.artifacts.size, 0);
});
test('real Main offline edit persists the canonical local record without enterprise transport', async t => {
  const f = await seeded(t), before = f.calls.length, content = 'Offline local edit <script>never execute</script>';
  const view = await f.call(LOCAL_DRAFT_CHANNELS.edit, { draftId: f.record.draftId, content });
  assert.equal(view.content, content); assert.equal(view.sha256, createHash('sha256').update(content).digest('hex')); assert.equal(view.archive, 'local-only');
  assert.equal(f.main.localDraftCapabilities().drafts()[0].content, content); assert.equal(f.calls.length, before); assert.equal(f.tables.artifacts.size, 0);
});
test('active drafts and unowned draft IDs remain denied through the finite Renderer surface', async t => {
  const f = await seeded(t, { stop: false });
  await assert.rejects(f.call(LOCAL_DRAFT_CHANNELS.edit, { draftId: f.record.draftId, content: 'do not overwrite active' }), /local-draft-refused/);
  await f.main.stopEnterprise(); await assert.rejects(f.call(LOCAL_DRAFT_CHANNELS.edit, { draftId: 'foreign-draft', content: 'foreign' }), /local-draft-refused/);
});
test('real account logout during an asynchronous projection immediately aborts old state and content', async t => {
  const pending = Promise.withResolvers(), f = await seeded(t, { projection: () => pending.promise });
  const old = f.call(LOCAL_DRAFT_CHANNELS.state), logout = f.main.logout(); await assert.rejects(old, /local-draft-refused/);
  pending.resolve({ content: 'late old body' }); await logout;
  await assert.rejects(f.call(LOCAL_DRAFT_CHANNELS.state), /local-draft-refused/); assert.equal(f.tables.artifacts.size, 0);
});
