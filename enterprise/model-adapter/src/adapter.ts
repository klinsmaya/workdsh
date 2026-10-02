import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { modelError, safeModelError, serializeModelRequest } from './contracts.js'
import type { ModelPolicy, ModelRunRef, ModelTransport } from './contracts.js'
import { abortable, validateModelChunk } from './stream.js'

export interface EnterpriseModelDependencies {
  readonly transport: ModelTransport
  readonly getRun: () => ModelRunRef
  /** Trusted current identity/run check; stale, revoked, or inactive state must refuse. */
  readonly assertCurrent: (run: ModelRunRef, signal: AbortSignal) => Promise<void>
}
/** Registered in the official DSH LLM runtime; no Agent loop, retry, route discovery, or raw HTTP is owned here. */
export class EnterpriseModelAdapter extends LlmAdapter {
  private readonly policy: ModelPolicy
  constructor(policy: ModelPolicy, private readonly dependencies: EnterpriseModelDependencies) {
    super()
    if (!policy.provider || !policy.model || !Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 1) throw modelError('INVALID_MODEL_POLICY')
    this.policy = Object.freeze({ ...policy })
  }
  override providerInfo(provider: string) { this.route(provider); return { id: provider, name: 'AFOS managed model' } }
  override listModels(provider: string) {
    this.route(provider)
    return Promise.resolve([{ provider, id: this.policy.model, name: this.policy.model, inputModalities: ['text'] as const }])
  }
  override resolveModel(provider: string, model: string, _signal?: AbortSignal) {
    this.route(provider, model)
    return Promise.resolve({ provider, id: model, name: model, defaultMaxTokens: this.policy.maxTokens, inputModalities: ['text'] as const })
  }
  private route(provider: string, model = this.policy.model): void {
    if (provider !== this.policy.provider || model !== this.policy.model) throw modelError('MODEL_ROUTE_DENIED')
  }
  async* stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.route(options.provider, options.model)
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    const run = Object.freeze({ ...this.dependencies.getRun() })
    const input = serializeModelRequest(options, run, randomUUID(), this.policy)
    let iterator: AsyncIterator<StreamChunk> | undefined; let finishSeen = false; let usageSeen = false
    try {
      await abortable(() => this.dependencies.assertCurrent(run, signal), signal)
      signal.throwIfAborted()
      iterator = this.dependencies.transport.stream(input, signal)[Symbol.asyncIterator]()
      while (true) {
        const item = await abortable(() => iterator!.next(), signal)
        if (item.done) break
        await abortable(() => this.dependencies.assertCurrent(run, signal), signal)
        signal.throwIfAborted()
        const chunk = validateModelChunk(item.value)
        if (finishSeen || (usageSeen && chunk.type !== 'finish')) throw modelError('MALFORMED_MODEL_STREAM')
        if (chunk.type === 'usage') usageSeen = true
        if (chunk.type === 'finish') finishSeen = true
        yield chunk
      }
      if (!finishSeen) throw modelError('MODEL_STREAM_TRUNCATED')
    } catch (error) {
      if (signal.aborted) throw modelError('ABORTED')
      throw safeModelError(error)
    } finally {
      consumer.abort()
      // Cancellation releases the consumer promptly even if an injected transport does not cooperate.
      if (iterator?.return !== undefined) void Promise.resolve(iterator.return()).catch(() => {})
    }
  }
}
