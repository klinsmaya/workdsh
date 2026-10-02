import * as React from 'react';
import { Button, Icon, Modal, Textarea, controlsCss, modalCss } from 'workdsh-ui';
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { EnterpriseDraftView, EnterpriseSourceRef } from 'workdsh-contracts/enterprise-drafts';
import { DraftPanelModel, canEdit, isActive, isArchived } from '../model.js';
import { MAX_GOAL_LENGTH, MAX_TEXT_BYTES, sourceKey } from '../rpc.js';
import { draftsCss } from './styles.js';

export const executionLabels: Readonly<Record<EnterpriseDraftView['execution'], string>> = {
  local_queued: '本机等待执行', running: '原生会话执行中', cancel_requested: '已请求取消，等待停止确认',
  completed_local: '本地生成完成', failed: '执行失败', interrupted: '执行已中断', cancelled: '原生会话已取消',
};
export function archiveLabel(draft: EnterpriseDraftView): string {
  return isArchived(draft) ? '已归档 · 服务器回执确认' : draft.archive === 'needs-reconciliation' ? '归档待核对 · 尚未确认' : '本地工作副本 · 未归档';
}
export interface PanelInjected {
  readonly model: DraftPanelModel;
  readonly openSession: (sessionId: string) => Promise<void>;
  readonly toggleNavigation: () => void;
}
export type DraftPanelProps = PropsRuntime<'main'> & InjectFace<PanelInjected>;
export function SourceList({ sources }: { readonly sources: readonly EnterpriseSourceRef[] }): React.ReactElement {
  return <ul>{sources.map(ref => <li key={sourceKey(ref)}><span>{ref.materialId} / {ref.revisionId}</span><div className="small">SHA-256 {ref.sha256}</div></li>)}</ul>;
}
export function DraftDetails({ draft }: { readonly draft: EnterpriseDraftView }): React.ReactElement {
  return <><dl>
    <dt>执行状态</dt><dd>{executionLabels[draft.execution]}</dd><dt>归档状态</dt><dd>{archiveLabel(draft)}</dd>
    <dt>草稿</dt><dd>{draft.draftId}</dd><dt>发布版本</dt><dd>{draft.releaseId}</dd><dt>策略版本</dt><dd>{draft.policyRevision}</dd>
    <dt>运行 / 尝试</dt><dd>{draft.runId} / {draft.attempt}</dd><dt>原生会话</dt><dd>{draft.sessionId}</dd>
    <dt>内容摘要</dt><dd>{draft.sha256}</dd><dt>生成时间</dt><dd>{draft.generatedAt}</dd><dt>更新时间</dt><dd>{draft.updatedAt}</dd>
    <dt>最近同步</dt><dd>{draft.lastSyncAt ?? '尚无服务器同步时间'}</dd>
    {isArchived(draft) && <><dt>服务器回执</dt><dd>{draft.receipt!.receiptId}</dd><dt>成果 / 版本</dt><dd>{draft.receipt!.artifactId} / {draft.receipt!.revisionId}</dd><dt>归档时间</dt><dd>{draft.receipt!.committedAt}</dd></>}
  </dl><h3>本次实际输入版本</h3><SourceList sources={draft.sources} /></>;
}
function Editor({ draft, model, busy, current, openSession, onDirty }: {
  readonly draft: EnterpriseDraftView; readonly model: DraftPanelModel; readonly busy: boolean; readonly current: boolean;
  readonly openSession: PanelInjected['openSession']; readonly onDirty: (dirty: boolean) => void;
}): React.ReactElement {
  const [content, setContent] = React.useState(draft.content);
  const [baseContent, setBaseContent] = React.useState(draft.content);
  const [baseHash, setBaseHash] = React.useState(draft.sha256);
  const [confirmHash, setConfirmHash] = React.useState<string>();
  const [navigationError, setNavigationError] = React.useState(false);
  const dirty = content !== baseContent, changed = dirty && baseHash !== draft.sha256;
  React.useEffect(() => { if (!dirty) { setContent(draft.content); setBaseContent(draft.content); setBaseHash(draft.sha256); } }, [draft.content, draft.sha256, dirty]);
  React.useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const reload = () => { setContent(draft.content); setBaseContent(draft.content); setBaseHash(draft.sha256); };
  const save = async () => { const saved = await model.edit(draft.draftId, content); if (saved) { setContent(saved.content); setBaseContent(saved.content); setBaseHash(saved.sha256); } };
  return <section className="card" aria-label="草稿预览与编辑">
    <div className="bar"><h2>草稿 · 待人工核对</h2><Button variant="outline" size="sm" disabled={busy || dirty} onClick={() => { setNavigationError(false); void openSession(draft.sessionId).catch(() => setNavigationError(true)); }}>打开原生会话</Button></div>
    <p className="muted">AI 建议不能作为企业正式决定。本页支持纯文本预览和编辑。</p>
    {navigationError && <p role="alert">原生会话暂未就绪，请稍后重试。</p>}
    <DraftDetails draft={draft} />
    <label className="field" htmlFor="afos-draft-editor">本地草稿正文</label>
    <Textarea id="afos-draft-editor" className="editor" value={content} maxLength={MAX_TEXT_BYTES} readOnly={!canEdit(draft)} disabled={busy} onChange={event => setContent(event.currentTarget.value)} />
    {changed && <p role="alert">服务器工作副本已变化。保留了未保存编辑；请核对后重新载入最新版本。</p>}
    <p className="small">{dirty ? '有未保存编辑；请先保存或放弃编辑，再新建任务或打开会话' : isArchived(draft) ? '已归档版本只读' : '当前正文已保存在本地工作副本'} · 草稿纯文本上限 {MAX_TEXT_BYTES / 1024} KiB（UTF-8）</p>
    <div className="actions">
      <Button onClick={() => void save()} disabled={busy || !canEdit(draft) || !dirty || changed}>保存本地编辑</Button>
      <Button variant="outline" onClick={reload} disabled={busy || !dirty}>放弃编辑并载入当前版本</Button>
      <Button variant="outline" onClick={() => void model.cancel(draft.draftId)} disabled={busy || !isActive(draft) || draft.execution === 'cancel_requested'}>请求取消</Button>
      <Button onClick={() => setConfirmHash(draft.sha256)} disabled={busy || !current || dirty || isActive(draft) || isArchived(draft) || !draft.content.trim()}>{draft.archive === 'needs-reconciliation' ? '核对归档回执' : '确认后归档'}</Button>
    </div>
    <h3 className="preview-label">纯文本预览</h3><pre>{content || '尚无生成正文。'}</pre>
    <Modal open={confirmHash !== undefined} label="确认归档当前保存版本" className="afos-drafts-dialog" onClose={() => { if (!busy) setConfirmHash(undefined); }}>
      <h2>确认归档当前保存版本</h2>
      <p>将此已保存草稿作为项目内不可变成果版本提交。服务器会重新校验当前权限；只有取得真实回执才显示已归档。</p>
      <p>内容 SHA-256：<code>{confirmHash}</code></p>
      {draft.archive === 'needs-reconciliation' && <p>现有归档结果未确认，服务端会先核对原操作回执。不会由页面自动创建另一个版本。</p>}
      <div className="actions"><Button variant="outline" disabled={busy} onClick={() => setConfirmHash(undefined)}>返回核对</Button><Button disabled={busy || dirty || confirmHash !== draft.sha256 || !current} onClick={() => { const hash = confirmHash; setConfirmHash(undefined); if (hash) void model.archiveConfirmed(draft.draftId, hash); }}>我确认提交此版本</Button></div>
    </Modal>
  </section>;
}
export function EnterpriseDraftPanel({ model, openSession, toggleNavigation }: DraftPanelProps): React.ReactElement {
  const view = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [goal, setGoal] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const [selectConfirm, setSelectConfirm] = React.useState<string>();
  const state = view.state, busy = !!view.pending, current = state?.authority === 'current';
  const draft = state?.drafts.find(row => row.draftId === view.selectedDraftId);
  const setEditorDirty = React.useCallback((value: boolean) => setDirty(value), []);
  React.useEffect(() => { void model.refresh(); const timer = setInterval(() => void model.refresh(), 3000); return () => clearInterval(timer); }, [model]);
  React.useEffect(() => { setGoal(''); setDirty(false); setSelectConfirm(undefined); }, [state?.project.id]);
  const chooseDraft = (id: string) => { if (dirty && id !== draft?.draftId) setSelectConfirm(id); else model.selectDraft(id); };
  return <main className="afos-drafts" aria-label="企业草稿">
    <style>{controlsCss}{modalCss}{draftsCss}</style>
    <header className="bar"><div className="actions"><Button variant="ghost" size="sm" onClick={toggleNavigation} aria-label="切换导航"><Icon name="panel" /></Button><div><h1>企业草稿</h1><p className="muted">{state ? `${state.project.name} · ${current ? '当前企业授权' : '企业授权离线'}` : '等待企业业务状态'}</p></div></div><Button variant="outline" disabled={busy} onClick={() => void model.refresh()}>刷新资料与状态</Button></header>
    <div className="small">项目 {state?.project.id ?? '尚未确认'} · 最近同步 {state?.lastSyncAt ?? '尚无服务器同步时间'}</div>
    {view.pending && <div className="message" role="status">{view.pending === 'refresh' ? '正在刷新业务投影…' : '操作已提交，正在等待确认…'}</div>}
    {view.error && <div className="message" role="alert">{view.error}</div>}
    {view.notice && <div className="message" role="status">{view.notice}</div>}
    {state?.authority === 'offline' && <p className="message">可查看和编辑本地草稿。企业新动作已停止；联网后请刷新授权，不会自动上传。</p>}
    {state && <div className="grid"><aside>
      <section className="card"><h2>授权资料版本</h2><p className="muted">明确选择本次任务可用的资料。每份输入固定到实际修订和摘要。</p>
        {!view.materials.length && <p className="muted">{current ? '没有当前可见资料。' : '离线时不读取新的企业资料。'}</p>}
        {view.materials.map(material => <div className="material" key={sourceKey(material)}><label><input type="checkbox" disabled={busy || !current} checked={view.selectedSources.some(ref => sourceKey(ref) === sourceKey(material))} onChange={() => model.toggleSource(material)} /><span>{material.name}<div className="small">{material.materialId} / {material.revisionId}</div><div className="small">SHA-256 {material.sha256}</div></span></label><Button variant="ghost" size="sm" disabled={busy || !current} onClick={() => void model.preview({ materialId: material.materialId, revisionId: material.revisionId, sha256: material.sha256 })}>查看纯文本快照</Button></div>)}
        {view.preview && <><h3 className="preview-label">资料快照 · 内容按不可信文本展示</h3><div className="small">{view.preview.materialId} / {view.preview.revisionId} · {view.preview.sha256}</div><pre>{view.preview.text}</pre></>}
        <form onSubmit={event => { event.preventDefault(); if (!dirty) void model.start(goal); }}><label className="field" htmlFor="afos-draft-goal">本次草稿目标</label><Textarea id="afos-draft-goal" value={goal} maxLength={MAX_GOAL_LENGTH} disabled={busy || !current} placeholder="说明需要整理的内容与草稿要求" onChange={event => setGoal(event.currentTarget.value)} /><p className="small">已选 {view.selectedSources.length} 份资料 · 使用企业固定专家和 Skill</p><Button type="submit" disabled={busy || dirty || !current || !goal.trim() || !view.selectedSources.length || state.drafts.some(isActive)}>生成本地草稿</Button></form>
      </section>
      <section className="card"><h2>草稿与原生会话</h2>{!state.drafts.length && <p className="muted">尚无本地草稿。</p>}{state.drafts.map(row => <button type="button" className="draft-row" key={row.draftId} aria-current={row.draftId === draft?.draftId} disabled={busy} onClick={() => chooseDraft(row.draftId)}>{row.draftId}<div className="small">{executionLabels[row.execution]} · {archiveLabel(row)}</div><div className="small">{row.updatedAt}</div></button>)}</section>
    </aside><div>{draft ? <Editor key={`${state.project.id}/${draft.draftId}`} draft={draft} model={model} busy={busy} current={current} openSession={openSession} onDirty={setEditorDirty} /> : <section className="card"><h2>草稿预览</h2><p className="muted">选择资料并生成草稿，或打开现有工作副本。</p></section>}</div></div>}
    <Modal open={selectConfirm !== undefined} label="切换前放弃未保存编辑" className="afos-drafts-dialog" onClose={() => setSelectConfirm(undefined)}><h2>切换前核对编辑</h2><p>当前有未保存编辑。确认切换会放弃这些编辑；已保存的本地工作副本仍保留。</p><div className="actions"><Button variant="outline" onClick={() => setSelectConfirm(undefined)}>保留编辑</Button><Button disabled={busy} onClick={() => { const id = selectConfirm; setSelectConfirm(undefined); setDirty(false); if (id) model.selectDraft(id); }}>放弃未保存编辑并切换</Button></div></Modal>
  </main>;
}
