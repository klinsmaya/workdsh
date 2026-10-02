import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { LlmError, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelAuthorityLease, ModelPolicy, ModelRunRef, ModelStreamRequest, ModelUsageLedger, ModelUsageSettlement } from './contracts.js'
import { identity, modelError, safeModelError, validateModelRequest } from './contracts.js'
import { abortable, usageTokens, validateModelChunk } from './stream.js'

export interface FixedModelGatewayConfig extends ModelPolicy {
  /** Explicit managed server config; omitted/false does not grant model execution. */
  readonly enabled?: boolean
  /** Trusted server configuration, never a client-controlled field. Messages API base URL. */
  readonly vendorEndpoint: string
  readonly contextWindow: number
  readonly budgetLimitTokens: number
  readonly streamTimeoutMs?: number
}
export interface FixedModelGatewayDependencies {
  readonly authorize: (run: ModelRunRef, signal: AbortSignal) => Promise<ModelAuthorityLease>
  readonly ledger: ModelUsageLedger
  /** Kept in the server closure; never exported in a wire response or adapter configuration DTO. */
  readonly resolveVendorKey: () => Promise<string>
}
function endpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw modelError('INVALID_MODEL_POLICY') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.port && url.port !== '443' || isIP(url.hostname) || url.hostname.includes(':')
    || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|invalid)$/.test(url.hostname)) throw modelError('INVALID_MODEL_POLICY')
  return url.href.replace(/\/$/, '')
}
function messages(input: ModelStreamRequest, policy: ModelPolicy): RequestMessage[] {
  return input.request.messages.map((wire, index): RequestMessage => {
    const base = { id: MessageId(String(wire.id ?? `afos-${input.callId}-${index}`)), content: wire.content as never }
    switch (wire.role) {
      case 'assistant': return { ...base, role: 'assistant', source: { kind: 'model', provider: policy.provider, model: policy.model } }
      case 'system': return { ...base, role: 'system', source: { kind: 'system-prompt' } }
      case 'tool': return { ...base, role: 'tool', source: { kind: 'tool', callId: ToolCallId(String(wire.toolCallId)) }, toolCallId: ToolCallId(String(wire.toolCallId)), ...wire.isError === undefined ? {} : { isError: wire.isError as boolean } }
      default: return { ...base, role: 'user', source: { kind: 'user' as const } }
    }
  })
}

