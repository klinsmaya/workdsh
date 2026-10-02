import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

export interface ModelRunRef { readonly runId: string; readonly attempt: number }
export interface ModelRequestContent {
  readonly messages: readonly Record<string, unknown>[]
  readonly system?: string
  readonly tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[]
  readonly maxTokens: number
  readonly temperature?: number
  readonly stop?: readonly string[]
  readonly purpose?: 'compaction' | 'session-title'
}
export interface ModelStreamRequest {
  readonly contractVersion: 'afos.model.v1'
  readonly run: ModelRunRef
  readonly callId: string
  readonly request: ModelRequestContent
}
export interface ModelTransport {
  stream(request: ModelStreamRequest, signal: AbortSignal): AsyncIterable<StreamChunk>
}
export interface ModelPolicy {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly maxRequestBytes?: number
}
/** This evidence is made by current server ACL/run validation, never by the wire request. */
export interface ModelAuthorityLease {
  readonly scopeKey: string
  readonly allowedTools: readonly string[]
  readonly expiresAt: number
  readonly signal: AbortSignal
}
export interface ModelReservation {
  readonly scopeKey: string; readonly callId: string; readonly run: ModelRunRef
  readonly reservedTokens: number; readonly limitTokens: number
}
export interface ModelUsageSettlement {
  readonly scopeKey: string; readonly callId: string
  readonly outcome: 'completed' | 'aborted' | 'failed' | 'unknown'
  readonly usage: { readonly status: 'known'; readonly source: 'provider'; readonly tokens: TokenUsage } | { readonly status: 'unknown' }
  /** No provider billing price was configured or verified in this P1 module. */
  readonly cost: { readonly status: 'unknown' }
}
/** Implement reserve and settle as atomic durable server transactions in the mounted gateway. */
export interface ModelUsageLedger {
  reserve(reservation: ModelReservation, signal?: AbortSignal): Promise<void>
  /** Identical retry is idempotent; conflicting settlements must be refused. */
  settle(settlement: ModelUsageSettlement, signal?: AbortSignal): Promise<void>
}

