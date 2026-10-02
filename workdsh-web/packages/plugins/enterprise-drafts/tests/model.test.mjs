import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftPanelModel, isArchived } from '../dist/model.js';
import { DraftUiError } from '../dist/rpc.js';
import { archive, deferred, draft, facade, material, ref, sha, state } from './fixtures.mjs';

test('uses actual listed pins; material version change clears obsolete selection and preview', async () => {
  let materials = [material()]; const model = new DraftPanelModel(facade({ materials: async () => materials }));
  await model.refresh(); model.toggleSource(ref(material())); await model.preview(ref(material()));
  assert.equal(model.getSnapshot().selectedSources.length, 1); assert.equal(model.getSnapshot().preview.text, 'Public test input');
  materials = [material('material-A', 'revision-2', 'New version')]; await model.refresh();
  assert.deepEqual(model.getSnapshot().selectedSources, []); assert.equal(model.getSnapshot().preview, undefined);
  model.toggleSource(ref(material())); assert.equal(model.getSnapshot().selectedSources.length, 0); model.close();
});
test('unknown start retries reuse the same operation ID and never auto-start on refresh', async () => {
  let starts = 0, ids = 0; const seen = [];
  const model = new DraftPanelModel(facade({ start: async input => { starts++; seen.push(input); if (starts === 1) throw new DraftUiError('unavailable'); return draft({ sources: input.sources, execution: 'running' }); } }), () => `operation-${++ids}`);
  await model.refresh(); model.toggleSource(ref(material())); await model.start('Prepare draft'); await model.refresh(); model.toggleSource(ref(material())); assert.equal(starts, 1);
  await model.start('Changed goal'); assert.equal(starts, 1);
  const result = await model.start('Prepare draft'); assert.equal(result.sessionId, 'session-A'); assert.equal(starts, 2); assert.equal(ids, 1); assert.deepEqual(seen[0], seen[1]);
  await model.refresh(); assert.equal(starts, 2); model.close();
});
test('one mutation at a time; invalidated late response cannot repopulate account data', async () => {
  const done = deferred(); let wire, starts = 0;
  const model = new DraftPanelModel(facade({ start: async (input, signal) => { starts++; wire = signal; return done.promise; } }));
  await model.refresh(); model.toggleSource(ref(material())); const first = model.start('Prepare draft'); await model.start('Prepare draft'); assert.equal(starts, 1);
  model.invalidate(); assert.equal(wire.aborted, true); done.resolve(draft({ execution: 'running' })); await first;
  assert.equal(model.getSnapshot().state, undefined); assert.equal(model.getSnapshot().selectedSources.length, 0); model.close();
});
test('late old account refresh is discarded and authority failure clears all private cache', async () => {
  const done = deferred(); let first = true;
  const model = new DraftPanelModel(facade({ state: async () => { if (first) { first = false; return done.promise; } return state({ project: { id: 'project-B', name: 'Other fixture' } }); } }));
  const old = model.refresh(); model.invalidate(); await model.refresh(); done.resolve(state({ drafts: [draft()] })); await old;
  assert.equal(model.getSnapshot().state.project.id, 'project-B'); assert.equal(model.getSnapshot().state.drafts.length, 0); model.close();
  let fail = false; const revoked = new DraftPanelModel(facade({ state: async () => { if (fail) throw new DraftUiError('denied'); return state({ drafts: [draft()] }); } }));
  await revoked.refresh(); revoked.toggleSource(ref(material())); await revoked.preview(ref(material())); fail = true; await revoked.refresh();
  assert.equal(revoked.getSnapshot().state, undefined); assert.equal(revoked.getSnapshot().preview, undefined); assert.equal(revoked.getSnapshot().materials.length, 0); revoked.close();
});
test('offline projection allows local edit but forbids fresh reads/start/archive', async () => {
  let reads = 0, starts = 0, writes = 0;
  const model = new DraftPanelModel(facade({ state: async () => state({ authority: 'offline', drafts: [draft()] }), materials: async () => { reads++; return []; }, start: async () => { starts++; return draft(); }, archive: async () => { writes++; return archive(draft()); } }));
  await model.refresh(); await model.start('Draft'); await model.archiveConfirmed('draft-A', draft().sha256); await model.preview(ref(material()));
  assert.equal(reads, 0); assert.equal(starts, 0); assert.equal(writes, 0);
  const edited = await model.edit('draft-A', 'Offline edit'); assert.equal(edited.content, 'Offline edit'); assert.equal(edited.sha256, sha('Offline edit')); assert.equal(isArchived(edited), false); model.close();
});
test('cancel request stays distinct from true official cancellation', async () => {
  let status = 'running'; const model = new DraftPanelModel(facade({ state: async () => state({ drafts: [draft({ execution: status })] }), cancel: async () => draft({ execution: 'cancel_requested' }) }));
  await model.refresh(); await model.cancel('draft-A'); assert.equal(model.getSnapshot().state.drafts[0].execution, 'cancel_requested'); assert.match(model.getSnapshot().notice, /等待/);
  status = 'cancelled'; await model.refresh(); assert.equal(model.getSnapshot().state.drafts[0].execution, 'cancelled'); model.close();
});
test('only explicit confirmation of matching saved hash calls archive; unknown remains unarchived', async () => {
  let commits = 0, row = draft();
  const model = new DraftPanelModel(facade({ state: async () => state({ drafts: [row] }), archive: async () => { commits++; return { ...row, archive: 'needs-reconciliation' }; } }));
  await model.refresh(); await model.refresh(); assert.equal(commits, 0);
  await model.archiveConfirmed('draft-A', sha('other version')); assert.equal(commits, 0);
  await model.archiveConfirmed('draft-A', row.sha256); assert.equal(commits, 1); assert.equal(isArchived(model.getSnapshot().state.drafts[0]), false); assert.match(model.getSnapshot().notice, /待核对/);
  row = archive(row); await model.refresh(); assert.equal(commits, 1); assert.equal(isArchived(model.getSnapshot().state.drafts[0]), true); model.close();
});
test('rejected archive retains local draft, denies false success; mismatched reply hash is rejected', async () => {
  let failure = true; const row = draft();
  const model = new DraftPanelModel(facade({ state: async () => state({ drafts: [row] }), archive: async () => { if (failure) throw new DraftUiError('conflict'); return archive(draft({ content: 'Different', sha256: sha('Different') })); } }));
  await model.refresh(); await model.archiveConfirmed('draft-A', row.sha256); assert.equal(model.getSnapshot().state.drafts[0].archive, 'local-only'); assert.equal(model.getSnapshot().notice, undefined);
  failure = false; await model.archiveConfirmed('draft-A', row.sha256); assert.equal(model.getSnapshot().state.drafts[0].sha256, row.sha256); assert.equal(isArchived(model.getSnapshot().state.drafts[0]), false); model.close();
});
test('wrong Session/run replies and stale timestamps cannot overwrite draft projection', async () => {
  let row = draft({ runId: 'other-run', execution: 'cancel_requested' });
  const model = new DraftPanelModel(facade({ state: async () => state({ drafts: [draft({ execution: 'running' })] }), cancel: async () => row }));
  await model.refresh(); await model.cancel('draft-A'); assert.equal(model.getSnapshot().state.drafts[0].execution, 'running');
  row = draft({ updatedAt: '2026-10-01T12:00:00.000Z', execution: 'cancel_requested' }); await model.cancel('draft-A'); assert.equal(model.getSnapshot().state.drafts[0].execution, 'running'); model.close();
});
test('unstructured transport denial or unknown mutation failure clears authority and private view', async () => {
  const { createDraftClient } = await import('../dist/rpc.js');
  for (const http of [401, 403]) {
    let mutation = false;
    const client = createDraftClient({ async call(channel, endpoint) {
      if (mutation) throw new Error(`transport failure for fixture: HTTP ${http}`);
      return { ok: true, value: endpoint.endsWith('/state') ? state({ drafts: [draft()] }) : [material()] };
    } }, new AbortController().signal);
    const model = new DraftPanelModel(client); await model.refresh(); model.toggleSource(ref(material())); mutation = true;
    await model.edit('draft-A', 'New local edit');
    assert.equal(model.getSnapshot().state, undefined); assert.equal(model.getSnapshot().materials.length, 0); assert.equal(model.getSnapshot().selectedSources.length, 0);
    assert.ok(!model.getSnapshot().error.includes(String(http))); model.close();
  }
});
