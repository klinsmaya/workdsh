import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeSessionNavigation } from '../dist/navigation.js';
import { DraftPanelModel } from '../dist/model.js';
import { deferred, draft, facade, state } from './fixtures.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function setup({ ready = true, list, opening, snapshot, catalogReady = true, timeout = 1000 } = {}) {
  let generation = ready ? { id: 1, host: { home: '' } } : undefined;
  const listeners = new Set(), calls = [], refs = [], opened = [];
  const catalogListeners = new Set();
  let catalog = { phase: catalogReady ? 'ready' : 'pending', ids: catalogReady ? ['session-A'] : [], byId: catalogReady ? { 'session-A': { id: 'session-A' } } : {} };
  let business = state({ drafts: [draft(), draft({ draftId: 'draft-B', sessionId: 'session-B' })] });
  const model = new DraftPanelModel(facade({ state: async () => business })); await model.refresh();
  const binding = { sessionId: 'session-A', session: { getSnapshot: () => snapshot ?? ({ sessionId: 'session-A', openState: 'open', openError: null, removed: false }) } };
  const connection = { generation: { getSnapshot: () => generation, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } } };
  const remote = { session: { list: async (payload, signal) => { calls.push({ payload, signal }); return list ? list.promise : { ok: true, value: { items: [{ sessionId: 'session-A' }] } }; } } };
  const sessions = { refresh: async () => {}, list: { getSnapshot: () => catalog, subscribe(fn) { catalogListeners.add(fn); return () => catalogListeners.delete(fn); } }, binding: () => binding, retain(target, options) { assert.ok(catalog.ids.includes(target), 'original Controller cannot retain before its catalog'); const ref = { target, options, binding, ready: opening?.promise ?? Promise.resolve(binding), releases: 0, release() { this.releases++; } }; refs.push(ref); return ref; } };
  const nav = new NativeSessionNavigation(connection, sessions, remote, model, id => opened.push(id), timeout);
  return { model, nav, calls, refs, opened, listeners, catalogListeners, binding, setCatalog(value) { catalog = value; for (const fn of [...catalogListeners]) fn(); }, setGeneration(value) { generation = value; for (const fn of [...listeners]) fn(); }, business(value) { business = value; }, generation: () => generation, close() { nav.close(); model.close(); } };
}
test('AFOS-UI-READY-01 first original ready/reset repulls Main and hands off one successful original reference', async () => {
  const f = await setup({ ready: false });
  try {
    const op = f.nav.open('session-A'); await turn(); assert.equal(f.calls.length, 0); assert.deepEqual(f.opened, []);
    f.setGeneration({ id: 1, host: { home: '' } }); f.nav.connectionReset(); f.model.invalidate(); void f.model.refresh();
    await op; assert.deepEqual(f.opened, ['session-A']); assert.equal(f.refs[0].releases, 1); assert.equal(f.refs[0].options.source, 'enterpriseDraftNavigation'); assert.deepEqual(f.calls[0].payload, {});
  } finally { f.close(); assert.equal(f.listeners.size, 0); }
});
test('AFOS-UI-READY-02 explicit cancel while waiting original readiness releases every listener without a read', async () => {
  const f = await setup({ ready: false }), abort = new AbortController();
  try { const op = f.nav.open('session-A', abort.signal); abort.abort(); await assert.rejects(op); assert.equal(f.calls.length, 0); assert.equal(f.refs.length, 0); assert.deepEqual(f.opened, []); }
  finally { f.close(); assert.equal(f.listeners.size, 0); }
});
test('AFOS-UI-READY-03 replacement while fresh owned-list is awaited cannot publish a late navigation', async () => {
  const list = deferred(), f = await setup({ list });
  try { const op = f.nav.open('session-A'); await turn(); f.setGeneration({ id: 2, host: { home: '' } }); await assert.rejects(op); list.resolve({ ok: true, value: { items: [{ sessionId: 'session-A' }] } }); await turn(); assert.equal(f.refs.length, 0); assert.deepEqual(f.opened, []); assert.equal(f.calls[0].signal.aborted, true); }
  finally { f.close(); }
});
test('AFOS-UI-READY-04 reset during original shared open releases only the navigation reference', async () => {
  const opening = deferred(), f = await setup({ opening });
  try { const op = f.nav.open('session-A'); await turn(); assert.equal(f.refs.length, 1); f.nav.connectionReset(); await assert.rejects(op); assert.equal(f.refs[0].releases, 1); opening.resolve(f.binding); await turn(); assert.deepEqual(f.opened, []); }
  finally { f.close(); }
});
test('AFOS-UI-READY-05 changed draft selection cancels an in-flight navigation', async () => {
  const opening = deferred(), f = await setup({ opening });
  try { const op = f.nav.open('session-A'); await turn(); f.model.selectDraft('draft-B'); await assert.rejects(op); assert.equal(f.refs[0].releases, 1); assert.deepEqual(f.opened, []); opening.resolve(f.binding); }
  finally { f.close(); }
});
test('AFOS-UI-READY-06 fresh denied or foreign result refuses despite an old current UI projection', async () => {
  for (const result of [{ ok: false, error: { code: 'unauthorized' } }, { ok: true, value: { items: [{ sessionId: 'foreign' }] } }]) {
    const list = deferred(), f = await setup({ list });
    try { const op = f.nav.open('session-A'); list.resolve(result); await assert.rejects(op); assert.equal(f.refs.length, 0); assert.deepEqual(f.opened, []); }
    finally { f.close(); }
  }
});
test('AFOS-UI-READY-07 settled original ready with error/cold/removed/foreign snapshot cannot open UI', async () => {
  for (const patch of [{ openState: 'error', openError: { code: 'unavailable' } }, { openState: 'cold' }, { removed: true }, { sessionId: 'foreign' }]) {
    const f = await setup({ snapshot: { sessionId: 'session-A', openState: 'open', openError: null, removed: false, ...patch } });
    try { await assert.rejects(f.nav.open('session-A')); assert.equal(f.refs[0].releases, 1); assert.deepEqual(f.opened, []); }
    finally { f.close(); }
  }
});
test('AFOS-UI-READY-08 second request supersedes the first without retracting its successful replacement', async () => {
  const opening = deferred(), f = await setup({ opening });
  try { const first = f.nav.open('session-A'); const caught = assert.rejects(first); await turn(); const second = f.nav.open('session-A'); await turn(); await caught; opening.resolve(f.binding); await second; assert.deepEqual(f.opened, ['session-A']); assert.deepEqual(f.refs.map(x => x.releases), [1, 1]); }
  finally { f.close(); }
});
test('AFOS-UI-READY-09 disposal aborts a pending shared open and prevents late view retention', async () => {
  const opening = deferred(), f = await setup({ opening });
  const op = f.nav.open('session-A'); await turn(); f.close(); await assert.rejects(op); opening.resolve(f.binding); await turn(); assert.equal(f.refs[0].releases, 1); assert.equal(f.listeners.size, 0); assert.deepEqual(f.opened, []);
});
test('AFOS-UI-READY-10 offline projection or a bounded wait expiry cannot borrow native history', async () => {
  const f = await setup({ ready: false, timeout: 10 });
  try { await assert.rejects(f.nav.open('session-A')); assert.equal(f.calls.length, 0); f.business(state({ authority: 'offline', drafts: [draft()] })); await f.model.refresh(); await assert.rejects(f.nav.open('session-A')); assert.equal(f.refs.length, 0); }
  finally { f.close(); }
});
test('AFOS-UI-READY-11 a reset immediately after an already-ready click cancels before any new read', async () => {
  const list = deferred(), f = await setup({ list });
  try { const op = f.nav.open('session-A'); f.nav.connectionReset(); await assert.rejects(op); assert.equal(f.calls.length, 0); assert.deepEqual(f.opened, []); }
  finally { f.close(); }
});
test('AFOS-UI-READY-12 successful fresh direct read still awaits the original Controller baseline before retain', async () => {
  const f = await setup({ catalogReady: false });
  try { const op = f.nav.open('session-A'); await turn(); assert.equal(f.calls.length, 1); assert.equal(f.refs.length, 0); assert.equal(f.catalogListeners.size, 1); f.setCatalog({ phase: 'ready', ids: ['session-A'], byId: { 'session-A': { id: 'session-A' } } }); await op; assert.equal(f.catalogListeners.size, 0); assert.equal(f.refs[0].releases, 1); assert.deepEqual(f.opened, ['session-A']); }
  finally { f.close(); }
});
test('AFOS-UI-READY-13 a selected nonfirst draft changed by the original EMPTY/reset repull refuses', async () => {
  const f = await setup({ ready: false }); f.model.selectDraft('draft-B');
  try { const op = f.nav.open('session-B'); f.setGeneration({ id: 1, host: { home: '' } }); f.nav.connectionReset(); f.model.invalidate(); void f.model.refresh(); await assert.rejects(op); assert.equal(f.calls.length, 0); assert.deepEqual(f.opened, []); }
  finally { f.close(); }
});
test('AFOS-UI-READY-14 cancellation during original catalog wait withdraws its subscription and cannot retain late', async () => {
  const f = await setup({ catalogReady: false }), abort = new AbortController();
  try { const op = f.nav.open('session-A', abort.signal); await turn(); assert.equal(f.catalogListeners.size, 1); abort.abort(); await assert.rejects(op); assert.equal(f.catalogListeners.size, 0); f.setCatalog({ phase: 'ready', ids: ['session-A'], byId: { 'session-A': { id: 'session-A' } } }); await turn(); assert.equal(f.refs.length, 0); }
  finally { f.close(); }
});
test('AFOS-UI-READY-15 a fresh owned row cannot bypass a missing original catalog before deadline', async () => {
  const f = await setup({ catalogReady: false, timeout: 10 });
  try { await assert.rejects(f.nav.open('session-A')); assert.equal(f.calls.length, 1); assert.equal(f.catalogListeners.size, 0); assert.equal(f.refs.length, 0); assert.deepEqual(f.opened, []); }
  finally { f.close(); }
});