/** Thin fixed provider gateway: vendor wire translation and cancellation stay in the official DeepSeekAdapter. */
export class FixedModelGateway {
  private readonly config: FixedModelGatewayConfig
  private readonly userId = randomUUID() as ReturnType<DeepSeekAdapterOptions['resolveUserId']>
  constructor(config: FixedModelGatewayConfig, private readonly dependencies: FixedModelGatewayDependencies) {
    const vendorEndpoint = endpoint(config.vendorEndpoint)
    identity(config.provider); identity(config.model)
    if (![config.maxTokens, config.contextWindow, config.budgetLimitTokens].every(value => Number.isSafeInteger(value) && value > 0)
      || config.maxTokens > config.contextWindow
      || config.contextWindow + config.maxTokens > config.budgetLimitTokens
      || !Number.isSafeInteger(config.contextWindow + config.maxTokens)
      || config.maxRequestBytes !== undefined && (!Number.isSafeInteger(config.maxRequestBytes) || config.maxRequestBytes < 1 || config.maxRequestBytes > 1048576)
      || config.streamTimeoutMs !== undefined && (!Number.isSafeInteger(config.streamTimeoutMs) || config.streamTimeoutMs < 1 || config.streamTimeoutMs > 300000)) throw modelError('INVALID_MODEL_POLICY')
    this.config = Object.freeze({ ...config, vendorEndpoint })
  }
  async* stream(raw: ModelStreamRequest, callerSignal: AbortSignal): AsyncGenerator<StreamChunk> {
    if (this.config.enabled !== true) throw modelError('MODEL_EXECUTION_DISABLED')
    const input = validateModelRequest(raw, this.config)
    const controller = new AbortController()
    let signal = AbortSignal.any([callerSignal, controller.signal])
    const timeout = setTimeout(() => controller.abort(), this.config.streamTimeoutMs ?? 300000)
    timeout.unref()
    let initial: ModelAuthorityLease | undefined; let usage: TokenUsage | undefined
    const reservation: { state: 'none' | 'pending' | 'owned' | 'settled' } = { state: 'none' }
    let reservePromise: Promise<void> | undefined; let settlementPromise: Promise<void> | undefined
    let expiryTimer: ReturnType<typeof setTimeout> | undefined; let currentTools: readonly string[] = []
    const leaseSignals = new Map<AbortSignal, () => void>()
    let outcome: ModelUsageSettlement['outcome'] = 'unknown'; let finished = false; let usageSeen = false
    let iterator: AsyncIterator<StreamChunk> | undefined
    const check = async () => {
      const lease = await abortable(() => this.dependencies.authorize(input.run, signal), signal)
      signal.throwIfAborted()
      if (typeof lease.scopeKey !== 'string' || lease.scopeKey.length < 1 || lease.scopeKey.length > 2048
        || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= Date.now()
        || !(lease.signal instanceof AbortSignal) || lease.signal.aborted
        || !Array.isArray(lease.allowedTools) || lease.allowedTools.some(name => typeof name !== 'string')
        || initial !== undefined && initial.scopeKey !== lease.scopeKey) throw modelError('MODEL_AUTHORIZATION_DENIED')
      const allowed = new Set(lease.allowedTools)
      if (input.request.tools?.some(tool => !allowed.has(tool.name))
        || input.request.messages.some(message => (message.content as Record<string, unknown>[]).some(block => block.type === 'tool-call' && !allowed.has(String(block.name))))) throw modelError('MODEL_TOOL_DENIED')
      if (initial === undefined) {
        initial = lease
      }
      // Every refreshed lease can revoke the stable signal already held by the vendor fetch.
      if (!leaseSignals.has(lease.signal)) {
        const revoke = () => controller.abort()
        leaseSignals.set(lease.signal, revoke); lease.signal.addEventListener('abort', revoke, { once: true })
        if (lease.signal.aborted) revoke()
      }
      signal.throwIfAborted()
      currentTools = lease.allowedTools
      if (expiryTimer !== undefined) clearTimeout(expiryTimer)
      expiryTimer = setTimeout(() => controller.abort(), Math.min(lease.expiresAt - Date.now(), 2147483647))
      expiryTimer.unref()
      return lease
    }
    const settleOnce = async (settlement: ModelUsageSettlement, waitSignal: AbortSignal) => {
      if (settlementPromise === undefined) {
        // A late completion remains authoritative. Cancellation never blindly sends a second settlement.
        settlementPromise = Promise.resolve().then(() => this.dependencies.ledger.settle(settlement, AbortSignal.timeout(3000)))
          .then(() => { reservation.state = 'settled' })
      }
      try { await abortable(settlementPromise, waitSignal) }
      catch { throw modelError('MODEL_LEDGER_UNAVAILABLE') }
    }
    const settlement = (): ModelUsageSettlement => ({ scopeKey: initial!.scopeKey, callId: input.callId, outcome,
      usage: usage === undefined ? { status: 'unknown' } : { status: 'known', source: 'provider', tokens: usage }, cost: { status: 'unknown' } })
    try {
      await check()
      const rawKey = await abortable(() => this.dependencies.resolveVendorKey(), signal)
      // Do not log or pass credential validation errors that can expose content.
      if (typeof rawKey !== 'string' || rawKey.length < 1 || rawKey.length > 4096 || /[^\x21-\x7e]/.test(rawKey)) throw modelError('MODEL_CREDENTIAL_UNAVAILABLE')
      await check()
      const lease = initial!
      reservation.state = 'pending'
      reservePromise = Promise.resolve().then(() => this.dependencies.ledger.reserve({ scopeKey: lease.scopeKey, callId: input.callId, run: input.run,
        reservedTokens: this.config.contextWindow + input.request.maxTokens, limitTokens: this.config.budgetLimitTokens }, signal))
        .then(() => { reservation.state = 'owned' })
      await abortable(reservePromise, AbortSignal.any([signal, AbortSignal.timeout(3000)]))
      await check()
      const connection = resolveAdapterOptions({ baseURL: this.config.vendorEndpoint, thinking: 'disabled', reasoningEffort: 'off',
        maxTokens: this.config.maxTokens, defaultContextWindow: this.config.contextWindow,
        models: [{ id: this.config.model, inputModalities: ['text'], contextWindow: this.config.contextWindow, maxTokens: this.config.maxTokens }],
        streamIdleTimeoutMs: Math.min(this.config.streamTimeoutMs ?? 300000, 300000),
      })
      const adapter = new DeepSeekAdapter({ options: () => connection,
        resolveAuth: async () => { await check(); return { headers: { 'x-api-key': rawKey } } },
        resolveUserId: () => this.userId,
        // No optional API extensions, raw Session logs, local attachment access, or Files API capabilities.
        prepareExtensions: async () => { await check(); return { fields: {}, accept: async () => {} } },
      })
      const options: GenerateOptions = { provider: this.config.provider, model: this.config.model,
        messages: messages(input, this.config), maxTokens: input.request.maxTokens, signal,
        ...input.request.system === undefined ? {} : { system: input.request.system },
        ...input.request.tools === undefined ? {} : { tools: [...input.request.tools] },
        ...input.request.temperature === undefined ? {} : { temperature: input.request.temperature },
        ...input.request.stop === undefined ? {} : { stop: [...input.request.stop] },
        ...input.request.purpose === undefined ? {} : { purpose: input.request.purpose },
      }
      iterator = adapter.stream(options)[Symbol.asyncIterator]()
      while (true) {
        const result = await abortable(() => iterator!.next(), signal)
        if (result.done) break
        await check()
        const chunk = validateModelChunk(result.value)
        if (finished || usageSeen && chunk.type !== 'finish') throw modelError('MALFORMED_MODEL_STREAM')
        const declaredTools = input.request.tools?.map(tool => tool.name) ?? []
        if (chunk.type === 'tool-call-delta' && chunk.name !== undefined && (!currentTools.includes(chunk.name) || !declaredTools.includes(chunk.name))
          || chunk.type === 'block-end' && chunk.block.type === 'tool-call' && (!currentTools.includes(chunk.block.name) || !declaredTools.includes(chunk.block.name))) throw modelError('MODEL_TOOL_DENIED')
        if (chunk.type === 'usage') {
          usageSeen = true
          // The pinned official adapter initializes absent provider counters to zero. A zero cannot prove
          // that the vendor supplied it. Preserve unknown rather than invent an authoritative zero bill.
          if (chunk.usage.inputTokens > 0 && chunk.usage.outputTokens > 0) usage = chunk.usage
          else continue
        }
        if (chunk.type === 'finish') {
          finished = true
          outcome = chunk.reason.kind === 'error' ? 'failed' : chunk.reason.kind === 'aborted' ? 'aborted' : 'completed'
          // Server settlement must be durable before a successful terminal chunk is exposed.
          await settleOnce(settlement(), AbortSignal.any([signal, AbortSignal.timeout(3000)]))
        }
        signal.throwIfAborted()
        yield chunk
      }
      if (!finished) throw modelError('MODEL_STREAM_TRUNCATED')
    } catch (error) {
      outcome = signal.aborted ? 'aborted' : 'failed'
      if (signal.aborted) throw modelError('ABORTED')
      // Raw vendor details, causes, prompt text, and key fragments never leave this server boundary.
      throw safeModelError(error, 'MODEL_PROVIDER_ERROR')
    } finally {
      clearTimeout(timeout); if (expiryTimer !== undefined) clearTimeout(expiryTimer); controller.abort()
      for (const [leaseSignal, revoke] of leaseSignals) leaseSignal.removeEventListener('abort', revoke)
      if (iterator?.return !== undefined) void Promise.resolve(iterator.return()).catch(() => {})
      if (initial !== undefined && reservation.state !== 'none' && reservation.state !== 'settled') {
        if (reservation.state === 'pending' && reservePromise !== undefined) {
          // The ledger may ignore cancellation and complete its atomic reserve later. Keep ownership
          // of that promise and reconcile it as unknown without dispatching a vendor request.
          void reservePromise.then(() => settleOnce(settlement(), AbortSignal.timeout(3000))).catch(() => {})
        } else if (settlementPromise === undefined) {
          try { await settleOnce(settlement(), AbortSignal.timeout(3000)) }
          catch { /* Reservation remains charged as unknown; never leak a ledger error body. */ }
        }
      }
    }
  }
}

