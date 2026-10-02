import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftClient, DraftUiError, MAX_TEXT_BYTES, MAX_MATERIAL_BYTES, errorLabel } from '../dist/rpc.js';
import { ENTERPRISE_DRAFT_MAX_BYTES } from 'workdsh-contracts/enterprise-drafts';
import { archive, deferred, draft, material, ref, sha, state } from './fixtures.mjs';

test('all seven methods use official fixed Connection channel and field-only payloads', async () => {
  const calls = [], m = material();
  const values = { state: state(), materials: [m], snapshot: { ...ref(m), text: 'Public test input' }, start: draft(), edit: draft(), cancel: draft(), archive: archive(draft()) };
  const client = createDraftClient({ async call(channel, endpoint, payload, signal) { calls.push({ channel, endpoint, payload, signal }); return { ok: true, value: values[endpoint.split('/').at(-1)] }; } }, new AbortController().signal);
  await client.state(); await client.materials(); await client.snapshot(ref(m));
  await client.start({ sources: [ref(m)], goal: 'Prepare a draft', operationId: 'operation-1' });
  await client.edit('draft-A', 'Local draft, for human review.'); await client.cancel('draft-A'); await client.archive('draft-A', draft().sha256);
  assert.deepEqual(calls.map(row => [row.channel, row.endpoint, row.payload]), [
    ['/api', 'afos/drafts/state', {}], ['/api', 'afos/drafts/materials', {}], ['/api', 'afos/drafts/snapshot', { ref: ref(m) }],
    ['/api', 'afos/drafts/start', { sources: [ref(m)], goal: 'Prepare a draft', operationId: 'operation-1' }],
    ['/api', 'afos/drafts/edit', { draftId: 'draft-A', content: 'Local draft, for human review.' }],
    ['/api', 'afos/drafts/cancel', { draftId: 'draft-A' }], ['/api', 'afos/drafts/archive', { draftId: 'draft-A', expectedSha256: draft().sha256 }],
  ]);
  assert.ok(calls.every(row => row.signal instanceof AbortSignal));
  const frozen = await client.state(); assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.project));
});
test('rejects injected request fields without issuing RPC', async () => {
  let calls = 0; const client = createDraftClient({ async call() { calls++; return { ok: true, value: draft() }; } }, new AbortController().signal);
  for (const extra of ['actor', 'organizationId', 'url', 'path', 'token', 'preset', 'provider']) await assert.rejects(client.start({ sources: [ref(material())], goal: 'Draft', operationId: 'operation-A', [extra]: 'untrusted' }), { code: 'invalid-data' });
  await assert.rejects(client.snapshot({ ...ref(material()), path: 'untrusted' }), { code: 'invalid-data' });
  await assert.rejects(client.start({ sources: [ref(material()), ref(material())], goal: 'Draft', operationId: 'operation-A' }), { code: 'invalid-data' });
  assert.equal(calls, 0);
});
test('validates snapshot pins and actual content hash, rejects raw sensitive DTO fields', async () => {
  let value; const client = createDraftClient({ async call() { return { ok: true, value }; } }, new AbortController().signal);
  value = { ...ref(material()), text: 'Changed source content' }; await assert.rejects(client.snapshot(ref(material())), { code: 'invalid-data' });
  value = { ...ref(material()), revisionId: 'different', text: 'Public test input' }; await assert.rejects(client.snapshot(ref(material())), { code: 'invalid-data' });
  value = { ...draft(), content: 'Altered response' }; await assert.rejects(client.edit('draft-A', 'Altered response'), { code: 'invalid-data' });
  value = { ...state(), credentials: 'fixture-sensitive-field' }; await assert.rejects(client.state(), { code: 'invalid-data' });
  value = { ...draft(), receipt: archive(draft()).receipt }; await assert.rejects(client.archive('draft-A', draft().sha256), { code: 'invalid-data' });
  value = { ...draft(), archive: 'receipt-recorded' }; await assert.rejects(client.archive('draft-A', draft().sha256), { code: 'invalid-data' });
  value = archive(draft()); value.receipt.sha256 = sha('wrong'); await assert.rejects(client.archive('draft-A', draft().sha256), { code: 'invalid-data' });
});
test('limits UTF-8 bytes and rejects getters without evaluating them', async () => {
  let calls = 0, getters = 0;
  const client = createDraftClient({ async call() { calls++; return { ok: true, value: state() }; } }, new AbortController().signal);
  await assert.rejects(client.edit('draft-A', '中'.repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1)), { code: 'invalid-data' });
  const input = { sources: [ref(material())], operationId: 'operation-A', get goal() { getters++; return 'Draft'; } };
  await assert.rejects(client.start(input), { code: 'invalid-data' }); assert.equal(calls, 0); assert.equal(getters, 0);
});
test('array own methods, extra fields, holes and getters cannot bypass pin validation', async () => {
  let calls = 0, getters = 0;
  const client = createDraftClient({ async call() { calls++; return { ok: true, value: draft() }; } }, new AbortController().signal);
  const malicious = [ref(material())]; malicious.map = () => [{ ...ref(material()), token: 'fixture-private-field' }];
  const sparse = new Array(1), accessor = [ref(material())]; Object.defineProperty(accessor, '0', { get() { getters++; return ref(material()); } });
  for (const sources of [malicious, sparse, accessor]) await assert.rejects(client.start({ sources, goal: 'Draft', operationId: 'operation-A' }), { code: 'invalid-data' });
  assert.equal(calls, 0); assert.equal(getters, 0);
});
test('draft cap follows the public 64 KiB constant while material snapshots keep 1 MiB', async () => {
  assert.equal(MAX_TEXT_BYTES, ENTERPRISE_DRAFT_MAX_BYTES); assert.equal(MAX_TEXT_BYTES, 64 * 1024);
  let calls = 0;
  const client = createDraftClient({ async call(channel, endpoint, payload) {
    calls++;
    if (endpoint.endsWith('/snapshot')) return { ok: true, value: { ...payload.ref, text: 'M'.repeat(MAX_MATERIAL_BYTES) } };
    return { ok: true, value: draft({ content: payload.content, sha256: sha(payload.content) }) };
  } }, new AbortController().signal);
  await client.edit('draft-A', 'D'.repeat(MAX_TEXT_BYTES)); assert.equal(calls, 1);
  await assert.rejects(client.edit('draft-A', 'D'.repeat(MAX_TEXT_BYTES + 1)), { code: 'invalid-data' }); assert.equal(calls, 1);
  const source = { materialId: 'material-large', revisionId: 'revision-1', sha256: sha('M'.repeat(MAX_MATERIAL_BYTES)) };
  assert.equal((await client.snapshot(source)).text.length, MAX_MATERIAL_BYTES);
});
test('lifetime/caller cancellation forwards to Connection and rejects ignored late responses', async () => {
  for (const abortLifetime of [true, false]) {
    const lifetime = new AbortController(), caller = new AbortController(), done = deferred(); let wireSignal;
    const client = createDraftClient({ call(channel, endpoint, payload, signal) { wireSignal = signal; return done.promise; } }, lifetime.signal);
    const result = client.state(caller.signal); (abortLifetime ? lifetime : caller).abort(); assert.equal(wireSignal.aborted, true);
    done.resolve({ ok: true, value: state() }); await assert.rejects(result, { code: 'closed' });
  }
});
test('server and transport diagnostics never enter product errors', async () => {
  const diagnostic = 'fixture-private-url-and-key';
  const client = createDraftClient({ async call() { return { ok: false, error: { code: 'access/denied', message: diagnostic, details: { raw: diagnostic } } }; } }, new AbortController().signal);
  const error = await client.state().catch(error => error); assert.ok(error instanceof DraftUiError); assert.equal(error.code, 'denied'); assert.ok(!errorLabel(error).includes(diagnostic)); assert.ok(!String(error).includes(diagnostic));
});
