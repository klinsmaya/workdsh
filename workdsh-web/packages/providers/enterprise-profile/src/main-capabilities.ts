import type { EnterpriseBinding, GatewayAuthoritySnapshot } from 'workdsh-contracts';
import type { EnterpriseDraftView, EnterpriseSourceRef, EnterpriseMaterialView } from 'workdsh-contracts/enterprise-drafts';

export interface OwnedEnterpriseRun {
  readonly runId: string; readonly attempt: number; readonly projectId: string;
  readonly releaseId: string; readonly policyRevision: string;
  readonly inputRefs: readonly EnterpriseSourceRef[]; readonly expiresAt: string;
  readonly binding: EnterpriseBinding;
}
export interface MainDraftRecord {
  readonly draftId: string; readonly sessionId: string; readonly run: OwnedEnterpriseRun;
  readonly content: string; readonly sha256: string; readonly generatedAt: string; readonly updatedAt: string;
  readonly inputSnapshots: readonly EnterpriseSourceRef[];
  readonly localExecution: EnterpriseDraftView['execution']; readonly archive: EnterpriseDraftView['archive'];
  readonly lastSyncAt?: string; readonly receipt?: EnterpriseDraftView['receipt'];
}
export interface OfficialTurnEvent {
  readonly type: 'turn/start' | 'turn/end'; readonly seq: number; readonly time: number;
  readonly data: { readonly turn: number; readonly reason?: { readonly kind: string } };
}
/** Injected privately at trusted assembly. Never serialized or exposed as one Remote. */
export interface MainBusinessCapabilities {
  currentAuthority(signal: AbortSignal): Promise<GatewayAuthoritySnapshot>;
  localState(): { readonly project: { readonly id: string; readonly name: string }; readonly authority: 'current' | 'offline'; readonly lastSyncAt: string };
  authorize(refs: readonly EnterpriseSourceRef[], operationId: string, signal: AbortSignal): Promise<OwnedEnterpriseRun>;
  releaseRunAdmission(runId: string): void;
  prepareSessionBinding(runId: string, sessionId: string, signal: AbortSignal): Promise<{ commit(): void; dispose(): void }>;
  sessionRun(sessionId: string, signal: AbortSignal): Promise<OwnedEnterpriseRun>;
  ownedSessionRead(sessionId: string, signal: AbortSignal): Promise<{ readonly sessionId: string; readonly epoch: object; readonly signal: AbortSignal; readonly expiresAt: string }>;
  readPinnedSnapshot(sessionId: string, ref: Pick<EnterpriseSourceRef, 'materialId' | 'revisionId'>, signal: AbortSignal): Promise<EnterpriseSourceRef & { readonly text: string }>;
  prepareDraft(sessionId: string, content: string, refs: readonly EnterpriseSourceRef[], signal: AbortSignal): Promise<{ readonly text: string; readonly sources: readonly EnterpriseSourceRef[]; readonly status: 'local-draft' }>;
  modelBytes(sessionId: string, request: unknown, signal: AbortSignal): AsyncIterable<Uint8Array>;
  projectSessionEvent(sessionId: string, event: OfficialTurnEvent): void;
  drafts(): readonly MainDraftRecord[];
  editDraft(draftId: string, content: string): MainDraftRecord;
  markCancellation(sessionId: string, stopped: boolean): void;
  materials(signal: AbortSignal): Promise<readonly EnterpriseMaterialView[]>;
  readRevision(ref: EnterpriseSourceRef, signal: AbortSignal): Promise<EnterpriseSourceRef & { readonly text: string }>;
  archiveFromUser(draftId: string, expectedSha256: string, signal: AbortSignal): Promise<unknown>;
}
export function draftView(record: MainDraftRecord): EnterpriseDraftView {
  return Object.freeze({ draftId: record.draftId, sessionId: record.sessionId, runId: record.run.runId,
    attempt: record.run.attempt, releaseId: record.run.releaseId, policyRevision: record.run.policyRevision,
    sources: Object.freeze(record.run.inputRefs.map(ref => Object.freeze({ ...ref }))), content: record.content,
    sha256: record.sha256, generatedAt: record.generatedAt, updatedAt: record.updatedAt,
    execution: record.localExecution, archive: record.archive,
    ...(record.lastSyncAt ? { lastSyncAt: record.lastSyncAt } : {}),
    ...(record.receipt ? { receipt: Object.freeze({ receiptId: record.receipt.receiptId, artifactId: record.receipt.artifactId,
      revisionId: record.receipt.revisionId, sha256: record.receipt.sha256, committedAt: record.receipt.committedAt }) } : {}) });
}
