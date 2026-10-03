import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDraftClient } from '../dist/local-rpc.js';
import { DraftPanelModel } from '../dist/model.js';
import { MAX_TEXT_BYTES, errorLabel } from '../dist/rpc.js';
import { deferred, draft, sha, state } from './fixtures.mjs';

function bridge(overrides = {}) {
  const listeners = new Set(), calls = [];
  let releases = 0;
  const capability = {
    async state() { calls.push(['state']); return state({ drafts: [draft()] }); },
    async edit(input) { calls.push(['edit', input]); return draft({ ...input, sha256: sha(input.content) }); },
    subscribe(listener) { listeners.add(listener); return () => { releases++; listeners.delete(listener); }; },
    ...overrides,
  };
  return { capability, calls, listeners, changed() { for (const listener of listeners) listener(); }, get releases() { return releases; } };
}

test('fixed local capability returns validated offline/local-only state and exact edit DTO, never enterprise calls', async () => {
  const local = bridge(), lifetime = new AbortController();
  const client = createLocalDraftClient(local.capability, lifetime.signal);
  const projection = await client.state();
  assert.equal(projection.authority, 'offline'); assert.equal(projection.scopedLocalOnly, true);
  assert.ok(Object.isFrozen(projection) && Object.isFrozen(projection.project) && Object.isFrozen(projection.drafts));
  const content = '<script>fixture()</script> local edit';
  const edited = await client.edit('draft-A', content);
  assert.equal(edited.content, content); assert.equal(edited.sha256, sha(content));
  assert.deepEqual(local.calls, [['state'], ['edit', { draftId: 'draft-A', content }]]);
  for (const method of ['materials', 'snapshot', 'start', 'cancel', 'archive']) await assert.rejects(client[method](), { code: 'offline' });
  assert.equal(local.calls.length, 2);
  lifetime.abort(); client.close(); assert.equal(local.releases, 1); assert.equal(local.listeners.size, 0);
  await assert.rejects(client.state(), { code: 'closed' });
});

test('local DTOs use existing strict field/hash validators and bounded edit input before Main calls', async () => {
  let response = state({ drafts: [draft()] }), edits = 0, getters = 0;
  const local = bridge({ state: async () => response, edit: async input => { edits++; return draft({ ...input, sha256: sha(input.content) }); } });
  const client = createLocalDraftClient(local.capability, new AbortController().signal);
  for (const extra of ['token', 'url', 'path', 'actor', 'credentials', 'scopedLocalOnly']) {
    response = { ...state(), [extra]: 'forbidden fixture field' }; await assert.rejects(client.state(), { code: 'invalid-data' });
  }
  response = { ok: true, value: state() }; await assert.rejects(client.state(), { code: 'invalid-data' });
  response = state({ drafts: [draft({ content: 'mismatched hash' })] }); await assert.rejects(client.state(), { code: 'invalid-data' });
  response = state(); Object.defineProperty(response, 'drafts', { get() { getters++; return []; } });
  await assert.rejects(client.state(), { code: 'invalid-data' }); assert.equal(getters, 0);
  await assert.rejects(client.edit('bad\nidentifier', 'safe'), { code: 'invalid-data' });
  await assert.rejects(client.edit('draft-A', '中'.repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1)), { code: 'invalid-data' });
  assert.equal(edits, 0); await client.edit('draft-A', 'D'.repeat(MAX_TEXT_BYTES)); assert.equal(edits, 1); client.close();
});

test('local edit rejects mismatched target/content and sanitizes Main transport diagnostics', async () => {
  const diagnostic = 'fixture-private-url-secret';
  for (const response of [draft({ draftId: 'draft-other' }), draft({ content: 'different content', sha256: sha('different content') })]) {
    const local = bridge({ edit: async () => response });
    const client = createLocalDraftClient(local.capability, new AbortController().signal);
    await assert.rejects(client.edit('draft-A', draft().content), { code: 'conflict' }); client.close();
  }
  const client = createLocalDraftClient(bridge({ state: async () => { throw new Error(diagnostic); } }).capability, new AbortController().signal);
  const error = await client.state().catch(error => error);
  assert.equal(error.code, 'unavailable'); assert.ok(!String(error).includes(diagnostic)); assert.ok(!errorLabel(error).includes(diagnostic)); client.close();
});

