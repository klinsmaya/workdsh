import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { identity, keys, modelError, record, safeModelError, text } from './contracts.js'

export function validateUsage(value: unknown): TokenUsage {
  const input = record(value)
  keys(input, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'])
  const output: Record<string, number> = {}
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const count = input[field]
    if (count === undefined && field !== 'inputTokens' && field !== 'outputTokens') continue
    if (!Number.isSafeInteger(count) || Number(count) < 0) throw modelError('MALFORMED_MODEL_STREAM')
    output[field] = Number(count)
  }
  const sum = (output.inputTokens ?? 0) + (output.outputTokens ?? 0) + (output.cacheReadTokens ?? 0) + (output.cacheWriteTokens ?? 0)
  if (!Number.isSafeInteger(sum) || (output.totalTokens !== undefined && output.totalTokens !== sum)
    || (output.reasoningTokens !== undefined && output.reasoningTokens > (output.outputTokens ?? 0))) throw modelError('MALFORMED_MODEL_STREAM')
  return output as unknown as TokenUsage
}
export function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}
/** Drop opaque vendor replay and vendor error bodies. Only the official public chunk vocabulary crosses IPC/SSE. */
export function validateModelChunk(value: unknown): StreamChunk {
  const input = record(value)
  const index = () => {
    if (!Number.isSafeInteger(input.index) || Number(input.index) < 0 || Number(input.index) > 4095) throw modelError('MALFORMED_MODEL_STREAM')
    return Number(input.index)
  }
  if (input.type === 'text-delta' || input.type === 'reasoning-delta') {
    keys(input, ['type', 'index', 'text']); return { type: input.type, index: index(), text: text(input.text, 32768) }
  }
  if (input.type === 'block-start') {
    keys(input, ['type', 'index', 'blockType'])
    if (typeof input.blockType !== 'string' || !['text', 'reasoning', 'tool-call'].includes(input.blockType)) throw modelError('UNSUPPORTED_MODEL_CONTENT')
    return { type: 'block-start', index: index(), blockType: input.blockType as 'text' | 'reasoning' | 'tool-call' }
  }
  if (input.type === 'tool-call-delta') {
    keys(input, ['type', 'index', 'id', 'name', 'argumentsDelta'])
    return { type: 'tool-call-delta', index: index(), id: ToolCallId(identity(input.id)), argumentsDelta: text(input.argumentsDelta, 32768),
      ...input.name === undefined ? {} : { name: identity(input.name) } }
  }
  if (input.type === 'block-end') {
    keys(input, ['type', 'index', 'block'])
    const block = record(input.block)
    if (block.type === 'text' || block.type === 'reasoning') {
      keys(block, ['type', 'text'])
      return { type: 'block-end', index: index(), block: { type: block.type, text: text(block.text, 32768) } }
    }
    if (block.type === 'tool-call') {
      keys(block, ['type', 'id', 'name', 'arguments'])
      return { type: 'block-end', index: index(), block: { type: 'tool-call', id: ToolCallId(identity(block.id)), name: identity(block.name), arguments: text(block.arguments, 32768) } }
    }
    throw modelError('UNSUPPORTED_MODEL_CONTENT')
  }
  if (input.type === 'usage') {
    keys(input, ['type', 'usage']); return { type: 'usage', usage: validateUsage(input.usage) }
  }
  if (input.type === 'finish') {
    keys(input, ['type', 'reason', 'replayState'])
    const reason = record(input.reason)
    if (reason.kind === 'stop' || reason.kind === 'tool-calls' || reason.kind === 'max-tokens') {
      keys(reason, ['kind']); return { type: 'finish', reason: { kind: reason.kind } }
    }
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      keys(reason, ['kind', 'failure'])
      // The upstream error may contain vendor text or an echoed request. It is deliberately not forwarded.
      return { type: 'finish', reason: { kind: reason.kind, failure: { code: reason.kind === 'aborted' ? 'ABORTED' : 'MODEL_PROVIDER_ERROR', message: reason.kind === 'aborted' ? 'AFOS model call aborted' : 'AFOS model provider failed' } } }
    }
  }
  throw modelError('MALFORMED_MODEL_STREAM')
}
export function encodeModelSse(chunk: StreamChunk): string {
  const frame = `event: chunk\ndata: ${JSON.stringify({ contractVersion: 'afos.model.v1', chunk: validateModelChunk(chunk) })}\n\n`
  if (Buffer.byteLength(frame) > 65536) throw modelError('MODEL_STREAM_TOO_LARGE')
  return frame
}

/** Cancellation also settles when a faulty fixture/transport ignores its signal. */
export async function abortable<T>(operation: Promise<T> | (() => Promise<T>), signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Existing promises may already own an effect; consume a late rejection. Thunks do not start.
    if (typeof operation !== 'function') void operation.catch(() => {})
    throw modelError('ABORTED')
  }
  const promise = typeof operation === 'function' ? Promise.resolve().then(() => {
    if (signal.aborted) throw modelError('ABORTED')
    return operation()
  }) : operation
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(modelError('ABORTED')) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })])
  } finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort) }
}

export async function* decodeModelSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''; let received = 0; let finished = false; let usageSeen = false
  try {
    while (true) {
      const result = await abortable(() => reader.read(), signal)
      if (result.done) { buffer += decoder.decode(); break }
      received += result.value.byteLength
      if (received > 16777216) throw modelError('MODEL_STREAM_TOO_LARGE')
      buffer += decoder.decode(result.value, { stream: true })
      // Normalise complete CRLF pairs; a trailing CR stays buffered until its next byte arrives.
      buffer = buffer.replace(/\r\n/g, '\n')
      let separator: number
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, separator); buffer = buffer.slice(separator + 2)
        if (Buffer.byteLength(frame) > 65536) throw modelError('MODEL_STREAM_TOO_LARGE')
        const lines = frame.split('\n').filter(line => !line.startsWith(':'))
        if (lines.length === 0 || lines.every(line => line.length === 0)) continue
        if (finished || lines.length !== 2 || lines[0] !== 'event: chunk' || !lines[1]?.startsWith('data: ')) throw modelError('MALFORMED_MODEL_STREAM')
        let parsed: unknown
        try { parsed = JSON.parse(lines[1].slice(6)) } catch { throw modelError('MALFORMED_MODEL_STREAM') }
        const envelope = record(parsed); keys(envelope, ['contractVersion', 'chunk'])
        if (envelope.contractVersion !== 'afos.model.v1') throw modelError('MODEL_CONTRACT_MISMATCH')
        const chunk = validateModelChunk(envelope.chunk)
        if (usageSeen && chunk.type !== 'finish') throw modelError('MALFORMED_MODEL_STREAM')
        if (chunk.type === 'usage') {
          if (usageSeen) throw modelError('MALFORMED_MODEL_STREAM')
          usageSeen = true
        }
        if (chunk.type === 'finish') finished = true
        yield chunk
      }
      if (Buffer.byteLength(buffer) > 65536) throw modelError('MODEL_STREAM_TOO_LARGE')
    }
    if (!finished || buffer.trim().length > 0) throw modelError('MODEL_STREAM_TRUNCATED')
  } catch (error) {
    if (signal.aborted) throw modelError('ABORTED')
      throw safeModelError(error, 'MALFORMED_MODEL_STREAM')
  } finally {
    // Do not await an uncooperative cancellation handler; the bounded read already settled.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
