import { describe, expect, it } from 'vitest'
import { redactRuntimeLog, RuntimeLogFilter, safeExternalUrl } from '../src/runtime-security.ts'

describe('runtime secret assignments', () => {
  it('redacts plain verifier, api key and password assignments', () => {
    const input = 'verifier=AFOS_FAKE_VERIFY api_key=AFOS_FAKE_API password=AFOS_FAKE_PASSWORD\n'
    const result = redactRuntimeLog(input)
    expect(result).not.toMatch(/AFOS_FAKE_/u)
    expect(result).toContain('verifier=[REDACTED]')
  })

  it('redacts quoted assignments with escaped delimiters and incomplete quotes', () => {
    for (const input of ['verifier="AFOS_FAKE_QUOTED"', "api_key='AFOS_FAKE_QUOTED'", 'password="prefix\\"AFOS_FAKE_TAIL"', 'verifier="AFOS_FAKE_UNCLOSED']) {
      expect(redactRuntimeLog(input)).not.toMatch(/AFOS_FAKE_/u)
    }
  })

  it('redacts escaped JSON quote values while preserving valid JSON and public fields', () => {
    const input = JSON.stringify({ verifier: 'prefix"AFOS_FAKE_TAIL', cookie: 'session="AFOS_FAKE_COOKIE"', label: 'public fixture' })
    const result = redactRuntimeLog(input)
    expect(result).not.toMatch(/AFOS_FAKE_/u)
    expect(JSON.parse(result)).toEqual({ verifier: '[REDACTED]', cookie: '[REDACTED]', label: 'public fixture' })
  })

  it('redacts secret tails with terminal escapes or unfinished JSON at EOF', () => {
    for (const input of ['password="AFOS_FAKE_TAIL\\', '{"verifier":"AFOS_FAKE_UNCLOSED', '{"cookie":"AFOS_FAKE_COOKIE\\']) {
      let output = ''
      const filter = new RuntimeLogFilter(text => { output += text })
      filter.consume(input)
      filter.flush()
      expect(output).not.toMatch(/AFOS_FAKE_/u)
    }
  })

  it('omits the whole plain cookie assignment including multiple cookie values', () => {
    const input = 'cookie=session=AFOS_FAKE_SESSION; second=AFOS_FAKE_SECOND; Path=/\nnext line\n'
    const result = redactRuntimeLog(input)
    expect(result).not.toMatch(/AFOS_FAKE_/u)
    expect(result).toContain('next line\n')
  })

  it('redacts JSON verifier and cookie values without changing ordinary fields', () => {
    const input = '{"verifier":"AFOS_FAKE_VERIFY","cookie":"session=AFOS_FAKE_COOKIE","message":"ready"}\n'
    const result = redactRuntimeLog(input)
    expect(result).not.toMatch(/AFOS_FAKE_/u)
    expect(JSON.parse(result)).toEqual({ verifier: '[REDACTED]', cookie: '[REDACTED]', message: 'ready' })
  })

  it('filters assignments split across chunk and final flush boundaries', () => {
    let result = ''
    const filter = new RuntimeLogFilter(text => { result += text })
    filter.consume('veri')
    filter.consume('fier=AFOS_FAKE_VERIFY\ncook')
    filter.consume('ie=session=AFOS_FAKE_COOKIE; second=AFOS_FAKE_SECOND')
    filter.flush()
    expect(result).not.toMatch(/AFOS_FAKE_/u)
    expect(result).toContain('verifier=[REDACTED]')
    expect(result).toContain('[REDACTED COOKIE]')
  })

  it('refuses secret-bearing public external URLs for the additional assignment names', () => {
    for (const key of ['code_verifier', 'verifier', 'cookie', 'set-cookie', 'authorization', 'api_key', 'password']) {
      expect(safeExternalUrl(`https://example.com/help?${key}=AFOS_FAKE_VALUE`)).toBeUndefined()
    }
    expect(safeExternalUrl('https://example.com/help?topic=start')).toBe('https://example.com/help?topic=start')
  })
})
