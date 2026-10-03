import type { EnterpriseDraftClient, EnterpriseDraftState, EnterpriseDraftView, EnterpriseMaterialView, EnterpriseSourceRef } from 'workdsh-contracts/enterprise-drafts';
import { boundedContent, DraftUiError, errorLabel, MAX_GOAL_LENGTH, MAX_SOURCES, sourceKey } from './rpc.js';

export interface PanelSnapshot {
  readonly state?: EnterpriseDraftState;
  readonly materials: readonly EnterpriseMaterialView[];
  readonly selectedSources: readonly EnterpriseSourceRef[];
  readonly selectedDraftId?: string;
  readonly preview?: EnterpriseSourceRef & { readonly text: string };
  readonly pending?: 'refresh' | 'preview' | 'start' | 'edit' | 'cancel' | 'archive';
  readonly error?: string;
  readonly notice?: string;
}
const EMPTY: PanelSnapshot = Object.freeze({ materials: Object.freeze([]), selectedSources: Object.freeze([]) });
export function isActive(draft: EnterpriseDraftView): boolean { return ['local_queued', 'running', 'cancel_requested'].includes(draft.execution); }
export function isArchived(draft: EnterpriseDraftView): boolean { return draft.archive === 'receipt-recorded' && !!draft.receipt && draft.receipt.sha256 === draft.sha256; }
export function canEdit(draft: EnterpriseDraftView): boolean { return draft.archive === 'local-only' && !isActive(draft); }

