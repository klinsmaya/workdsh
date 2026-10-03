import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { isRuntimeDownload, isRuntimeNavigation, runtimeEnvironment, RuntimeLogFilter, safeExternalUrl, stopRuntimeTree } from '../src/runtime-security.ts'

describe('desktop runtime boundaries', () => {
  it('excludes credentials and Node injection while preserving platform essentials', () => {
    expect(runtimeEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/home/test', NODE_OPTIONS: '--inspect', OPENAI_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', DSH_TOKEN: 'secret' }))
      .toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/home/test' })
  })
  it('redacts credentials split across chunks and JSON/header values', () => {
    let output = ''
    const log = new RuntimeLogFilter(text => { output += text })
    log.consume('dsh web: http://127.0.0.1:1234/?tok')
    log.consume('en=secret-value\n{"refresh_token":"refresh-secret"}\nAuthorization: Bearer other-secret\n')
    log.flush()
    expect(output).not.toMatch(/secret-value|refresh-secret|other-secret/u)
    expect(output).toContain('[REDACTED]')
  })
  it('omits oversized logs rather than truncating a secret', () => {
    let output = ''
    const log = new RuntimeLogFilter(text => { output += text })
    log.consume('x'.repeat(17_000))
    log.consume('token=secret\nOK\n')
    expect(output).toBe('[oversized runtime log omitted]\nOK\n')
  })
  it('restricts navigation to the current runtime and external links to public HTTPS', () => {
    const runtime = 'http://127.0.0.1:3210/?token=local'
    expect(isRuntimeNavigation('http://127.0.0.1:3210/session', runtime)).toBe(true)
    for (const target of ['http://127.0.0.1:3211/', 'https://example.com/', 'file:///etc/passwd']) expect(isRuntimeNavigation(target, runtime)).toBe(false)
    expect(safeExternalUrl('https://example.com/docs')).toBe('https://example.com/docs')
    for (const target of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@example.com', 'https://host.local', 'https://example.com/?token=secret']) expect(safeExternalUrl(target)).toBeUndefined()
  })
  it('allows same-runtime file exports and blobs while rejecting other origins and local file URLs', () => {
    const runtime='http://127.0.0.1:3210/?token=local'
    for(const target of ['http://127.0.0.1:3210/output','blob:http://127.0.0.1:3210/uuid'])expect(isRuntimeDownload(target,runtime)).toBe(true)
    for(const target of ['file:///etc/passwd','data:text/html,code','http://127.0.0.1:3211/output','blob:https://example.com/uuid'])expect(isRuntimeDownload(target,runtime)).toBe(false)
  })
  it.skipIf(process.platform === 'win32')('waits for and terminates an uncooperative real process group', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>(resolve => child.stdout?.once('data', () => resolve()))
    await stopRuntimeTree(child, 30)
    expect(child.signalCode).toBe('SIGKILL')
  })
  it.skipIf(process.platform !== 'linux')('terminates a tracked real detached tool when its Host ignores shutdown', async () => {
    // Exercise separate real groups repeatedly: signal delivery must not be
    // mistaken for confirmed termination of a tracked detached descendant.
    for (let attempt = 0; attempt < 3; attempt++) {
      const script = "const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const tool=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)\"],{detached:true,stdio:['ignore','pipe','ignore']}); tool.stdout.once('data',b=>console.log(b.toString().trim())); setInterval(()=>{},1000)"
      const host = spawn(process.execPath,['-e',script],{detached:true,stdio:['ignore','pipe','ignore']})
      const toolPid = await new Promise<number>(resolve => host.stdout?.once('data',bytes => resolve(Number(bytes.toString().trim()))))
      try {
        await stopRuntimeTree(host,30)
        const {readFile} = await import('node:fs/promises')
        // A killed orphan may briefly remain as a zombie until init reaps it.
        let live=false
        try { live=!/\) Z /u.test(await readFile(`/proc/${toolPid}/stat`,'utf8')) } catch { /* reaped */ }
        expect(live).toBe(false)
      } finally {
        try { process.kill(-toolPid,'SIGKILL') } catch { /* already stopped */ }
        if (host.exitCode === null && host.signalCode === null) { try { process.kill(-host.pid!,'SIGKILL') } catch { /* already stopped */ } }
      }
    }
  })
})
