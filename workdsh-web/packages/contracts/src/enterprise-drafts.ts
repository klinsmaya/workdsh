/** Enterprise business views. Session execution remains owned by official DSH. */
export const ENTERPRISE_DRAFT_MAX_BYTES = 64 * 1024;
export interface EnterpriseSourceRef {
  readonly materialId: string;
  readonly revisionId: string;
  readonly sha256: string;
}
export interface EnterpriseMaterialView extends EnterpriseSourceRef { readonly name: string }
export interface EnterpriseArchiveView {
  readonly receiptId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly sha256: string;
  readonly committedAt: string;
}
export interface EnterpriseDraftView {
  readonly draftId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly releaseId: string;
  readonly policyRevision: string;
  readonly sources: readonly EnterpriseSourceRef[];
  readonly content: string;
  readonly sha256: string;
  readonly generatedAt: string;
  readonly updatedAt: string;
  /** A projection of official Session events; never a second execution truth. */
  readonly execution: 'local_queued' | 'running' | 'cancel_requested' | 'completed_local' | 'failed' | 'interrupted' | 'cancelled';
  readonly archive: 'local-only' | 'needs-reconciliation' | 'receipt-recorded';
  readonly lastSyncAt?: string;
  readonly receipt?: EnterpriseArchiveView;
}
export interface EnterpriseDraftState {
  readonly contractVersion: 'afos.drafts.v1';
  readonly project: { readonly id: string; readonly name: string };
  readonly authority: 'current' | 'offline';
  readonly lastSyncAt?: string;
  readonly drafts: readonly EnterpriseDraftView[];
}
/** Trusted, fixed business facade. No credentials, URLs, file paths, presets or shell. */
export interface EnterpriseDraftClient {
  state(signal?: AbortSignal): Promise<EnterpriseDraftState>;
  materials(signal?: AbortSignal): Promise<readonly EnterpriseMaterialView[]>;
  snapshot(ref: EnterpriseSourceRef, signal?: AbortSignal): Promise<EnterpriseSourceRef & { readonly text: string }>;
  start(input: { readonly sources: readonly EnterpriseSourceRef[]; readonly goal: string; readonly operationId: string }, signal?: AbortSignal): Promise<EnterpriseDraftView>;
  edit(draftId: string, content: string, signal?: AbortSignal): Promise<EnterpriseDraftView>;
  cancel(draftId: string, signal?: AbortSignal): Promise<EnterpriseDraftView>;
  /** User-confirmed archive only. Agents cannot receive this method. */
  archive(draftId: string, expectedSha256: string, signal?: AbortSignal): Promise<EnterpriseDraftView>;
}