export function modelError(code: string): LlmError {
  return new LlmError(`AFOS model call refused (${code})`, code)
}
const safeCodes = new Set([
  'INVALID_MODEL_REQUEST', 'MODEL_CONTRACT_MISMATCH', 'UNSUPPORTED_MODEL_CONTENT', 'MODEL_REQUEST_TOO_LARGE',
  'MODEL_ROUTE_DENIED', 'INVALID_MODEL_POLICY', 'MALFORMED_MODEL_STREAM', 'MODEL_STREAM_TOO_LARGE',
  'ABORTED', 'MODEL_STREAM_TRUNCATED', 'MODEL_TRANSPORT_ERROR', 'MODEL_EXECUTION_DISABLED',
  'MODEL_AUTHORIZATION_DENIED', 'MODEL_TOOL_DENIED', 'MODEL_CREDENTIAL_UNAVAILABLE', 'MODEL_LEDGER_UNAVAILABLE',
  'MODEL_PROVIDER_ERROR', 'MODEL_CALL_ALREADY_USED', 'MODEL_BUDGET_EXCEEDED', 'MODEL_RESERVATION_MISSING',
  'MODEL_SETTLEMENT_ALREADY_USED', 'MODEL_STREAM_TIMEOUT',
])
/** Imported transport/provider errors are evidence of failure, never trusted display text or causes. */
export function safeModelError(error: unknown, fallback = 'MODEL_TRANSPORT_ERROR'): LlmError {
  return modelError(error instanceof LlmError && safeCodes.has(error.code) ? error.code : fallback)
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw modelError('INVALID_MODEL_REQUEST')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw modelError('INVALID_MODEL_REQUEST')
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw modelError('INVALID_MODEL_REQUEST')
}
export function text(value: unknown, max = 262144): string {
  if (typeof value !== 'string' || value.length > max) throw modelError('INVALID_MODEL_REQUEST')
  return value
}
export function identity(value: unknown): string {
  const v = text(value, 256)
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(v)) throw modelError('INVALID_MODEL_REQUEST')
  return v
}
function jsonObject(value: unknown): Record<string, unknown> {
  const object = record(value)
  const encoded = JSON.stringify(object, (key, current: unknown) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)
      || typeof current === 'function' || typeof current === 'bigint'
      || (typeof current === 'number' && !Number.isFinite(current))) throw modelError('INVALID_MODEL_REQUEST')
    return current
  })
  return JSON.parse(encoded) as Record<string, unknown>
}
function message(value: unknown): Record<string, unknown> {
  const input = record(value)
  keys(input, ['role', 'id', 'content', 'toolCallId', 'isError'])
  if (typeof input.role !== 'string' || !['user', 'assistant', 'system', 'tool'].includes(input.role)) throw modelError('UNSUPPORTED_MODEL_CONTENT')
  if (!Array.isArray(input.content) || input.content.length > 256) throw modelError('INVALID_MODEL_REQUEST')
  const content = input.content.map(value => {
    const block = record(value)
    if (block.type === 'text' || block.type === 'reasoning') {
      keys(block, ['type', 'text'])
      if (block.type === 'reasoning' && input.role !== 'assistant') throw modelError('UNSUPPORTED_MODEL_CONTENT')
      return { type: block.type, text: text(block.text) }
    }
    if (block.type === 'tool-call' && input.role === 'assistant') {
      keys(block, ['type', 'id', 'name', 'arguments'])
      return { type: 'tool-call', id: identity(block.id), name: identity(block.name), arguments: text(block.arguments) }
    }
    // Images, file paths, provider replay, and plugin-defined content are deliberately unsupported.
    throw modelError('UNSUPPORTED_MODEL_CONTENT')
  })
  const output: Record<string, unknown> = { role: input.role, content }
  if (input.id !== undefined) output.id = identity(input.id)
  if (input.role === 'tool') {
    output.toolCallId = identity(input.toolCallId)
    if (input.isError !== undefined) {
      if (typeof input.isError !== 'boolean') throw modelError('INVALID_MODEL_REQUEST')
      output.isError = input.isError
    }
  } else if (input.toolCallId !== undefined || input.isError !== undefined) throw modelError('INVALID_MODEL_REQUEST')
  return output
}
/** Strict canonical wire schema. No URL, endpoint, credential, chosen route, or client usage is accepted. */
export function validateModelRequest(value: unknown, policy: ModelPolicy): ModelStreamRequest {
  const input = record(value)
  keys(input, ['contractVersion', 'run', 'callId', 'request'])
  if (input.contractVersion !== 'afos.model.v1') throw modelError('MODEL_CONTRACT_MISMATCH')
  const run = record(input.run); keys(run, ['runId', 'attempt'])
  if (!Number.isSafeInteger(run.attempt) || Number(run.attempt) < 1) throw modelError('INVALID_MODEL_REQUEST')
  const request = record(input.request)
  keys(request, ['messages', 'system', 'tools', 'maxTokens', 'temperature', 'stop', 'purpose'])
  if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 512
    || !Number.isSafeInteger(request.maxTokens) || Number(request.maxTokens) < 1
    || Number(request.maxTokens) > policy.maxTokens) throw modelError('INVALID_MODEL_REQUEST')
  const messages = request.messages.map(message)
  const parsed: { messages: Record<string, unknown>[]; maxTokens: number; system?: string; tools?: { name: string; description: string; parameters: Record<string, unknown> }[]; temperature?: number; stop?: string[]; purpose?: 'compaction' | 'session-title' } = { messages, maxTokens: Number(request.maxTokens) }
  if (request.system !== undefined) parsed.system = text(request.system)
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > 64) throw modelError('INVALID_MODEL_REQUEST')
    parsed.tools = request.tools.map(value => {
      const tool = record(value); keys(tool, ['name', 'description', 'parameters'])
      return { name: identity(tool.name), description: text(tool.description, 8192), parameters: jsonObject(tool.parameters) }
    })
    if (new Set(parsed.tools.map(tool => tool.name)).size !== parsed.tools.length) throw modelError('INVALID_MODEL_REQUEST')
  }
  if (request.temperature !== undefined) {
    if (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) throw modelError('INVALID_MODEL_REQUEST')
    parsed.temperature = request.temperature
  }
  if (request.stop !== undefined) {
    if (!Array.isArray(request.stop) || request.stop.length > 4) throw modelError('INVALID_MODEL_REQUEST')
    parsed.stop = request.stop.map(value => text(value, 256))
  }
  if (request.purpose !== undefined) {
    if (request.purpose !== 'compaction' && request.purpose !== 'session-title') throw modelError('INVALID_MODEL_REQUEST')
    parsed.purpose = request.purpose
  }
  const output: ModelStreamRequest = { contractVersion: 'afos.model.v1', run: { runId: identity(run.runId), attempt: Number(run.attempt) }, callId: identity(input.callId), request: parsed }
  if (Buffer.byteLength(JSON.stringify(output)) > (policy.maxRequestBytes ?? 1048576)) throw modelError('MODEL_REQUEST_TOO_LARGE')
  return output
}
/** Strip non-wire Session metadata and provider-private replay before checking the closed contract. */
export function serializeModelRequest(options: GenerateOptions, run: ModelRunRef, callId: string, policy: ModelPolicy): ModelStreamRequest {
  if (options.provider !== policy.provider || options.model !== policy.model) throw modelError('MODEL_ROUTE_DENIED')
  if (options.reasoningEffort !== undefined || options.toolHistory !== undefined) throw modelError('UNSUPPORTED_MODEL_CONTENT')
  const request = {
    messages: options.messages.map(input => ({ role: input.role, content: input.content,
      ...input.id === undefined ? {} : { id: input.id },
      ...input.role === 'tool' ? { toolCallId: input.toolCallId, ...input.isError === undefined ? {} : { isError: input.isError } } : {},
    })), maxTokens: options.maxTokens ?? policy.maxTokens,
    ...options.system === undefined ? {} : { system: options.system },
    ...options.tools === undefined ? {} : { tools: options.tools.map(tool => {
      if (tool.deferLoading !== undefined) throw modelError('UNSUPPORTED_MODEL_CONTENT')
      return { name: tool.name, description: tool.description, parameters: tool.parameters }
    }) },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...options.purpose === undefined ? {} : { purpose: options.purpose },
  }
  return validateModelRequest({ contractVersion: 'afos.model.v1', run, callId, request }, policy)
}
