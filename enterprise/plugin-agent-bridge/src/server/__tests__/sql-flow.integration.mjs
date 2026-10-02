import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { AgentBridge, digest } from '../../../dist/server/core.js';
import { fixture, reservation, settlement, budgetId } from './sql-fixture.mjs';

test('AFOS-SQL-01 official SQLite repositories commit one durable artifact/receipt and replay the identical request', async t => {
  const f = await fixture(t);
  const run = await f.authorize();
  const commit = await f.upload(run);
  const receipt = await f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', commit);
  assert.deepEqual(await f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', commit), receipt);
  assert.equal(await f.db.getRepository('afosArtifacts').count(), 1);
  assert.equal(await f.db.getRepository('afosReceipts').count(), 1);
  assert.equal(await f.db.getRepository('afosCommitRequests').count(), 1);
  assert.equal((await f.store.get('receipts', run.runId)).hash, digest('Local draft'));
  const artifact = await f.db.getRepository('afosArtifacts').findOne({ filterByTk: receipt.artifactId });
  assert.equal(artifact.get('payload').status, 'draft-needs-review');
  assert.deepEqual(artifact.get('payload').sources.map(ref => ref.materialId), ['material']);
  const reopened = await f.connection();
  assert.deepEqual(await reopened.store.get('receipts', run.runId), await f.store.get('receipts', run.runId));
  assert.equal((await f.bridge.dispatch(f.evidence, 'runs.getReceipt', { runId: run.runId, projectId: 'project' })).status, 'archived');
  await assert.rejects(f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', { ...commit, clientRequestId: 'changed-key' }), /afos\/idempotency-conflict/);
  assert.ok(f.sql.some(statement => /BEGIN DEFERRED TRANSACTION/u.test(statement)));
  const [isolation] = await f.db.sequelize.query('PRAGMA read_uncommitted');
  assert.equal(isolation[0].read_uncommitted, 0);
  t.diagnostic('Real SQLite SERIALIZABLE uses BEGIN DEFERRED and read_uncommitted=0; row locks are unsupported.');
});

test('AFOS-SQL-02 injected receipt failure rolls back the preceding commit request and artifact', async t => {
  const f = await fixture(t);
  const run = await f.authorize(), commit = await f.upload(run);
  const fail = () => { throw Error('isolated-receipt-failure'); };
  f.db.on('afosReceipts.beforeCreate', fail);
  await assert.rejects(f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', commit), /isolated-receipt-failure/);
  for (const name of ['afosCommitRequests', 'afosArtifacts', 'afosReceipts']) assert.equal(await f.db.getRepository(name).count(), 0);
  f.db.off('afosReceipts.beforeCreate', fail);
  assert.equal((await f.bridge.dispatch(f.evidence, 'runs.getReceipt', { runId: run.runId, projectId: 'project' })).status, 'authorized');
  await f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', commit);
  assert.equal(await f.db.getRepository('afosArtifacts').count(), 1);
});

test('AFOS-SQL-03 actual unique constraints protect private primary keys and the principal/client pair', async t => {
  const f = await fixture(t);
  await f.store.insert('commitRequests', { id: 'request', runId: 'run', requestHash: 'hash' });
  await assert.rejects(f.store.insert('commitRequests', { id: 'request', runId: 'other', requestHash: 'other' }), { name: 'SequelizeUniqueConstraintError' });
  await assert.rejects(f.db.getRepository('afosClientAccess').create({ values: {
    id: 'another-access', principalId: 'alice', clientId: 'desktop', deviceId: 'other', active: true,
  } }), { name: 'SequelizeUniqueConstraintError' });
  assert.equal(await f.db.getRepository('afosClientAccess').count(), 1);
  assert.equal((await f.store.get('commitRequests', 'request')).runId, 'run');
});

test('AFOS-SQL-04 immutable hooks reject real individual, repository and bulk changes without changing stored bytes', async t => {
  const f = await fixture(t);
  await f.store.insert('artifacts', { id: 'artifact', projectId: 'project', runId: 'run', revisionId: 'revision',
    hash: digest('draft'), content: 'draft', sources: [], releaseId: 'release', status: 'draft-needs-review' });
  await f.store.insert('receipts', { id: 'receipt', runId: 'run', attempt: 1, artifactId: 'artifact', revisionId: 'revision',
    hash: digest('draft'), archivedAt: new Date().toISOString(), requestHash: 'hash' });
  for (const [name, id] of [['afosMaterials', 'material'], ['afosArtifacts', 'artifact'], ['afosReceipts', 'receipt']]) {
    const repository = f.db.getRepository(name), collection = f.db.getCollection(name);
    const before = (await repository.findOne({ filterByTk: id })).toJSON();
    const field = name === 'afosMaterials' ? 'text' : 'payload';
    const value = field === 'text' ? 'tampered' : { tampered: true };
    await assert.rejects(repository.update({ filterByTk: id, values: { [field]: value } }), /afos\/immutable-record/);
    const row = await repository.findOne({ filterByTk: id });
    row.set(field, value);
    await assert.rejects(row.save(), /afos\/immutable-record/);
    await assert.rejects(row.destroy(), /afos\/immutable-record/);
    await assert.rejects(collection.model.update({ [field]: value }, { where: { id }, individualHooks: false }), /afos\/immutable-record/);
    await assert.rejects(collection.model.destroy({ where: { id }, individualHooks: false }), /afos\/immutable-record/);
    await assert.rejects(repository.destroy({ filterByTk: id }), /afos\/immutable-record/);
    assert.deepEqual((await repository.findOne({ filterByTk: id })).toJSON(), before);
  }
});

test('AFOS-SQL-05 real associations and current private SQL state revoke access after admission', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.tokenActive(f.evidence), true);
  await f.db.getRepository('users.roles', 'alice').remove('member');
  assert.equal(await f.store.tokenActive(f.evidence), false);
  await f.db.getRepository('users.roles', 'alice').add('member');
  assert.equal(await f.store.tokenActive(f.evidence), true);
  await f.db.getRepository('afosRevokedTokens').create({ values: { id: f.evidence.tokenId } });
  assert.equal(await f.store.tokenActive(f.evidence), false);
  await assert.rejects(f.authorize(), /afos\/access-revoked/);
  assert.equal(await f.db.getRepository('afosRuns').count(), 0);
});

test('AFOS-SQL-06 mounted private resource guards deny ordinary and associated API routes over SQL-owned state', async t => {
  const f = await fixture(t);
  await f.plugin.load();
  t.after(() => f.plugin.afterDisable());
  for (const path of ['/api/afosRuns:create', '/api/afosReceipts', '/api/afosModelCalls:update', '/api/projects/project/afosUploads']) {
    let forwarded = false;
    const ctx = { path, method: 'POST', request: { body: {} }, state: {}, query: {}, get: () => '' };
    await f.middlewares[0](ctx, async () => { forwarded = true; });
    assert.equal(ctx.status, 403);
    assert.equal(ctx.body.code, 'afos/private-resource');
    assert.equal(forwarded, false);
  }
  assert.equal(await f.db.getRepository('afosModelCalls').count(), 0);
  assert.ok(f.resources.filter(resource => resource.name !== 'afos').every(resource => resource.only.join(',') === 'afosPrivateDenied'));
});

test('AFOS-SQL-07 real SQL ledger preserves unknown reservation and settles canonical provider usage durably', async t => {
  const f = await fixture(t);
  await f.ledger.reserve({ ...reservation(), prompt: 'private prompt', vendorKey: 'vendor key' });
  await f.ledger.settle({ ...settlement(), prompt: 'private prompt', cost: { status: 'unknown', vendorKey: 'vendor key' } });
  assert.equal((await f.db.getRepository('afosModelBudgets').findOne({ filterByTk: budgetId })).get('payload').charged, 30);
  await assert.rejects(f.ledger.reserve(reservation('next')), { code: 'MODEL_BUDGET_EXCEEDED' });
  const second = await f.connection();
  await assert.rejects(second.ledger.reserve(reservation()), { code: 'MODEL_CALL_ALREADY_USED' });
  const all = await f.db.getRepository('afosModelCalls').find({ raw: true });
  assert.doesNotMatch(JSON.stringify(all), /private prompt|vendor key/);
  await f.ledger.reserve({ ...reservation('known', 'known-scope'), limitTokens: 100 });
  const known = { ...settlement('known', { status: 'known', source: 'provider', tokens: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } }), scopeKey: 'known-scope' };
  await f.ledger.settle(known);
  await second.ledger.settle(known);
  await assert.rejects(f.ledger.settle({ ...known, outcome: 'failed' }), { code: 'MODEL_SETTLEMENT_ALREADY_USED' });
  const knownId = createHash('sha256').update(JSON.stringify('known-scope')).digest('hex');
  assert.equal((await second.db.getRepository('afosModelBudgets').findOne({ filterByTk: knownId })).get('payload').charged, 17);
});

