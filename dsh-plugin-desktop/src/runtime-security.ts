import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'

const allowedEnvironment = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'WINDIR',
  'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
])

export function runtimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowedEnvironment.has(key.toUpperCase())))
}

export function redactRuntimeLog(text: string): string {
  return text
    .replace(/(\b(?:access_token|refresh_token|id_token|token|code|state|client_secret|code_verifier)\s*[=:]\s*)[^\s&#"',]+/giu, '$1[REDACTED]')
    .replace(/("(?:access_token|refresh_token|id_token|token|code|state|client_secret|code_verifier|cookie|set-cookie|authorization|api_key|password)"\s*:\s*")[^"]*/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s"',]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]*/giu, '[REDACTED HEADER]')
}

/** Hold whole lines so a split token cannot evade redaction. Drop oversized lines. */
export class RuntimeLogFilter {
  private pending = ''
  private dropping = false
  constructor(private readonly write: (text: string) => void) {}
  consume(chunk: Buffer | string): void {
    for (const part of chunk.toString().split(/(?<=\n)/u)) {
      if (!this.dropping) this.pending += part
      if (this.pending.length > 16_384) {
        this.pending = ''
        this.dropping = true
      }
      if (part.endsWith('\n')) {
        this.write(this.dropping ? '[oversized runtime log omitted]\n' : redactRuntimeLog(this.pending))
        this.pending = ''
        this.dropping = false
      }
    }
  }
  flush(): void {
    if (this.pending) this.write(redactRuntimeLog(this.pending))
    this.pending = ''
  }
}

export function safeExternalUrl(target: string): string | undefined {
  try {
    const url = new URL(target)
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return undefined
    const host = url.hostname.toLowerCase()
    if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/u.test(host)
      || /(?:^|\.)(?:localhost|local|internal)$/u.test(host)) return undefined
    for (const key of url.searchParams.keys()) {
      if (/^(?:token|access_token|refresh_token|id_token|code|state|client_secret)$/iu.test(key)) return undefined
    }
    return url.href
  } catch { return undefined }
}

export function isRuntimeNavigation(target: string, runtimeUrl: string): boolean {
  try {
    const url = new URL(target)
    const runtime = new URL(runtimeUrl)
    return !url.username && !url.password && url.origin === runtime.origin
      && url.protocol === 'http:' && url.hostname === '127.0.0.1'
  } catch { return false }
}
export function isRuntimeDownload(target: string, runtimeUrl: string): boolean {
  try {
    const url=new URL(target); const runtime=new URL(runtimeUrl)
    return url.origin===runtime.origin && !url.username && !url.password
      && (isRuntimeNavigation(target,runtimeUrl)||url.protocol==='blob:'&&runtime.protocol==='http:'&&runtime.hostname==='127.0.0.1')
  } catch { return false }
}

interface LinuxProcess { readonly pid: number; readonly parent: number; readonly group: number; readonly started: string; readonly state: string }
async function linuxProcess(pid: number, required = false): Promise<LinuxProcess | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    const parent = Number(fields[1]); const group = Number(fields[2]); const started = fields[19]; const state = fields[0]
    if (!Number.isSafeInteger(parent) || !Number.isSafeInteger(group) || !started || !/^\d+$/u.test(started) || state?.length !== 1) {
      if (required) throw new Error('Runtime tree stop could not be confirmed')
      return undefined
    }
    return {pid,parent,group,started,state}
  } catch (error) {
    if (required && !(error instanceof Error && 'code' in error && ['ENOENT','ESRCH'].includes(String(error.code)))) throw error
    return undefined
  }
}
async function linuxDescendants(known: Map<number, LinuxProcess>, root: number): Promise<void> {
  const entries = await readdir('/proc')
  const rows = await Promise.all(entries.filter(name => /^\d+$/u.test(name)).map(name => linuxProcess(Number(name))))
  const current = new Map(rows.filter((row): row is LinuxProcess => row !== undefined).map(row => [row.pid,row]))
  const parents = new Set<number>()
  const host = current.get(root)
  if (host && known.get(root)?.started === host.started) { known.set(root,host); parents.add(root) }
  for (const [pid,row] of known) if (current.get(pid)?.started === row.started) parents.add(pid)
  let changed = true
  while (changed) {
    changed = false
    for (const row of current.values()) if (parents.has(row.parent) && !parents.has(row.pid)) {
      known.set(row.pid,row); parents.add(row.pid); changed=true
    }
  }
}