/** A volatile UI view/cache. All execution and archive facts come from Main. */
export class DraftPanelModel {
  private view: PanelSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private scopeRevision = 0;
  private closed = false;
  private request?: AbortController;
  private refreshJob?: Promise<void>;
  private retryStart?: { fingerprint: string; operationId: string };
  constructor(private readonly client: EnterpriseDraftClient, private readonly operationId: () => string = () => crypto.randomUUID()) {}
  readonly getSnapshot = (): PanelSnapshot => this.view;
  /** UI cache boundary, not an account or authorization assertion. */
  readonly getScopeRevision = (): number => this.scopeRevision;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(next: PanelSnapshot): void {
    if (this.closed) return;
    this.view = Object.freeze(next); for (const listener of this.listeners) listener();
  }
  private patch(next: Partial<PanelSnapshot>): void { this.publish({ ...this.view, ...next }); }
  /** Connection/account authority changed. No previous view survives the repull. */
  invalidate(): void {
    if (this.closed) return;
    this.scopeRevision++; this.epoch++; this.request?.abort(); this.request = undefined; this.refreshJob = undefined; this.retryStart = undefined;
    this.publish(EMPTY);
  }
  close(): void { this.invalidate(); this.closed = true; this.listeners.clear(); }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshJob) return this.refreshJob;
    if (this.view.pending && this.view.pending !== 'refresh') return Promise.resolve();
    const epoch = ++this.epoch, request = this.request = new AbortController();
    this.patch({ pending: 'refresh', error: undefined });
    const job = (async () => {
      try {
        const state = await this.client.state(request.signal);
        if (this.closed || epoch !== this.epoch) return;
        const sameProject = this.view.state?.project.id === state.project.id;
        const selectedDraftId = state.drafts.some(d => d.draftId === this.view.selectedDraftId) ? this.view.selectedDraftId : state.drafts[0]?.draftId;
        this.publish({ ...this.view, state, selectedDraftId,
          materials: sameProject && state.authority === 'current' ? this.view.materials : Object.freeze([]),
          selectedSources: sameProject && state.authority === 'current' ? this.view.selectedSources : Object.freeze([]),
          preview: sameProject && state.authority === 'current' ? this.view.preview : undefined,
          notice: sameProject ? this.view.notice : undefined,
        });
        // An offline projection authorizes local views only; no new enterprise read.
        if (state.authority === 'current') {
          const materials = await this.client.materials(request.signal);
          if (this.closed || epoch !== this.epoch) return;
          const visible = new Set(materials.map(sourceKey));
          this.patch({ materials, selectedSources: Object.freeze(this.view.selectedSources.filter(ref => visible.has(sourceKey(ref)))),
            preview: this.view.preview && visible.has(sourceKey(this.view.preview)) ? this.view.preview : undefined });
        }
        if (!this.closed && epoch === this.epoch) this.patch({ pending: undefined });
      } catch (error) {
        if (!this.closed && epoch === this.epoch) {
          // Unknown authority must not expose stale private content or selections.
          this.publish({ ...EMPTY, error: errorLabel(error) });
        }
      } finally { if (epoch === this.epoch) { this.request = undefined; this.refreshJob = undefined; } }
    })();
    this.refreshJob = job; return job;
  }
  toggleSource(ref: EnterpriseSourceRef): void {
    if (this.closed || this.view.pending || this.view.state?.authority !== 'current') return;
    const key = sourceKey(ref), listed = this.view.materials.find(row => sourceKey(row) === key);
    if (!listed) { this.patch({ error: errorLabel(new DraftUiError('selection')) }); return; }
    const selected = this.view.selectedSources;
    if (selected.some(row => sourceKey(row) === key)) this.patch({ selectedSources: Object.freeze(selected.filter(row => sourceKey(row) !== key)), error: undefined });
    else {
      const other = selected.filter(row => row.materialId !== listed.materialId);
      if (other.length >= MAX_SOURCES) { this.patch({ error: errorLabel(new DraftUiError('selection')) }); return; }
      this.patch({ selectedSources: Object.freeze([...other, Object.freeze({ materialId: listed.materialId, revisionId: listed.revisionId, sha256: listed.sha256 })]), error: undefined });
    }
  }
  selectDraft(draftId: string): void {
    if (this.closed || this.view.pending) return;
    if (this.view.state?.drafts.some(draft => draft.draftId === draftId)) this.patch({ selectedDraftId: draftId, error: undefined, notice: undefined });
  }
  private requireDraft(draftId: string): EnterpriseDraftView {
    const draft = this.view.state?.drafts.find(draft => draft.draftId === draftId);
    if (!draft) throw new DraftUiError('conflict'); return draft;
  }
  private requireCurrent(): void { if (this.view.state?.authority !== 'current') throw new DraftUiError('offline'); }
  private async perform<T>(pending: NonNullable<PanelSnapshot['pending']>, action: (signal: AbortSignal) => Promise<T>, commit: (value: T) => void): Promise<T | undefined> {
    if (this.closed) return undefined;
    if (this.view.pending) { this.patch({ error: errorLabel(new DraftUiError('busy')) }); return undefined; }
    const epoch = ++this.epoch, request = this.request = new AbortController();
    this.patch({ pending, error: undefined, notice: undefined });
    try {
      const value = await action(request.signal);
      if (this.closed || epoch !== this.epoch) return undefined;
      commit(value); return value;
    } catch (error) {
      if (!this.closed && epoch === this.epoch) {
        // Official unary transports do not expose a structured HTTP status.
        // An unknown transport failure may be rejection or lost authority; a
        // later explicit repull decides current/offline, never this old cache.
        if (error instanceof DraftUiError && ['denied', 'unavailable'].includes(error.code)) this.publish({ ...EMPTY, error: errorLabel(error) });
        else this.patch({ error: errorLabel(error) });
      }
      return undefined;
    } finally { if (!this.closed && epoch === this.epoch) { this.request = undefined; this.patch({ pending: undefined }); } }
  }
  private accept(draft: EnterpriseDraftView, previous?: EnterpriseDraftView): void {
    const state = this.view.state;
    if (!state) throw new DraftUiError('conflict');
    if (previous && (draft.draftId !== previous.draftId || draft.sessionId !== previous.sessionId || draft.runId !== previous.runId || draft.attempt !== previous.attempt || Date.parse(draft.updatedAt) < Date.parse(previous.updatedAt))) throw new DraftUiError('conflict');
    const existing = state.drafts.find(row => row.draftId === draft.draftId);
    if (existing && Date.parse(draft.updatedAt) < Date.parse(existing.updatedAt)) throw new DraftUiError('conflict');
    this.patch({ state: Object.freeze({ ...state, drafts: Object.freeze([draft, ...state.drafts.filter(row => row.draftId !== draft.draftId)].slice(0, 8)) }), selectedDraftId: draft.draftId });
  }
  async preview(ref: EnterpriseSourceRef): Promise<void> {
    await this.perform('preview', signal => {
      this.requireCurrent(); if (!this.view.materials.some(row => sourceKey(row) === sourceKey(ref))) throw new DraftUiError('selection');
      return this.client.snapshot(ref, signal);
    }, preview => this.patch({ preview }));
  }
  async start(goal: string): Promise<EnterpriseDraftView | undefined> {
    return this.perform('start', signal => {
      this.requireCurrent();
      if (!goal.trim() || goal.length > MAX_GOAL_LENGTH || !this.view.selectedSources.length || this.view.state?.drafts.some(isActive)) throw new DraftUiError('selection');
      const sources = this.view.selectedSources;
      const visible = new Set(this.view.materials.map(sourceKey));
      if (sources.some(row => !visible.has(sourceKey(row)))) throw new DraftUiError('selection');
      const fingerprint = JSON.stringify([sources.map(sourceKey), goal]);
      if (this.retryStart && this.retryStart.fingerprint !== fingerprint) throw new DraftUiError('conflict');
      this.retryStart ??= { fingerprint, operationId: this.operationId() };
      return this.client.start({ sources, goal, operationId: this.retryStart.operationId }, signal);
    }, draft => {
      const expected = this.view.selectedSources.map(sourceKey).sort();
      if (JSON.stringify(draft.sources.map(sourceKey).sort()) !== JSON.stringify(expected)) throw new DraftUiError('invalid-data');
      this.accept(draft); this.retryStart = undefined;
      this.patch({ notice: '任务由本机原生会话执行，结果待人工核对。' });
    });
  }
  async edit(draftId: string, content: string): Promise<EnterpriseDraftView | undefined> {
    let previous: EnterpriseDraftView;
    return this.perform('edit', signal => {
      previous = this.requireDraft(draftId); if (!canEdit(previous)) throw new DraftUiError('conflict');
      return this.client.edit(draftId, boundedContent(content), signal);
    }, draft => {
      if (draft.content !== content || !canEdit(draft)) throw new DraftUiError('conflict');
      this.accept(draft, previous); this.patch({ notice: '编辑已保存到本地工作副本，尚未归档。' });
    });
  }
  async cancel(draftId: string): Promise<void> {
    let previous: EnterpriseDraftView;
    await this.perform('cancel', signal => {
      previous = this.requireDraft(draftId); if (!isActive(previous)) throw new DraftUiError('conflict');
      return this.client.cancel(draftId, signal);
    }, draft => { this.accept(draft, previous); this.patch({ notice: draft.execution === 'cancelled' ? '原生会话已确认取消。' : '取消请求已提交，等待原生会话确认停止。' }); });
  }
  /** Call only after explicit UI confirmation of this saved content hash. */
  async archiveConfirmed(draftId: string, expectedHash: string): Promise<void> {
    let previous: EnterpriseDraftView;
    await this.perform('archive', signal => {
      this.requireCurrent(); previous = this.requireDraft(draftId);
      if (isActive(previous) || isArchived(previous) || previous.sha256 !== expectedHash || !previous.content.trim()) throw new DraftUiError('conflict');
      return this.client.archive(draftId, expectedHash, signal);
    }, draft => {
      if (draft.sha256 !== expectedHash) throw new DraftUiError('conflict');
      this.accept(draft, previous);
      this.patch({ notice: isArchived(draft) ? '服务器已确认不可变版本归档。' : '归档结果待核对，请刷新回执状态。' });
    });
  }
}
