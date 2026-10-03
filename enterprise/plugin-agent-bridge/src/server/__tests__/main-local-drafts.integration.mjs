import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './desktop-fixture.mjs';

const signal = () => new AbortController().signal;
const startupStopped = error => ['broker/request-failed', 'enterprise/host-start-stopped'].includes(error.code) || error.name === 'AbortError';
async function draftFixture(t, options = {}) {
  const f = await fixture(options);
  t.after(() => f.cleanup());
  await f.ready();
  await f.main.readRevision(f.ref, signal());
  const run = await f.main.authorize([f.ref], 'local-draft-existing-copy', signal());
  await f.bind(run.runId, 'local-owned-session');
  const draft = await f.main.createDraft(run.runId, 'local-owned-session', 'Main-owned original local copy.', 'local-existing-copy', signal());
  return { ...f, draft, run };
}

test('Main local facade requires current selected account and exposes no enterprise action', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  assert.throws(() => f.main.localDraftCapabilities(), /select-project-required/);
  await f.ready();
  const local = f.main.localDraftCapabilities();
  assert.deepEqual(Object.keys(local).sort(), ['accountSignal', 'drafts', 'editDraft', 'localState']);
  assert.ok(Object.isFrozen(local));
  assert.equal(local.localState().authority, 'offline');
  assert.deepEqual(Object.keys(local.localState().project).sort(), ['id', 'name']);
  assert.equal(local.localState().project.id, 'p1');
  assert.equal(new Date(local.localState().lastSyncAt).toISOString(), local.localState().lastSyncAt);
  assert.deepEqual(local.drafts(), []);
  assert.equal(local.authorize, undefined); assert.equal(local.archiveFromUser, undefined);
  assert.equal(local.materials, undefined); assert.equal(local.modelBytes, undefined);
  assert.equal(local.accountSignal.aborted, false);
});

test('confirmed Host stop preserves account-bound local copy and durable offline edits without network or archive', async t => {
  const f = await draftFixture(t), oldHost = f.business(), local = f.main.localDraftCapabilities();
  oldHost.projectSessionEvent(f.draft.sessionId, { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 0 } });
  assert.throws(() => local.editDraft(f.draft.draftId, 'Premature'), /draft-edit-conflict/);
  const before = f.calls.length, syncedAt = local.localState().lastSyncAt;
  await f.main.stopEnterprise();
  assert.equal(oldHost.hostSignal.aborted, true);
  assert.throws(() => oldHost.drafts(), /host-changed/);
  assert.equal(local.accountSignal.aborted, false);
  assert.equal(local.drafts()[0].localExecution, 'interrupted');
  assert.equal(local.drafts()[0].lastSessionSeq, 0);
  assert.equal(local.localState().lastSyncAt, syncedAt);
  f.disconnect();
  const edited = local.editDraft(f.draft.draftId, 'Offline edit stays only in Main Recovery.');
  assert.equal(edited.sha256, createHash('sha256').update(edited.content).digest('hex'));
  assert.equal(edited.archive, 'local-only'); assert.equal(edited.localExecution, 'interrupted');
  assert.equal(f.calls.length, before); assert.equal(f.tables.artifacts.size, 0);
  assert.equal(local.drafts()[0].content, edited.content);
  await assert.rejects(f.main.materials(signal()), /offline-restart-required/);
  await assert.rejects(f.main.archiveFromUser(f.draft.draftId, signal()), /offline-restart-required/);
  f.reconnect(); await f.ready();
  assert.equal(local.accountSignal.aborted, true);
  assert.throws(() => local.drafts(), /account-changed/);
  assert.equal(f.main.localDraftCapabilities().drafts()[0].content, edited.content);
});

test('stop pending does not invent interruption or allow editing an active draft', async t => {
  const gate = Promise.withResolvers(); let hold = false, entered;
  const f = await draftFixture(t, { stopHost: async () => { if (hold) { entered?.(); await gate.promise; } } });
  const local = f.main.localDraftCapabilities();
  const started = Promise.withResolvers(); entered = started.resolve; hold = true;
  const stopping = f.main.stopEnterprise(); await started.promise;
  assert.equal(local.drafts()[0].localExecution, 'local_queued');
  assert.throws(() => local.editDraft(f.draft.draftId, 'Before actual stop confirmation'), /draft-edit-conflict/);
  gate.resolve(); await stopping;
  assert.equal(local.drafts()[0].localExecution, 'interrupted');
  assert.equal(local.editDraft(f.draft.draftId, 'After stop confirmation').content, 'After stop confirmation');
  hold = false;
});