async function signalOwnedLinuxGroup(known: Map<number, LinuxProcess>, group: number, signal: NodeJS.Signals): Promise<void> {
  const leader = await linuxProcess(group, true)
  const capturedLeader = known.get(group)
  if (leader && (!capturedLeader || leader.started !== capturedLeader.started)) throw new Error('Runtime tree ownership could not be confirmed')
  for (const row of known.values()) {
    const current = await linuxProcess(row.pid, true)
    if (current && current.started === row.started && current.group === group) {
      try { process.kill(-group, signal) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
      return
    }
  }
  // Without a surviving captured member the group cannot be attributed to this
  // ChildProcess. Check for live members, but never signal a newly adopted group.
  const entries = await readdir('/proc')
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    const row = await linuxProcess(Number(entry), true)
    if (row?.group === group && !['Z','X','x'].includes(row.state)) throw new Error('Runtime tree ownership could not be confirmed')
  }
}
async function stopKnownLinuxProcesses(known: Map<number, LinuxProcess>): Promise<void> {
  // Detached official subprocesses have a separate group. Keep start identities
  // from before Host exit; do not send a signal to a subsequently reused PID.
  for (const row of [...known.values()].reverse()) {
    const current = await linuxProcess(row.pid, true)
    if (!current || current.started !== row.started) continue
    try { process.kill(row.pid,'SIGKILL') } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
}

async function confirmKnownLinuxProcessesStopped(known: Map<number, LinuxProcess>): Promise<void> {
  // Sending SIGKILL does not acknowledge termination. Recheck the captured start
  // identity; a zombie no longer executes, and a reused PID is not our process.
  const deadline = performance.now() + 1_000
  while (true) {
    const remaining = await Promise.all([...known.values()].map(async row => {
      const current = await linuxProcess(row.pid, true)
      return current && current.started === row.started && current.state !== 'Z' && current.state !== 'X' && current.state !== 'x'
    }))
    if (!remaining.some(Boolean)) return
    if (performance.now() >= deadline) throw new Error('Runtime tree stop could not be confirmed')
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}

/** Cooperative DSH shutdown first, then best-effort cleanup. This is not OS containment. */
export async function stopRuntimeTree(child: ChildProcess, graceMs = 10_000): Promise<void> {
  if (!child.pid) return
  const pid = child.pid
  const linuxProcesses = new Map<number,LinuxProcess>()
  if (process.platform === 'linux') {
    // An already exited ChildProcess cannot establish ownership from its old PID.
    if (child.exitCode === null && child.signalCode === null) {
      const host = await linuxProcess(pid, true)
      if (host && child.exitCode === null && child.signalCode === null) linuxProcesses.set(pid, host)
    }
    await linuxDescendants(linuxProcesses,pid)
  }
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), graceMs) })
  let windowsTreeClosed = false
  try {
    if (process.platform === 'win32') {
      // Node SIGTERM kills the Windows parent immediately, losing /T ancestry.
      // Ask Windows to close the whole tree before the forceful fallback.
      windowsTreeClosed = await new Promise<boolean>(resolve => {
        const closer = spawn('taskkill.exe', ['/pid', String(pid), '/T'], {windowsHide:true,stdio:'ignore'})
        closer.once('error', () => resolve(false))
        closer.once('exit', code => resolve(code === 0))
      })
    }
    else if (process.platform === 'linux') await signalOwnedLinuxGroup(linuxProcesses, pid, 'SIGTERM')
    else process.kill(-pid, 'SIGTERM')
  } catch (error) {
    if (timer) clearTimeout(timer)
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  const result = await Promise.race([exited, deadline])
  if (timer) clearTimeout(timer)
  // Kill remaining group members even when the parent has already exited.
  if (process.platform === 'win32') {
    if (windowsTreeClosed && result !== 'timeout') return
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', reject)
      killer.once('exit', code => code === 0 ? resolve() : reject(new Error('Runtime tree stop could not be confirmed')))
    })
  } else {
    if (process.platform === 'linux') {
      await linuxDescendants(linuxProcesses,pid)
      await stopKnownLinuxProcesses(linuxProcesses)
    }
    if (process.platform === 'linux') await signalOwnedLinuxGroup(linuxProcesses, pid, 'SIGKILL')
    else try { process.kill(-pid, 'SIGKILL') } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
    if (process.platform === 'linux') await confirmKnownLinuxProcessesStopped(linuxProcesses)
  }
  if (result === 'timeout') await exited
}