/** Deterministic offline ledger fixture. This is not a durable NocoBase billing store. */
export class InMemoryModelUsageLedger implements ModelUsageLedger {
  readonly deployment = 'offline-fixture-only' as const
  private readonly entries = new Map<string, { reservation: import('./contracts.js').ModelReservation; settlement?: ModelUsageSettlement }>()
  async reserve(reservation: import('./contracts.js').ModelReservation, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const key = JSON.stringify([reservation.scopeKey, reservation.callId])
    if (this.entries.has(key)) throw modelError('MODEL_CALL_ALREADY_USED')
    let consumed = 0
    for (const entry of this.entries.values()) {
      if (entry.reservation.scopeKey !== reservation.scopeKey) continue
      consumed += entry.settlement?.usage.status === 'known' ? usageTokens(entry.settlement.usage.tokens) : entry.reservation.reservedTokens
    }
    if (consumed + reservation.reservedTokens > reservation.limitTokens) throw modelError('MODEL_BUDGET_EXCEEDED')
    this.entries.set(key, { reservation: structuredClone(reservation) })
  }
  async settle(settlement: ModelUsageSettlement): Promise<void> {
    const key = JSON.stringify([settlement.scopeKey, settlement.callId]); const entry = this.entries.get(key)
    if (entry === undefined) throw modelError('MODEL_RESERVATION_MISSING')
    if (entry.settlement !== undefined) {
      if (JSON.stringify(entry.settlement) === JSON.stringify(settlement)) return
      throw modelError('MODEL_SETTLEMENT_ALREADY_USED')
    }
    entry.settlement = structuredClone(settlement)
  }
  snapshot(): readonly { reservation: import('./contracts.js').ModelReservation; settlement?: ModelUsageSettlement }[] {
    return structuredClone([...this.entries.values()])
  }
}