test('missing or unobservable preload capability refuses state/edit without an online fallback', async () => {
  for (const cap of [undefined, {}, { ...bridge().capability, subscribe: () => undefined }, { ...bridge().capability, subscribe: () => { throw new Error('fixture'); } }]) {
    const client = createLocalDraftClient(cap, new AbortController().signal);
    await assert.rejects(client.state(), { code: 'unavailable' }); await assert.rejects(client.edit('draft-A', 'safe'), { code: 'unavailable' }); client.close();
  }
});

test('local capability event invalidates before fresh repull, old account response cannot repopulate a same-id scope', async () => {
  const old = deferred(); let first = true, reads = 0;
  const local = bridge({ state: async () => { reads++; if (first) { first = false; return old.promise; } return state({ drafts: [draft({ content: 'Other account local text', sha256: sha('Other account local text') })] }); } });
  const client = createLocalDraftClient(local.capability, new AbortController().signal), model = new DraftPanelModel(client);
  const unsubscribe = client.subscribe(() => { model.invalidate(); void model.refresh(); });
  const previous = model.refresh(); local.changed(); assert.equal(model.getSnapshot().state, undefined);
  await model.refresh(); old.resolve(state({ drafts: [draft()] })); await previous;
  assert.equal(model.getSnapshot().state.drafts[0].content, 'Other account local text'); assert.equal(model.getScopeRevision(), 1); assert.equal(reads, 2);
  await model.refresh(); assert.equal(model.getScopeRevision(), 1); assert.equal(model.getSnapshot().materials.length, 0);
  unsubscribe(); model.close(); client.close();
});

test('capability cutoff during asynchronous SHA cannot return old state or edit data', async () => {
  const original = crypto.subtle.digest;
  try {
    for (const method of ['state', 'edit']) {
      const entered = deferred(), release = deferred();
      crypto.subtle.digest = async function(...args) { entered.resolve(); await release.promise; return original.apply(this, args); };
      const local = bridge(), client = createLocalDraftClient(local.capability, new AbortController().signal);
      const result = method === 'state' ? client.state() : client.edit('draft-A', 'Late old account edit');
      await entered.promise; local.changed(); release.resolve();
      await assert.rejects(result, { code: 'closed' }); client.close();
    }
  } finally { crypto.subtle.digest = original; }
});

test('caller and module cancellation reject ignored local Main responses, subscription is released exactly once', async () => {
  for (const mode of ['caller', 'module']) {
    const pending = deferred(), lifetime = new AbortController(), caller = new AbortController();
    const local = bridge({ state: () => pending.promise }), client = createLocalDraftClient(local.capability, lifetime.signal);
    const result = client.state(caller.signal); (mode === 'module' ? lifetime : caller).abort(); pending.resolve(state({ drafts: [draft()] }));
    await assert.rejects(result, { code: 'closed' }); client.close(); lifetime.abort(); assert.equal(local.releases, 1);
  }
});

test('local scope event discards an inflight edit commit and authorization failure clears private model cache', async () => {
  const pending = deferred(); let denied = false;
  const local = bridge({ state: async () => { if (denied) throw new Error('raw denied diagnostic'); return state({ drafts: [draft()] }); }, edit: () => pending.promise });
  const client = createLocalDraftClient(local.capability, new AbortController().signal), model = new DraftPanelModel(client);
  const unsubscribe = client.subscribe(() => { model.invalidate(); void model.refresh(); });
  await model.refresh(); const editing = model.edit('draft-A', 'Old scope mutation'); denied = true; local.changed();
  assert.equal(model.getSnapshot().state, undefined); await model.refresh();
  pending.resolve(draft({ content: 'Old scope mutation', sha256: sha('Old scope mutation') })); assert.equal(await editing, undefined);
  assert.equal(model.getSnapshot().state, undefined); assert.ok(!model.getSnapshot().error.includes('diagnostic'));
  unsubscribe(); model.close(); client.close();
});


test('shared state parser matches the managed Main project-name 1024-character bound', async () => {
  for (const length of [512, 513, 1024]) {
    const response = state({ project: { id: 'project-A', name: '名'.repeat(length) } });
    const client = createLocalDraftClient(bridge({ state: async () => response }).capability, new AbortController().signal);
    assert.equal((await client.state()).project.name.length, length); client.close();
  }
  const client = createLocalDraftClient(bridge({ state: async () => state({ project: { id: 'project-A', name: '名'.repeat(1025) } }) }).capability, new AbortController().signal);
  await assert.rejects(client.state(), { code: 'invalid-data' }); client.close();
});
