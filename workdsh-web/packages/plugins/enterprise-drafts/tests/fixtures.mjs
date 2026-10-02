import { createHash } from 'node:crypto';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const time = '2026-10-02T12:00:00.000Z';
export const material = (id = 'material-A', revision = 'revision-1', content = 'Public test input') => ({ materialId: id, revisionId: revision, sha256: sha(content), name: `Material ${id}` });
export const ref = row => ({ materialId: row.materialId, revisionId: row.revisionId, sha256: row.sha256 });
export const draft = (patch = {}) => ({
  draftId: 'draft-A', sessionId: 'session-A', runId: 'run-A', attempt: 1, releaseId: 'release-fixed', policyRevision: 'policy-1',
  sources: [ref(material())], content: 'Local draft, for human review.', sha256: sha('Local draft, for human review.'),
  generatedAt: time, updatedAt: time, execution: 'completed_local', archive: 'local-only', ...patch,
});
export const state = (patch = {}) => ({ contractVersion: 'afos.drafts.v1', project: { id: 'project-A', name: 'Public fixture' }, authority: 'current', lastSyncAt: time, drafts: [], ...patch });
export const archive = row => ({ ...row, archive: 'receipt-recorded', receipt: { receiptId: 'receipt-A', artifactId: 'artifact-A', revisionId: 'artifact-revision-1', sha256: row.sha256, committedAt: time } });
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function facade(overrides = {}) {
  return {
    state: async () => state(), materials: async () => [material()], snapshot: async selected => ({ ...selected, text: 'Public test input' }),
    start: async input => draft({ sources: input.sources, execution: 'running' }),
    edit: async (id, content) => draft({ draftId: id, content, sha256: sha(content) }),
    cancel: async id => draft({ draftId: id, execution: 'cancel_requested' }), archive: async id => archive(draft({ draftId: id })),
    ...overrides,
  };
}