test('AFOS-SQL-08 aborted ledger transaction rolls back an already-created budget and call', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.db.on('afosModelCalls.afterCreate', () => controller.abort());
  await assert.rejects(f.ledger.reserve(reservation(), controller.signal), { name: 'AbortError' });
  assert.equal(await f.db.getRepository('afosModelBudgets').count(), 0);
  assert.equal(await f.db.getRepository('afosModelCalls').count(), 0);
});

test('AFOS-SQL-09 independent SQLite connections admit at most one concurrent budget reservation', async t => {
  const f = await fixture(t), second = await f.connection();
  const results = await Promise.allSettled([f.ledger.reserve(reservation('first')), second.ledger.reserve(reservation('second'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected').reason;
  assert.ok(rejected.code === 'MODEL_BUDGET_EXCEEDED' || rejected.parent?.code === 'SQLITE_BUSY' || rejected.original?.code === 'SQLITE_BUSY');
  assert.equal(await f.db.getRepository('afosModelCalls').count(), 1);
  assert.equal((await f.db.getRepository('afosModelBudgets').findOne({ filterByTk: budgetId })).get('payload').charged, 30);
  assert.equal(f.sql.some(statement => /FOR UPDATE/u.test(statement)), false);
  t.diagnostic(`Concurrent SQLite loser: ${rejected.code ?? rejected.parent?.code ?? rejected.original?.code}`);
  // SQLite has database-level locking; this is not PostgreSQL/MySQL row-lock evidence.
});

test('AFOS-SQL-10 separate Node processes cannot both spend the same SQLite budget snapshot', async t => {
  const f = await fixture(t);
  function worker(id) {
    const child = fork(new URL('./sql-worker.mjs', import.meta.url), [f.storage, id], {
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const waiting = new Map();
    let diagnostics = '';
    child.stdout.on('data', bytes => { diagnostics += bytes.toString(); });
    child.stderr.on('data', bytes => { diagnostics += bytes.toString(); });
    child.on('message', message => { waiting.get(message.type)?.resolve(message); });
    function event(type) {
      return new Promise((resolve, reject) => {
        let resolved = false;
        const timeout = setTimeout(() => { reject(Error(`SQL worker timeout: ${type}`)); child.kill(); }, 15_000);
        waiting.set(type, { resolve: value => { resolved = true; clearTimeout(timeout); resolve(value); } });
        child.once('exit', code => {
          clearTimeout(timeout);
          if (!resolved) reject(Error(`SQL worker exited ${code} before ${type}: ${diagnostics}`));
        });
      });
    }
    t.after(() => { if (child.connected) child.kill(); });
    const ready = event('ready'), snapshot = event('snapshot'), result = event('result');
    return { child, ready, snapshot, result };
  }
  const first = worker('process-one'), second = worker('process-two');
  await Promise.all([first.ready, second.ready]);
  first.child.send({ type: 'reserve' }); second.child.send({ type: 'reserve' });
  await Promise.all([first.snapshot, second.snapshot]);
  first.child.send({ type: 'write' }); second.child.send({ type: 'write' });
  const results = await Promise.all([first.result, second.result]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').code, 'SQLITE_BUSY');
  assert.equal(await f.db.getRepository('afosModelCalls').count(), 1);
  assert.equal((await f.db.getRepository('afosModelBudgets').findOne({ filterByTk: budgetId })).get('payload').charged, 30);
  t.diagnostic('Two independent processes read the same budget; SQLite allowed one commit and rejected one with SQLITE_BUSY.');
});

test('AFOS-SQL-11 concurrent archive requests produce one version and unknown results reconcile from SQL receipt', async t => {
  const f = await fixture(t), second = await f.connection();
  const secondBridge = new AgentBridge(second.store, 'release', 'policy', new Uint8Array(32).fill(1));
  const run = await f.authorize(), commit = await f.upload(run);
  const results = await Promise.allSettled([
    f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', commit),
    secondBridge.dispatch(f.evidence, 'artifacts.commitDraft', commit),
  ]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.equal(result.reason.parent?.code ?? result.reason.original?.code, 'SQLITE_BUSY');
  }
  const query = await secondBridge.dispatch(f.evidence, 'runs.getReceipt', { runId: run.runId, projectId: 'project' });
  assert.equal(query.status, 'archived');
  assert.equal(await f.db.getRepository('afosArtifacts').count(), 1);
  assert.equal(await f.db.getRepository('afosReceipts').count(), 1);
  assert.equal(await f.db.getRepository('afosCommitRequests').count(), 1);
  for (const result of results.filter(result => result.status === 'fulfilled')) assert.deepEqual(result.value, query.receipt);
  assert.deepEqual(await f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', commit), query.receipt);
});

test('AFOS-SQL-12 revoking current project membership after upload prevents an archive without removing local staged data', async t => {
  const f = await fixture(t), run = await f.authorize(), commit = await f.upload(run);
  await f.db.getRepository('afosProjectMembers').update({ filterByTk: 'membership', values: { active: false } });
  await assert.rejects(f.bridge.dispatch(f.evidence, 'artifacts.commitDraft', commit), /afos\/project-denied/);
  for (const name of ['afosCommitRequests', 'afosArtifacts', 'afosReceipts']) assert.equal(await f.db.getRepository(name).count(), 0);
  assert.equal((await f.store.get('uploads', commit.uploadId)).content, 'Local draft');
  await assert.rejects(f.bridge.dispatch(f.evidence, 'materials.readRevision', { materialId: 'material', revisionId: 'revision' }), /afos\/material-not-found/);
});

test('AFOS-SQL-13 actual provider usage above reservation is recorded honestly and prevents the next reservation', async t => {
  const f = await fixture(t);
  await f.ledger.reserve(reservation());
  await f.ledger.settle(settlement('one', {
    status: 'known', source: 'provider', tokens: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
  }));
  assert.equal((await f.db.getRepository('afosModelBudgets').findOne({ filterByTk: budgetId })).get('payload').charged, 75);
  await assert.rejects(f.ledger.reserve(reservation('next')), { code: 'MODEL_BUDGET_EXCEEDED' });
  t.diagnostic('This records verified usage and denies the next call; it is not a strict monetary cap.');
});