test('failed Host stop retains uncertain active state and denies edits until a subsequent confirmed stop', async t => {
  let fail = false;
  const f = await draftFixture(t, { stopHost: async () => { if (fail) throw new Error('fixture-stop-not-confirmed'); } });
  const local = f.main.localDraftCapabilities(); fail = true;
  await assert.rejects(f.main.stopEnterprise(), /fixture-stop-not-confirmed/);
  assert.equal(local.drafts()[0].localExecution, 'local_queued');
  assert.throws(() => local.editDraft(f.draft.draftId, 'Unknown running state'), /draft-edit-conflict/);
  assert.equal(local.accountSignal.aborted, false);
  fail = false; await f.main.stopEnterprise();
  assert.equal(local.drafts()[0].localExecution, 'interrupted');
});

test('switch and logout immediately revoke captured local capabilities and retain account isolation', async t => {
  const f = await draftFixture(t), alice = f.main.localDraftCapabilities();
  await f.main.stopEnterprise(); alice.editDraft(f.draft.draftId, 'Private Alice copy.');
  f.principal('bob'); const switching = f.ready();
  assert.equal(alice.accountSignal.aborted, true);
  assert.throws(() => alice.drafts(), /account-changed/);
  assert.throws(() => alice.editDraft(f.draft.draftId, 'Old account edit'), /account-changed/);
  await switching;
  const bob = f.main.localDraftCapabilities(); assert.deepEqual(bob.drafts(), []);
  assert.throws(() => bob.editDraft(f.draft.draftId, 'Cross-account adoption'), /draft-not-owned/);
  const logout = f.main.logout(); assert.equal(bob.accountSignal.aborted, true);
  assert.throws(() => bob.localState(), /account-changed/); await logout;
  assert.throws(() => f.main.localDraftCapabilities(), /select-project-required/);
});

test('failed project selection and suspend revoke old local authority without deleting saved copies', async t => {
  const f = await draftFixture(t), local = f.main.localDraftCapabilities();
  await f.main.stopEnterprise(); const edited = local.editDraft(f.draft.draftId, 'Saved before suspend.');
  const failed = f.main.selectProject('unowned-project');
  assert.equal(local.accountSignal.aborted, true); assert.throws(() => local.drafts(), /account-changed/);
  await assert.rejects(failed);
  assert.throws(() => f.main.localDraftCapabilities(), /select-project-required/);
  await f.ready(); const restored = f.main.localDraftCapabilities();
  assert.equal(restored.drafts()[0].content, edited.content);
  const sleeping = f.main.suspend(); assert.equal(restored.accountSignal.aborted, true);
  assert.throws(() => restored.editDraft(f.draft.draftId, 'Suspended'), /account-changed/); await sleeping;
  assert.throws(() => f.main.localDraftCapabilities(), /select-project-required/);
});

test('local edit refuses unowned ids and oversized UTF8 without changing saved content', async t => {
  const f = await draftFixture(t); await f.main.stopEnterprise(); const local = f.main.localDraftCapabilities();
  assert.throws(() => local.editDraft('not-owned', 'body'), /draft-not-owned/);
  assert.throws(() => local.editDraft('../path', 'body'), /draft-not-owned/);
  assert.throws(() => local.editDraft('x'.repeat(129), 'body'), /draft-not-owned/);
  assert.throws(() => local.editDraft(f.draft.draftId, '界'.repeat(22_000)));
  assert.equal(local.drafts()[0].content, f.draft.content);
});

test('archived local copies remain immutable across confirmed Host stop', async t => {
  const f = await draftFixture(t), local = f.main.localDraftCapabilities();
  const original = f.business();
  original.projectSessionEvent(f.draft.sessionId, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 0, reason: { kind: 'completed' } } });
  const receipt = await f.main.archiveFromUser(f.draft.draftId, signal());
  assert.equal(receipt.sha256, f.draft.sha256); assert.equal(f.tables.artifacts.size, 1);
  await f.main.stopEnterprise();
  assert.equal(local.drafts()[0].archive, 'receipt-recorded');
  assert.equal(local.drafts()[0].localExecution, 'completed_local');
  assert.throws(() => local.editDraft(f.draft.draftId, 'Overwrite archived'), /draft-edit-conflict/);
  assert.equal(local.drafts()[0].receipt.receiptId, receipt.receiptId);
});

