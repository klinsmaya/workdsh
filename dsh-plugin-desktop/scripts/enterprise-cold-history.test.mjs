import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, binding, ref, digest } from './enterprise-cold-history.fixture.mjs';

const signal = () => new AbortController().signal;
const path = base => join(base, 'seed-state-path.txt');
async function seed(base) {
  const f = fixture(base);
  await f.main.signIn(); await f.main.selectProject('p1'); await f.main.startHost();
  await f.main.readRevision(ref); const run = await f.main.authorize([ref], 'cold-seed-run');
  const lease = await f.business().prepareSessionBinding(run.runId, 'cold-owned-session', signal()); lease.commit();
  const draft = await f.main.createDraft(run.runId, 'cold-owned-session', 'Persisted history body', 'cold-seed-draft');
  f.business().projectSessionEvent(draft.sessionId, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
  const namespace = (await f.main.currentAuthority()).binding;
  const { accountNamespace } = await import('../src/desktop-auth.ts');
  const state = join(base, 'afos-accounts', accountNamespace(namespace.issuer, namespace.subject, namespace.organizationId, namespace.deviceId), 'outbox', 'drafts.v1.json');
  await f.main.suspend();
  // Age a valid v1 Run in the fixture rather than wait thirty minutes. No trusted handle is imported.
  const stored = JSON.parse(await readFile(state, 'utf8')), time = Date.now() - 3600000;
  stored.drafts[0].run.issuedAt = new Date(time).toISOString(); stored.drafts[0].run.expiresAt = new Date(time + 1800000).toISOString();
  await writeFile(state, JSON.stringify(stored), { mode: 0o600 }); await writeFile(path(base), state);
  console.log(JSON.stringify({ seededByPid: process.pid, stateSha256: digest(await readFile(state)), businessCalls: f.calls }));
}
async function reopened(t, alter) {
  const base = await mkdtemp(join(tmpdir(), 'afos-cold-history-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['--experimental-transform-types', fileURLToPath(import.meta.url), '--seed', base], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); const proof = JSON.parse(child.stdout.trim()); assert.notEqual(proof.seededByPid, process.pid);
  const state = await readFile(path(base), 'utf8');
  if (alter) { const raw = JSON.parse(await readFile(state, 'utf8')); alter(raw); await writeFile(state, JSON.stringify(raw), { mode: 0o600 }); }
  const before = await readFile(state), f = fixture(base); t.after(() => f.main.logout());
  await f.main.restoreAccount(binding, 'p1'); await f.main.startHost();
  return { ...f, base, state, before, seedProof: proof };
}
const read = (f, id = 'cold-owned-session', abort = signal()) => f.business().ownedSessionRead(id, abort);
function clone(raw, id, sessionId, projectId = 'p1', extra = {}) {
  const first = raw.drafts[0]; return { ...first, draftId: `draft-${id}`, clientRequestId: `key-${id}`, sessionId, run: { ...first.run, runId: `run-${id}`, projectId }, ...extra };
}

if (process.argv[2] === '--seed') {
  await seed(process.argv[3]);
} else {
  test('a real second process reopens persisted history with fresh authority and no recovered execution', async t => {
    const f = await reopened(t), business = f.business(), count = () => f.calls.filter(action => action === 'identity.current').length;
    const before = count(), a = await read(f), b = await read(f);
    assert.equal(count(), before + 2); assert.equal(a.sessionId, 'cold-owned-session'); assert.equal(a.epoch, b.epoch); assert.equal(a.signal.aborted, false);
    assert.ok(Date.parse(a.expiresAt) > Date.now()); assert.equal(f.main.localDraftCapabilities().drafts()[0].localExecution, 'completed_local');
    for (const operation of [business.sessionRun('cold-owned-session', signal()), business.readPinnedSnapshot('cold-owned-session', ref, signal()), business.prepareDraft('cold-owned-session', 'must not rewrite', [ref], signal()), (async () => { for await (const _ of business.modelBytes('cold-owned-session', { run: { runId: 'fixture-run-1', attempt: 1 } }, signal())) {} })()]) await assert.rejects(operation, /session-run-unowned/);
    await assert.rejects(business.prepareSessionBinding('fixture-run-1', 'cold-owned-session', signal()), /session-run-conflict/);
    assert.throws(() => business.markCancellation('cold-owned-session', false), /draft-not-owned/);
    assert.throws(() => business.markCancellation('cold-owned-session', true), /draft-not-owned/);
    business.projectSessionEvent('cold-owned-session', { type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 2 } });
    assert.equal(f.calls.includes('runs.getAuthorization'), false); assert.equal(f.calls.includes('runs.authorizeLocal'), false);
    assert.deepEqual(await readFile(f.state), f.before);
    console.log(JSON.stringify({ case: 'second-process', pid: process.pid, seedPid: f.seedProof.seededByPid, stateSha256Before: digest(f.before), stateSha256After: digest(await readFile(f.state)), freshReads: 2 }));
  });
  test('select, reopen, account and project switches replace ownership and abort old read epochs', async t => {
    const f = await reopened(t), old = f.business(), a = await read(f);
    await f.main.selectProject('p1'); assert.equal(a.signal.aborted, true); await assert.rejects(old.ownedSessionRead('cold-owned-session', signal()));
    await f.main.startHost(); const b = await read(f); assert.notEqual(a.epoch, b.epoch);
    await f.main.selectProject('p2'); await f.main.startHost(); await assert.rejects(read(f), /draft-session-not-owned/);
    await f.main.selectProject('p1'); await f.main.startHost(); await read(f);
    f.subject('bob'); await f.main.signIn(); await f.main.selectProject('p1'); await f.main.startHost();
    assert.equal(f.main.localDraftCapabilities().drafts().length, 0); await assert.rejects(read(f), /draft-session-not-owned/);
    await assert.rejects(f.main.restoreAccount(binding, 'p1'), /authority-mismatch/);
    f.subject('alice'); await f.main.restoreAccount(binding, 'p1'); await f.main.startHost(); await read(f);
    await f.main.suspend(); await assert.rejects(read(f));
    await f.main.restoreAccount(binding, 'p1'); await f.main.startHost(); await read(f);
    assert.deepEqual(await readFile(f.state), f.before);
  });
  test('cancelled, archived and pending history remain readable; duplicate and foreign references remain local only', async t => {
    const f = await reopened(t, raw => {
      const archived = clone(raw, 'archived', 'cold-archived', 'p1', { archive: 'receipt-recorded' });
      archived.receipt = { contractVersion: 'afos.receipt.v1', receiptId: 'receipt', runId: archived.run.runId, attempt: 1, artifactId: 'artifact', revisionId: 'revision', sha256: archived.sha256, committedAt: archived.updatedAt };
      raw.drafts.push(clone(raw, 'cancelled', 'cold-cancelled', 'p1', { localExecution: 'cancelled' }), archived, clone(raw, 'pending', 'cold-pending', 'p1', { archive: 'needs-reconciliation' }), clone(raw, 'duplicate1', 'cold-duplicate'), clone(raw, 'duplicate2', 'cold-duplicate', 'p2'), clone(raw, 'foreign', 'cold-foreign', 'p2'), clone(raw, 'unsafe', '../outside'));
    });
    const canary = join(f.base, 'outside'); await writeFile(canary, 'outside-canary');
    for (const id of ['cold-owned-session', 'cold-cancelled', 'cold-archived', 'cold-pending']) await read(f, id);
    for (const id of ['cold-duplicate', 'cold-foreign', '../outside', 'unknown-retained-session']) await assert.rejects(read(f, id), /draft-session-not-owned/);
    assert.equal(f.main.localDraftCapabilities().drafts().length, 6);
    await f.main.selectProject('p2'); await f.main.startHost(); await read(f, 'cold-foreign'); await assert.rejects(read(f, 'cold-duplicate'), /draft-session-not-owned/);
    assert.deepEqual(await readFile(f.state), f.before); assert.equal(await readFile(canary, 'utf8'), 'outside-canary');
  });
  test('unsafe v1 session identifiers do not become query permissions and invalid v1 records still fail closed', async t => {
    const f = await reopened(t), original = JSON.parse(f.before);
    for (const sessionId of ['../outside', '/absolute', 'a/b', 'a\\b', '.', '..', '.hidden', 'a%2fb', 'space id', 'a\u202eb', 'https://example.test/id']) {
      await f.main.suspend(); const raw = structuredClone(original); raw.drafts[0].sessionId = sessionId; const bytes = Buffer.from(JSON.stringify(raw)); await writeFile(f.state, bytes, { mode: 0o600 });
      await f.main.restoreAccount(binding, 'p1'); await f.main.startHost(); await assert.rejects(read(f, sessionId), /draft-session-not-owned/); assert.deepEqual(await readFile(f.state), bytes);
    }
    for (const sessionId of ['a\u0000b', 'a\u007fb', 'a'.repeat(129)]) {
      await f.main.suspend(); const raw = structuredClone(original); raw.drafts[0].sessionId = sessionId; const bytes = Buffer.from(JSON.stringify(raw)); await writeFile(f.state, bytes, { mode: 0o600 });
      await assert.rejects(f.main.restoreAccount(binding, 'p1'), /recovery\/invalid-id/); assert.deepEqual(await readFile(f.state), bytes);
    }
    for (const sessionId of ['tools-code-mode:session', 'a'.repeat(128)]) {
      const raw = structuredClone(original); raw.drafts[0].sessionId = sessionId; await writeFile(f.state, JSON.stringify(raw), { mode: 0o600 });
      await f.main.restoreAccount(binding, 'p1'); await f.main.startHost(); await read(f, sessionId);
    }
  });
  test('a newly admitted run cannot rebind any retained history and can publish a new unique session', async t => {
    const f = await reopened(t, raw => { raw.drafts.push(clone(raw, 'duplicate', 'cold-owned-session', 'p2'), clone(raw, 'foreign', 'cold-foreign', 'p2'), clone(raw, 'unsafe', '../unsafe')); });
    await f.main.readRevision(ref); const run = await f.main.authorize([ref], 'new-admitted-run');
    for (const id of ['cold-owned-session', 'cold-foreign', '../unsafe']) await assert.rejects(f.business().prepareSessionBinding(run.runId, id, signal()), /session-run-conflict/);
    const lease = await f.business().prepareSessionBinding(run.runId, 'new-unique-session', signal()); lease.commit();
    await f.business().prepareDraft('new-unique-session', 'New draft, old history untouched', [ref], signal());
    const stored = JSON.parse(await readFile(f.state, 'utf8'));
    assert.deepEqual(stored.drafts.slice(0, 4), JSON.parse(f.before).drafts); assert.equal(stored.drafts[4].sessionId, 'new-unique-session');
    await read(f, 'new-unique-session'); lease.dispose();
  });
  test('offline failure, explicit stop and server denial revoke reads until explicit fresh restart', async t => {
    const f = await reopened(t), a = await read(f); f.disconnect();
    await assert.rejects(read(f), /broker\/request-failed/); assert.equal(a.signal.aborted, true);
    f.reconnect(); await assert.rejects(read(f), /offline-restart-required/);
    await f.main.startHost(); const b = await read(f); assert.notEqual(a.epoch, b.epoch);
    await f.main.stopEnterprise(); assert.equal(b.signal.aborted, true); await assert.rejects(read(f));
    await f.main.startHost(); const c = await read(f); f.revoke(); await assert.rejects(read(f), /afos\/read-denied/); assert.equal(c.signal.aborted, true);
    assert.deepEqual(await readFile(f.state), f.before);
  });
  for (const change of ['caller-abort', 'project-switch', 'suspend', 'stop', 'logout']) test(`in-flight authority result is refused after ${change}`, async t => {
    const f = await reopened(t), old = f.business(), entered = Promise.withResolvers(), late = Promise.withResolvers(), caller = new AbortController(), a = await read(f);
    f.holdIdentity(async () => { entered.resolve(); await late.promise; });
    const pending = old.ownedSessionRead('cold-owned-session', caller.signal); const outcome = assert.rejects(pending); await entered.promise;
    if (change === 'caller-abort') caller.abort();
    else if (change === 'project-switch') await f.main.selectProject('p2');
    else if (change === 'suspend') await f.main.suspend();
    else if (change === 'stop') await f.main.stopEnterprise();
    else await f.main.logout();
    late.resolve(); await outcome;
    if (change !== 'caller-abort') assert.equal(a.signal.aborted, true);
    assert.deepEqual(await readFile(f.state), f.before);
  });
}
