import { Context, Service } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LlmAdapter, createUserMessage, isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import { EnterpriseModelAdapter, decodeModelSse, type ModelPolicy } from '@afos/model-adapter';
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection';
import { ENTERPRISE_DRAFT_MAX_BYTES, type EnterpriseDraftState, type EnterpriseDraftView, type EnterpriseSourceRef } from 'workdsh-contracts/enterprise-drafts';
import { draftView, type MainDraftRecord, type OfficialTurnEvent } from './main-capabilities.js';
import { EnterpriseProfileError } from './snapshot-authority.js';
import { ENTERPRISE_TOOL_NAMES } from './profile-policy.js';
import './authority-service.js';

export interface RuntimeConfig { readonly model: ModelPolicy }
function fail(): never { throw new EnterpriseProfileError('afos/drafts-operation-denied'); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u001f]/u.test(value)) fail(); }
function source(value: unknown): asserts value is EnterpriseSourceRef {
  exact(value, ['materialId', 'revisionId', 'sha256']); id(value.materialId); id(value.revisionId);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) fail();
}

/** Fixed business owner delegates every turn/tool/model/storage operation to the official services. */
export class EnterpriseDraftRuntime extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections', 'llm', 'tools', 'skills', 'systemPrompt', 'agentPresets', 'afosProfileAuthority', 'afosMainBusiness'];
  readonly #lifetime = new AbortController();
  readonly #handles = new Map<string, AgentHandle>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #policy: ModelPolicy;
  #starting = false;
  #active: Agent | undefined;
  #lastSyncAt: string | undefined;
  constructor(ctx: Context, config: RuntimeConfig) {
    super(ctx, 'afosDraftRuntime');
    if (!config?.model || !Number.isSafeInteger(config.model.maxTokens) || config.model.maxTokens < 1) fail();
    this.#policy = Object.freeze({ ...config.model });
    const content = readFileSync(new URL('../resources/skills/afos-material-draft/SKILL.md', import.meta.url), 'utf8');
    ctx.skills.register({ name: 'afos-material-draft', description: 'Produce an internal draft from pinned enterprise text materials.', source: 'bundled', content });
    ctx.provide('afosProfileBridge', Object.freeze({
      createSession: async () => { throw new EnterpriseProfileError('afos/profile-select-materials-required'); },
      readPinnedSnapshot: (sessionId: string, ref: Pick<EnterpriseSourceRef, 'materialId' | 'revisionId'>, signal: AbortSignal) => ctx.afosMainBusiness.readPinnedSnapshot(sessionId, ref, signal),
      prepareDraft: (sessionId: string, text: string, refs: readonly EnterpriseSourceRef[], signal: AbortSignal) => ctx.afosMainBusiness.prepareDraft(sessionId, text, refs, signal),
    }));
    const owner = this;
    // This public waterfall receives the original frozen LOOP envelope before
    // official message/tool projection may copy it and lose its WeakSet marker.
    ctx.on('llm/stream', (options, next) => {
      const handle = options.sessionId ? owner.#handles.get(String(options.sessionId)) : undefined;
      if (!isAgentLoopRequest(options) || !handle || ctx.agents.get(handle.agent.id) !== handle.agent
        || owner.#active !== handle.agent || options.provider !== owner.#policy.provider || options.model !== owner.#policy.model) fail();
      owner.signal(options.signal).throwIfAborted();
      return next();
    }, { global: true, prepend: true });
    class ManagedAdapter extends LlmAdapter {
      providerInfo(provider: string) { if (provider !== owner.#policy.provider) fail(); return { id: provider, name: 'AFOS managed model' }; }
      async resolveModel(provider: string, model: string) {
        if (provider !== owner.#policy.provider || model !== owner.#policy.model) fail();
        return { provider, id: model, name: model, defaultMaxTokens: owner.#policy.maxTokens, inputModalities: ['text'] as const };
      }
      async listModels(provider: string) { return [await this.resolveModel(provider, owner.#policy.model)]; }
      async* stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        if (!options.sessionId) fail();
        const sessionId = String(options.sessionId), handle = owner.#handles.get(sessionId);
        if (!handle || ctx.agents.get(handle.agent.id) !== handle.agent || owner.#active !== handle.agent) fail();
        const signal = owner.signal(options.signal);
        const run = await ctx.afosMainBusiness.sessionRun(sessionId, signal);
        const adapter = new EnterpriseModelAdapter(owner.#policy, {
          getRun: () => ({ runId: run.runId, attempt: run.attempt }),
          assertCurrent: async (expected, suppliedSignal) => {
            if (ctx.agents.get(handle.agent.id) !== handle.agent || owner.#active !== handle.agent) fail();
            const current = await ctx.afosMainBusiness.sessionRun(sessionId, owner.signal(suppliedSignal));
            if (current.runId !== expected.runId || current.attempt !== expected.attempt) fail();
          },
          transport: { async* stream(request, suppliedSignal) {
            const controller = new AbortController();
            const combined = AbortSignal.any([suppliedSignal, controller.signal]);
            const iterator = ctx.afosMainBusiness.modelBytes(sessionId, request, combined)[Symbol.asyncIterator]();
            const body = new ReadableStream<Uint8Array>({
              async pull(target) { try { combined.throwIfAborted(); const item = await iterator.next(); combined.throwIfAborted(); if (item.done) target.close(); else target.enqueue(item.value); } catch (error) { target.error(error); } },
              cancel() { controller.abort(); if (iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined); },
            });
            try { yield* decodeModelSse(body, combined); }
            finally { controller.abort(); if (iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined); }
          } },
        });
        // Official LlmRuntime already projected updates because resolveModel supplies no toolUpdate extension.
        // The fixed wire contract excludes the remaining internal history bookkeeping.
        const { toolHistory: _projectedHistory, ...projected } = options;
        yield* adapter.stream(projected);
      }
    }
    ctx.llm.registerAdapter([this.#policy.provider], new ManagedAdapter());
    ctx.on('session/event', (session, event) => {
      if (this.#handles.get(String(session.id))?.agent.session !== session || !['turn/start', 'turn/end'].includes(event.type)) return;
      try { ctx.afosMainBusiness.projectSessionEvent(String(session.id), event as OfficialTurnEvent); }
      catch { this.#active?.cancel({ kind: 'hook', reason: 'afos-main-projection-cutoff' }); }
    });
    ctx.effect(() => async () => {
      this.#lifetime.abort(); this.#active?.cancel({ kind: 'hook', reason: 'afos-host-disposed' });
      await Promise.allSettled([...this.#tasks]);
      await Promise.allSettled([...this.#handles.values()].map(handle => handle.dispose())); this.#handles.clear();
    }, 'afosDraftRuntime.dispose');
  }
  private signal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]); }
  private own(draftId: string): MainDraftRecord {
    id(draftId); const result = this.ctx.afosMainBusiness.drafts().find(draft => draft.draftId === draftId);
    if (!result) fail(); return result;
  }
  private async state(): Promise<EnterpriseDraftState> {
    const authority = await this.ctx.afosMainBusiness.currentAuthority(this.signal()); this.#lastSyncAt = new Date().toISOString();
    return Object.freeze({ contractVersion: 'afos.drafts.v1', project: Object.freeze({ id: authority.project.id, name: authority.project.name }),
      authority: 'current', lastSyncAt: this.#lastSyncAt, drafts: Object.freeze(this.ctx.afosMainBusiness.drafts().map(draftView)) });
  }
  private async start(value: unknown, callerSignal: AbortSignal): Promise<EnterpriseDraftView> {
    exact(value, ['sources', 'goal', 'operationId']); id(value.operationId);
    if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 32 || typeof value.goal !== 'string'
      || !value.goal.trim() || Buffer.byteLength(value.goal) > 16 * 1024 || this.#starting || this.#active) fail();
    for (const ref of value.sources) source(ref);
    if (new Set(value.sources.map(ref => JSON.stringify([ref.materialId, ref.revisionId]))).size !== value.sources.length) fail();
    const signal = this.signal(callerSignal); this.#starting = true;
    let handle: AgentHandle | undefined, lease: { commit(): void; dispose(): void } | undefined, runId: string | undefined;
    try {
      for (const ref of value.sources) await this.ctx.afosMainBusiness.readRevision(ref, signal);
      const run = await this.ctx.afosMainBusiness.authorize(value.sources, value.operationId, signal);
      runId = run.runId;
      const sessionId = SessionId(randomUUID());
      handle = await this.ctx.agents.create({ sessionId, meta: { agentPreset: 'afos-fixed' }, signal,
        agentOptions: { provider: this.#policy.provider, model: this.#policy.model, maxTokens: this.#policy.maxTokens },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, 'afos-fixed');
          agentCtx.tools.restrict({ allow: [...ENTERPRISE_TOOL_NAMES] });
          const skills = agentCtx.get('skills'), systemPrompt = agentCtx.get('systemPrompt');
          if (!skills || !systemPrompt) fail();
          const skill = await skills.get('afos-material-draft', { scope: scopeOf(agentCtx), signal });
          if (!skill) fail();
          systemPrompt.section({ name: 'afos-fixed-skill', order: 10, text: renderSkillContent(skill), interpolate: false });
          const actor = await this.ctx.afosProfileAuthority.identity.resolve({ sessionId: String(sessionId) }, signal);
          await this.ctx.afosProfileAuthority.access.bindSession(actor, { sessionId: String(sessionId) }, signal);
          lease = await this.ctx.afosMainBusiness.prepareSessionBinding(run.runId, String(sessionId), signal);
          return { commit: () => { this.ctx.afosProfileAuthority.identity.assertCurrentActor(actor); signal.throwIfAborted(); lease!.commit(); } };
        } });
      this.#handles.set(String(sessionId), handle); this.#active = handle.agent;
      await this.ctx.afosMainBusiness.prepareDraft(String(sessionId), '', run.inputRefs, signal);
      signal.throwIfAborted();
      const draft = this.ctx.afosMainBusiness.drafts().find(item => item.sessionId === String(sessionId)); if (!draft) fail();
      const prompt = `${value.goal}\n\nAuthorized source references (material content must be read with the fixed tool):\n${JSON.stringify(run.inputRefs)}`;
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }));
      const current = handle, publication = lease!;
      const task = current.agent.whenIdle().then(() => undefined).finally(() => {
        if (this.#active === current.agent) this.#active = undefined;
        publication.dispose(); this.#tasks.delete(task);
      });
      this.#tasks.add(task); void task.catch(() => undefined);
      return draftView(draft);
    } catch (error) {
      if (handle) { handle.agent.cancel({ kind: 'hook', reason: 'afos-create-failed' }); await handle.dispose(); this.#handles.delete(String(handle.agent.id)); if (this.#active === handle.agent) this.#active = undefined; }
      lease?.dispose();
      if (runId) { try { this.ctx.afosMainBusiness.releaseRunAdmission(runId); } catch { /* Account cutoff already released its admission. */ } }
      throw error;
    } finally { this.#starting = false; }
  }
  /** The existing Connection owner dispatches this exact finite table. No arbitrary method invocation. */
  invoke = async (endpoint: string, payload: unknown, callerSignal: AbortSignal): Promise<ConnectionRpcHandlerResult> => {
    const signal = this.signal(callerSignal);
    try {
      signal.throwIfAborted(); if (Buffer.byteLength(JSON.stringify(payload) ?? '') > ENTERPRISE_DRAFT_MAX_BYTES * 6 + 16 * 1024) fail();
      let value: unknown;
      if (endpoint === 'afos/drafts/state') { exact(payload, []); value = await this.state(); }
      else if (endpoint === 'afos/drafts/materials') { exact(payload, []); value = await this.ctx.afosMainBusiness.materials(signal); }
      else if (endpoint === 'afos/drafts/snapshot') { exact(payload, ['ref']); source(payload.ref); value = await this.ctx.afosMainBusiness.readRevision(payload.ref, signal); }
      else if (endpoint === 'afos/drafts/start') value = await this.start(payload, signal);
      else if (endpoint === 'afos/drafts/edit') {
        exact(payload, ['draftId', 'content']); id(payload.draftId); this.own(payload.draftId);
        if (typeof payload.content !== 'string' || Buffer.byteLength(payload.content) > ENTERPRISE_DRAFT_MAX_BYTES) fail();
        value = draftView(this.ctx.afosMainBusiness.editDraft(payload.draftId, payload.content));
      } else if (endpoint === 'afos/drafts/cancel') {
        exact(payload, ['draftId']); id(payload.draftId); const draft = this.own(payload.draftId), handle = this.#handles.get(draft.sessionId);
        if (!handle || this.#active !== handle.agent) fail();
        this.ctx.afosMainBusiness.markCancellation(draft.sessionId, false); handle.agent.cancel({ kind: 'user' });
        await handle.agent.whenIdle(); signal.throwIfAborted(); this.ctx.afosMainBusiness.markCancellation(draft.sessionId, true);
        value = draftView(this.own(draft.draftId));
      } else if (endpoint === 'afos/drafts/archive') {
        exact(payload, ['draftId', 'expectedSha256']); id(payload.draftId); const draft = this.own(payload.draftId);
        if (typeof payload.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.expectedSha256) || payload.expectedSha256 !== draft.sha256) fail();
        if (!draft.content.trim() || draft.localExecution === 'running' || draft.localExecution === 'local_queued' || draft.localExecution === 'cancel_requested') fail();
        await this.ctx.afosMainBusiness.archiveFromUser(draft.draftId, payload.expectedSha256, signal); value = draftView(this.own(draft.draftId));
      } else fail();
      signal.throwIfAborted(); return { ok: true, value };
    } catch (error) {
      const code = signal.aborted ? 'afos/profile-cancelled' : error instanceof EnterpriseProfileError ? error.code : 'afos/drafts-operation-failed';
      return { ok: false, error: { code, message: 'AFOS enterprise operation was refused.', details: {} } };
    }
  };
}
export default EnterpriseDraftRuntime;
