import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const proc = vi.hoisted(() => ({ started: '100', reads: 0 }))
vi.mock('node:fs/promises', () => ({
  readdir: async () => ['4242'],
  readFile: async () => {
    proc.reads++
    const fields = ['S', '1', '4242', ...Array<string>(16).fill('0'), proc.started]
    return `4242 (fixture process) ${fields.join(' ')}`
  },
}))
import { stopRuntimeTree } from '../src/runtime-security.ts'

function child(exited = false): ChildProcess {
  return Object.assign(new EventEmitter(), { pid: 4242, exitCode: exited ? 0 : null, signalCode: null }) as ChildProcess
}
afterEach(() => { vi.restoreAllMocks(); proc.started = '100'; proc.reads = 0 })

describe.skipIf(process.platform !== 'linux')('captured Linux process ownership', () => {
  it('refuses a replacement group after the original host exits', async () => {
    const host = child()
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -4242 && signal === 'SIGTERM') {
        proc.started = '200'
        Object.assign(host, { signalCode: 'SIGTERM' })
        host.emit('exit', null, 'SIGTERM')
      }
      return true
    })
    await expect(stopRuntimeTree(host, 10)).rejects.toThrow('Runtime tree ownership could not be confirmed')
    expect(kill.mock.calls).toEqual([[-4242, 'SIGTERM']])
  })

  it('never attributes an already exited child to a newly read live PID', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await expect(stopRuntimeTree(child(true), 10)).rejects.toThrow('Runtime tree ownership could not be confirmed')
    expect(kill).not.toHaveBeenCalled()
  })
})
