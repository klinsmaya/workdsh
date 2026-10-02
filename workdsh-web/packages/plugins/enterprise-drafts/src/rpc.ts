import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import { ENTERPRISE_DRAFT_MAX_BYTES } from 'workdsh-contracts/enterprise-drafts';
import type { EnterpriseArchiveView, EnterpriseDraftClient, EnterpriseDraftState, EnterpriseDraftView, EnterpriseMaterialView, EnterpriseSourceRef } from 'workdsh-contracts/enterprise-drafts';

export const MAX_TEXT_BYTES = ENTERPRISE_DRAFT_MAX_BYTES;
export const MAX_MATERIAL_BYTES = 1024 * 1024;
export const MAX_GOAL_LENGTH = 4096;
export const MAX_SOURCES = 32;
export class DraftUiError extends Error {
  constructor(readonly code: 'invalid-data' | 'unavailable' | 'denied' | 'conflict' | 'closed' | 'selection' | 'busy' | 'offline') {
    super(code); this.name = 'DraftUiError';
  }
}
export function errorLabel(error: unknown): string {
  if (!(error instanceof DraftUiError)) return '操作未确认，请刷新状态后重试。';
  return {
    'invalid-data': '返回的数据或摘要校验失败，请刷新后重试。',
    unavailable: '服务暂不可用，操作结果尚未确认，请刷新状态。',
    denied: '当前权限不允许此操作，请刷新企业授权。',
    conflict: '内容或状态已变化，请刷新后重新确认。',
    closed: '页面连接已结束，请重新打开。',
    selection: '请选择当前可见资料版本，并填写有效目标。',
    busy: '已有操作正在等待确认，请稍候。',
    offline: '企业授权离线，当前只能查看和编辑本地草稿。',
  }[error.code];
}
function invalid(): never { throw new DraftUiError('invalid-data'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (Object.getOwnPropertySymbols(value).length || required.some(key => !Object.hasOwn(descriptors, key)) ||
    keys.some(key => ![...required, ...optional].includes(key) || !('value' in descriptors[key]!))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max || /\u0000/.test(value)) invalid();
  return value;
}
function id(value: unknown): string { const out = text(value, 256); if (/[\u0000-\u001f\u007f]/.test(out)) invalid(); return out; }
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value; }
function date(value: unknown): string {
  const out = text(value, 32); if (!Number.isFinite(Date.parse(out)) || new Date(out).toISOString() !== out) invalid(); return out;
}
export function boundedContent(value: unknown, maxBytes = MAX_TEXT_BYTES): string {
  const out = text(value, maxBytes, true);
  if (new TextEncoder().encode(out).byteLength > maxBytes) invalid();
  return out;
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function sourceKey(ref: EnterpriseSourceRef): string { return JSON.stringify([ref.materialId, ref.revisionId, ref.sha256]); }
export function parseRef(value: unknown): EnterpriseSourceRef {
  const row = record(value, ['materialId', 'revisionId', 'sha256']);
  return Object.freeze({ materialId: id(row.materialId), revisionId: id(row.revisionId), sha256: hash(row.sha256) });
}
function array(value: unknown, max: number, allowEmpty = false): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || (!allowEmpty && !value.length) || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), items: unknown[] = [];
  if (Object.keys(descriptors).some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) invalid();
    items.push(descriptor.value);
  }
  return items;
}
function refs(value: unknown): readonly EnterpriseSourceRef[] {
  const rows = array(value, MAX_SOURCES).map(parseRef);
  if (new Set(rows.map(sourceKey)).size !== rows.length || new Set(rows.map(row => row.materialId)).size !== rows.length) invalid();
  return Object.freeze(rows);
}
function receipt(value: unknown): EnterpriseArchiveView {
  const row = record(value, ['receiptId', 'artifactId', 'revisionId', 'sha256', 'committedAt']);
  return Object.freeze({ receiptId: id(row.receiptId), artifactId: id(row.artifactId), revisionId: id(row.revisionId), sha256: hash(row.sha256), committedAt: date(row.committedAt) });
}
export async function parseDraft(value: unknown): Promise<EnterpriseDraftView> {
  const row = record(value, ['draftId', 'sessionId', 'runId', 'attempt', 'releaseId', 'policyRevision', 'sources', 'content', 'sha256', 'generatedAt', 'updatedAt', 'execution', 'archive'], ['lastSyncAt', 'receipt']);
  const execution = row.execution, archive = row.archive;
  if (typeof execution !== 'string' || typeof archive !== 'string' || !['local_queued', 'running', 'cancel_requested', 'completed_local', 'failed', 'interrupted', 'cancelled'].includes(execution) ||
    !['local-only', 'needs-reconciliation', 'receipt-recorded'].includes(archive)) invalid();
  if (!Number.isSafeInteger(row.attempt) || (row.attempt as number) < 1) invalid();
  const content = boundedContent(row.content), sha256 = hash(row.sha256);
  if (await digest(content) !== sha256) invalid();
  const archiveReceipt = row.receipt === undefined ? undefined : receipt(row.receipt);
  if (archive === 'receipt-recorded' ? !archiveReceipt || archiveReceipt.sha256 !== sha256 : archiveReceipt !== undefined) invalid();
  return Object.freeze({
    draftId: id(row.draftId), sessionId: id(row.sessionId), runId: id(row.runId), attempt: row.attempt as number,
    releaseId: id(row.releaseId), policyRevision: id(row.policyRevision), sources: refs(row.sources), content, sha256,
    generatedAt: date(row.generatedAt), updatedAt: date(row.updatedAt),
    execution: execution as EnterpriseDraftView['execution'], archive: archive as EnterpriseDraftView['archive'],
    ...(row.lastSyncAt === undefined ? {} : { lastSyncAt: date(row.lastSyncAt) }),
    ...(archiveReceipt === undefined ? {} : { receipt: archiveReceipt }),
  });
}
async function parseState(value: unknown): Promise<EnterpriseDraftState> {
  const row = record(value, ['contractVersion', 'project', 'authority', 'drafts'], ['lastSyncAt']);
  if (row.contractVersion !== 'afos.drafts.v1' || typeof row.authority !== 'string' || !['current', 'offline'].includes(row.authority)) invalid();
  const project = record(row.project, ['id', 'name']);
  const drafts = await Promise.all(array(row.drafts, 8, true).map(parseDraft));
  if (new Set(drafts.map(d => d.draftId)).size !== drafts.length) invalid();
  return Object.freeze({ contractVersion: 'afos.drafts.v1', project: Object.freeze({ id: id(project.id), name: text(project.name, 512) }), authority: row.authority as EnterpriseDraftState['authority'], drafts: Object.freeze(drafts), ...(row.lastSyncAt === undefined ? {} : { lastSyncAt: date(row.lastSyncAt) }) });
}
function parseMaterials(value: unknown): readonly EnterpriseMaterialView[] {
  const rows = array(value, 2500, true).map(value => { const row = record(value, ['materialId', 'revisionId', 'sha256', 'name']); return Object.freeze({ materialId: id(row.materialId), revisionId: id(row.revisionId), sha256: hash(row.sha256), name: text(row.name, 512) }); });
  if (new Set(rows.map(sourceKey)).size !== rows.length) invalid();
  return Object.freeze(rows);
}
/** Uses the existing Connection caller. It creates neither a carrier nor endpoints. */
export function createDraftClient(rpc: Pick<ClientConnectionRpc, 'call'>, lifetime: AbortSignal): EnterpriseDraftClient {
  const checked = async <T>(value: Promise<T> | T, signal?: AbortSignal): Promise<T> => {
    const result = await value;
    if (lifetime.aborted || signal?.aborted) throw new DraftUiError('closed');
    return result;
  };
  const call = async (action: 'state' | 'materials' | 'snapshot' | 'start' | 'edit' | 'cancel' | 'archive', payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const owned = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
    if (owned.aborted) throw new DraftUiError('closed');
    let result;
    try { result = await rpc.call('/api', `afos/drafts/${action}`, payload, owned); }
    catch { throw new DraftUiError(owned.aborted ? 'closed' : 'unavailable'); }
    if (owned.aborted) throw new DraftUiError('closed');
    if (!result?.ok) {
      const code = result?.error?.code;
      throw new DraftUiError(typeof code === 'string' && /denied|forbidden|unauthori[sz]ed|revoked/.test(code) ? 'denied' : typeof code === 'string' && /conflict|stale/.test(code) ? 'conflict' : 'unavailable');
    }
    return result.value;
  };
  return Object.freeze({
    state: async (signal?: AbortSignal) => checked(parseState(await call('state', {}, signal)), signal),
    materials: async (signal?: AbortSignal) => checked(parseMaterials(await call('materials', {}, signal)), signal),
    snapshot: async (ref: EnterpriseSourceRef, signal?: AbortSignal) => {
      const fixed = parseRef(ref), row = record(await call('snapshot', { ref: fixed }, signal), ['materialId', 'revisionId', 'sha256', 'text']);
      const received = parseRef({ materialId: row.materialId, revisionId: row.revisionId, sha256: row.sha256 }), content = boundedContent(row.text, MAX_MATERIAL_BYTES);
      if (sourceKey(received) !== sourceKey(fixed) || await digest(content) !== fixed.sha256) invalid();
      return checked(Object.freeze({ ...received, text: content }), signal);
    },
    start: async (input: Parameters<EnterpriseDraftClient['start']>[0], signal?: AbortSignal) => {
      const row = record(input, ['sources', 'goal', 'operationId']);
      const goal = text(row.goal, MAX_GOAL_LENGTH); if (!goal.trim()) invalid();
      return checked(parseDraft(await call('start', { sources: refs(row.sources), goal, operationId: id(row.operationId) }, signal)), signal);
    },
    edit: async (draftId: string, content: string, signal?: AbortSignal) => checked(parseDraft(await call('edit', { draftId: id(draftId), content: boundedContent(content) }, signal)), signal),
    cancel: async (draftId: string, signal?: AbortSignal) => checked(parseDraft(await call('cancel', { draftId: id(draftId) }, signal)), signal),
    archive: async (draftId: string, expectedSha256: string, signal?: AbortSignal) => checked(parseDraft(await call('archive', { draftId: id(draftId), expectedSha256: hash(expectedSha256) }, signal)), signal),
  });
}