test('explicit reauthentication restores only the selected account local copy before any Host start', async t => {
  const f = await draftFixture(t); await f.main.stopEnterprise();
  const prior = f.main.localDraftCapabilities(); prior.editDraft(f.draft.draftId, 'Saved before explicit reauthentication.');
  await f.main.suspend(); const starts = f.starts();
  await f.main.restoreAccount(f.run.binding, f.run.projectId, signal());
  const restored = f.main.localDraftCapabilities();
  assert.equal(restored.localState().authority, 'offline');
  assert.equal(restored.drafts()[0].content, 'Saved before explicit reauthentication.');
  assert.equal(f.starts(), starts); assert.equal(prior.accountSignal.aborted, true);
  assert.throws(() => prior.localState(), /account-changed/);
});

test('confirmed stop retires execution admission before an independent same-account Host start', async t => {
  const f = await draftFixture(t), local = f.main.localDraftCapabilities(), prior = f.business();
  await f.main.stopEnterprise();
  assert.equal(local.drafts()[0].localExecution, 'interrupted');
  await f.main.startHost(); // Explicit fixture capability, not production activation.
  assert.equal(local.accountSignal.aborted, false);
  assert.throws(() => prior.drafts(), /host-changed/);
  await assert.rejects(f.main.createDraft(f.run.runId, f.draft.sessionId, 'Reuse old execution', 'old-execution-again', signal()), /enterprise\/session-run-unowned/);
  const run = await f.main.authorize([f.ref], 'independent-after-confirmed-stop', signal());
  assert.notEqual(run.runId, f.run.runId);
  f.business().releaseRunAdmission(run.runId);
  assert.equal(local.drafts().length, 1);
  assert.equal(f.tables.artifacts.size, 0);
});

test('stop cuts off a pending authority check before the old start can publish a Host', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let hold = false;
  const f = await fixture({ response: async request => {
    if (hold && request.action === 'identity.current') { hold = false; entered.resolve(); await release.promise; }
  } });
  t.after(async () => { release.resolve(); await f.cleanup(); });
  await f.ready(); f.capability({ ingressValidated: true, sandbox: 'full' });
  hold = true; const before = f.starts(), starting = f.main.startHost();
  const rejected = assert.rejects(starting, startupStopped);
  await entered.promise;
  const stopping = f.main.stopEnterprise();
  await assert.rejects(f.main.currentAuthority(), /offline-restart-required/);
  release.resolve(); await rejected; await stopping;
  assert.equal(f.starts(), before);
  assert.equal(f.business(), undefined);
  await assert.rejects(f.main.currentAuthority(), /offline-restart-required/);
  assert.equal(f.main.localDraftCapabilities().localState().authority, 'offline');
});

test('late Host readiness after stop rejects startup and cannot restore execution', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(); t.after(async () => { release.resolve(); await f.cleanup(); });
  await f.ready(); f.capability({ ingressValidated: true, sandbox: 'full' });
  let startupSignal;
  f.startHook(async captured => { startupSignal = captured; entered.resolve(); await release.promise; });
  const starting = f.main.startHost(), rejected = assert.rejects(starting, startupStopped);
  await entered.promise; const prior = f.business(), stopping = f.main.stopEnterprise();
  assert.equal(startupSignal.aborted, true); assert.equal(prior.hostSignal.aborted, true);
  await assert.rejects(f.main.currentAuthority(), /offline-restart-required/);
  release.resolve(); await rejected; await stopping;
  assert.throws(() => prior.drafts(), /host-changed/);
  await assert.rejects(f.main.currentAuthority(), /offline-restart-required/);
  await assert.rejects(prior.authorize([f.ref], 'post-stop-rejected', signal()), /host-changed/);
});

test('a new explicit start requested after stop waits for cleanup and uses a fresh startup lifetime', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let hold = false;
  const f = await fixture({ response: async request => {
    if (hold && request.action === 'identity.current') { hold = false; entered.resolve(); await release.promise; }
  } });
  t.after(async () => { release.resolve(); await f.cleanup(); });
  await f.ready(); f.capability({ ingressValidated: true, sandbox: 'full' });
  hold = true; const before = f.starts(), oldStart = f.main.startHost();
  const rejected = assert.rejects(oldStart, startupStopped);
  await entered.promise;
  const stopping = f.main.stopEnterprise(), explicitRestart = f.main.startHost();
  release.resolve(); await rejected; await stopping; await explicitRestart;
  assert.equal(f.starts(), before + 1);
  assert.equal(f.business().hostSignal.aborted, false);
  assert.equal((await f.business().currentAuthority(signal())).project.id, 'p1');
});
