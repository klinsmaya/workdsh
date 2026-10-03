/** Minimal Electron carrier for the bundled WorkDSH release profile. */

import { app, BrowserWindow, shell, Menu, dialog, safeStorage, powerMonitor, ipcMain, protocol, type MenuItemConstructorOptions } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBundledCompatibility } from './runtime-compatibility.ts'
import { isRuntimeDownload, isRuntimeNavigation, redactRuntimeLog, runtimeEnvironment, RuntimeLogFilter, safeExternalUrl, stopRuntimeTree } from './runtime-security.ts'

import { createEnterpriseEntry } from './enterprise-entry.ts'
import type { EnterpriseMainSession } from './enterprise-main.ts'
import type { EnterpriseProject } from './enterprise-broker.ts'
import { createEnterpriseElectronHost, runtimeDraftProjection, enterpriseRuntimePaths } from './enterprise-electron.ts'
import type { installLocalDraftIpc } from './enterprise-local-ipc.ts'
import { createEnterpriseWindowOwner } from './enterprise-window.ts'

const PROFILE_NAME = 'workdsh'
const READY_PATTERN = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s]+)/u

let enterpriseSession: EnterpriseMainSession | undefined
let localDraftOwner: ReturnType<typeof installLocalDraftIpc> | undefined
protocol.registerSchemesAsPrivileged([{ scheme: 'afos-local', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
let runtime: ChildProcess | undefined
let window: BrowserWindow | undefined
let quitting = false
let cleanupComplete = false

function bundledProfileDirectory(): string {
  const overridden = process.env.WORKDSH_BUNDLED_PROFILE
  if (overridden !== undefined && overridden.length > 0) return overridden
  return join(process.resourcesPath, 'workdsh-runtime', 'profiles', PROFILE_NAME)
}

function runtimeHome(): string {
  const overridden = process.env.WORKDSH_DSH_HOME
  if (overridden !== undefined && overridden.length > 0) return overridden
  return join(app.getPath('userData'), 'dsh-home')
}

function bundledNodeExecutable(): string {
  const overridden = process.env.WORKDSH_NODE_EXECUTABLE
  if (overridden !== undefined && overridden.length > 0) return overridden
  return join(
    bundledPrimaryRuntime(),
    'dependencies',
    'node',
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
}

function bundledPrimaryRuntime(): string {
  const overridden = process.env.WORKDSH_PRIMARY_RUNTIME
  if (overridden !== undefined && overridden.length > 0) return overridden
  return join(process.resourcesPath, 'workdsh-runtime', 'primary-runtime')
}

function browserWorkerRequest(): { port: number, profile: string } | undefined {
  const portArg = process.argv.find(arg => arg.startsWith('--workdsh-browser-worker-port='))
  if (portArg === undefined) return undefined
  const port = Number(portArg.slice('--workdsh-browser-worker-port='.length))
  const profile = process.argv.find(arg => arg.startsWith('--workdsh-browser-worker-profile='))
    ?.slice('--workdsh-browser-worker-profile='.length)
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !profile || !isAbsolute(profile) || !existsSync(profile)) {
    throw new Error('Invalid WorkDSH browser worker arguments')
  }
  return { port, profile }
}

function startBrowserWorker(request: { port: number, profile: string }): void {
  app.setPath('userData', request.profile)
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', String(request.port))
  void app.whenReady().then(async () => {
    app.dock?.hide()
    const page = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await page.loadURL('about:blank')
    process.stdout.write('WORKDSH_BROWSER_WORKER_READY\n')
  }).catch(error => {
    process.stderr.write(`WorkDSH browser worker failed: ${String(error)}\n`)
    app.exit(1)
  })
}

function materializeRuntimeProfile(home: string): string {
  const source = bundledProfileDirectory()
  const target = join(home, 'profiles', PROFILE_NAME)
  const marker = join(target, '.workdsh-desktop-runtime')
  const sourceModules = join(source, 'node_modules')
  const targetModules = join(target, 'node_modules')
  if (!existsSync(sourceModules)) {
    throw new Error(`Bundled WorkDSH runtime is incomplete: ${sourceModules}`)
  }
  const dsh = JSON.parse(readFileSync(join(sourceModules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version: string }
  const bundle = JSON.parse(readFileSync(join(sourceModules, 'workdsh-bundle', 'package.json'), 'utf8')) as { version: string }
  const runtimeVersion = `${bundle.version}+dsh-${dsh.version}`
  mkdirSync(target, { recursive: true })
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const from = join(source, name)
    if (existsSync(from)) cpSync(from, join(target, name), { force: true })
  }
  const installedVersion = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined
  if (existsSync(targetModules) && installedVersion !== runtimeVersion) {
    const stat = lstatSync(targetModules)
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `WorkDSH cannot replace the existing unmanaged runtime at ${targetModules}. `
        + 'Move that directory, then reopen WorkDSH.',
      )
    }
    readlinkSync(targetModules)
    unlinkSync(targetModules)
  }
  if (!existsSync(targetModules)) {
    symlinkSync(sourceModules, targetModules, process.platform === 'win32' ? 'junction' : 'dir')
  }
  syncBundledCompatibility(source, target, runtimeVersion)
  writeFileSync(marker, `${runtimeVersion}\n`, 'utf8')
  return target
}

function openWindow(url: string): void {
  const icon = fileURLToPath(new URL('../build/app-icon.png', import.meta.url))
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'WorkDSH',
    icon,
    backgroundColor: '#111113',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.on('page-title-updated', event => {
    event.preventDefault()
    window?.setTitle('WorkDSH')
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    const external = safeExternalUrl(target)
    if (external) shell.openExternal(external).catch(() => process.stderr.write('External navigation failed\n'))
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (!isRuntimeNavigation(target, url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, target) => {
    if (!isRuntimeNavigation(target, url)) event.preventDefault()
  })
  window.webContents.session.on('will-download', (event, item, sender) => {
    if (sender !== window?.webContents || ![item.getURL(),...item.getURLChain()].every(target => isRuntimeDownload(target,url))) {
      event.preventDefault();return
    }
    // Electron owns the save dialog; renderer content never supplies a file path.
    const filename=basename(item.getFilename()).replace(/[\u0000-\u001f]/gu,'')
    item.setSaveDialogOptions({defaultPath:join(app.getPath('downloads'),filename&&filename!=='.'&&filename!=='..'?filename:'WorkDSH-export')})
  })
  void window.loadURL(url).then(() => window?.show())
  window.on('closed', () => { window = undefined })
}

function startRuntime(home: string, profileDir: string): void {
  const cli = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cli)) throw new Error(`Bundled WorkDSH launcher is missing: ${cli}`)
  const executable = bundledNodeExecutable()
  if (!existsSync(executable)) throw new Error(`Bundled Node.js runtime is missing: ${executable}`)
  const child = spawn(executable, [cli, '--profile', PROFILE_NAME, '--no-open'], {
    env: {
      ...runtimeEnvironment(process.env),
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_BUNDLED_PRIMARY_RUNTIME: bundledPrimaryRuntime(),
      DSH_ELECTRON_EXECUTABLE: process.execPath,
      ELECTRON_RUN_AS_NODE: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    cwd: home,
  })
  runtime = child
  let ready = false
  let output = ''
  const stdoutLog = new RuntimeLogFilter(text => process.stderr.write(text))
  const stderrLog = new RuntimeLogFilter(text => process.stderr.write(text))
  const consume = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    stdoutLog.consume(chunk)
    if (ready) return
    output = `${output}${text}`.slice(-16_384)
    const match = READY_PATTERN.exec(output)
    if (match?.[1] !== undefined) {
      ready = true
      openWindow(match[1])
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', (chunk: Buffer) => stderrLog.consume(chunk))
  child.once('error', cause => {
    if (!quitting) throw cause
  })
  child.once('exit', code => {
    stdoutLog.flush()
    stderrLog.flush()
    if (!quitting && code !== 0) app.quit()
  })
}

async function stopRuntime(): Promise<void> {
  quitting = true
  if (runtime !== undefined) await stopRuntimeTree(runtime)
  runtime = undefined
}

/** Native account owner and its finite local draft face; Host activation remains refused. */
function installEnterpriseEntry(): boolean {
  let enterpriseWindows: ReturnType<typeof createEnterpriseWindowOwner> | undefined
  const enterprisePaths = enterpriseRuntimePaths(app.getAppPath(), process.resourcesPath, app.isPackaged)
  enterpriseSession = createEnterpriseEntry({
    configPath: join(app.getAppPath(), 'afos-desktop-config.json'),
    dataDirectory: join(app.getPath('userData'), 'afos'),
    storage: safeStorage,
    openBrowser: async url => { await shell.openExternal(url) },
    host: config => createEnterpriseElectronHost({ appPath: app.getAppPath(), ...enterprisePaths, config,
      callerIssuer: { assertRequest: (request, signal) => { const onlineOwner = enterpriseWindows?.current()?.online; if (!onlineOwner) throw new Error('enterprise/online-carrier-refused'); return onlineOwner.callerIssuer.assertRequest(request, signal) } },
      online: { frontendIndex: join(app.getAppPath(), 'renderer', 'afos-online', 'index.html'), onReady: async ready => {
        const accountSignal = enterpriseSession?.localDraftCapabilities().accountSignal
        const onlineOwner = enterpriseWindows?.current()?.online
        if (!onlineOwner || !accountSignal) throw new Error('enterprise/online-carrier-refused')
        await onlineOwner.showOnline(ready, accountSignal)
      } },
      writeLog: text => process.stderr.write(redactRuntimeLog(text)),
      onUnexpectedStop: async () => {
        enterpriseWindows?.cancelStart()
        const stopping = enterpriseSession?.stopEnterprise()
        localDraftOwner?.changed(); try { await stopping } finally { localDraftOwner?.changed() }
      },
    }),
  })
  if (!enterpriseSession) return false
  const session = enterpriseSession
  const localSession = session
  let projects: readonly EnterpriseProject[] = []
  const report = async (work: () => Promise<unknown>, success: string): Promise<void> => {
    try { const operation = work(); localDraftOwner?.changed(); await operation; await dialog.showMessageBox({ type: 'info', title: 'AFOS', message: success }) }
    catch (error) {
      const code = error instanceof Error && /^(?:enterprise|auth|broker|afos)\/[a-z-]{1,80}$/u.test(error.message) ? error.message : 'enterprise/action-failed'
      await dialog.showMessageBox({ type: 'error', title: 'AFOS', message: code })
    } finally { localDraftOwner?.changed() }
  }
  const refreshMenu = (): void => {
    const account: MenuItemConstructorOptions[] = [
      { label: 'Sign in / 登录', click: () => { enterpriseWindows?.cancelStart(); void report(async () => { projects = []; refreshMenu(); projects = await session.signIn(); refreshMenu() }, 'Select an allowed project from the account menu. / 请在账号菜单选择已授权项目。') } },
      { label: 'Projects / 项目', submenu: projects.map(project => ({ label: project.name.replaceAll('&', '').slice(0, 80), click: () => { enterpriseWindows?.cancelStart(); void report(() => session.selectProject(project.id), 'Account and project verified. / 账号与项目已核实。') } })) },
      { label: 'Start enterprise Host / 启动企业 Host', click: () => { void report(async () => { if (!enterpriseWindows) throw new Error('enterprise/window-owner-refused'); await enterpriseWindows.startHost() }, 'Enterprise Host started. / 企业 Host 已启动。') } },
      { label: 'Stop enterprise Host / 停止企业 Host', click: () => { void report(() => enterpriseWindows ? enterpriseWindows.stopHost() : localSession.stopEnterprise(), 'Enterprise Host stopped. Local drafts remain available. / 企业 Host 已停稳，本地草稿保留。') } },
      { label: 'Sign out / 退出账号', click: () => { enterpriseWindows?.cancelStart(); void report(async () => { projects = []; refreshMenu(); await session.logout() }, 'Signed out. Drafts are preserved. / 已退出账号，草稿保留。') } },
      { role: 'quit' },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AFOS', submenu: account }]))
  }
  refreshMenu()
  enterpriseWindows = createEnterpriseWindowOwner({ createWindow: options => new BrowserWindow(options), ipc: ipcMain, appPath: app.getAppPath(),
    capabilities: () => localSession.localDraftCapabilities(), projectDraft: runtimeDraftProjection(enterprisePaths.runtimeProfile),
    activated: face => { window = face.window; localDraftOwner = face.owner },
    closed: () => { localDraftOwner = undefined; window = undefined },
    startHost: () => session.startHost(), stopHost: () => session.stopEnterprise(),
    loadFailed: () => { process.stderr.write('AFOS local drafts window failed\n') },
    cleanupFailed: () => { process.stderr.write('AFOS window cleanup failed\n') },
  })
  powerMonitor.on('suspend', () => { enterpriseWindows?.cancelStart(); void session.suspend().then(() => localDraftOwner?.changed()).catch(() => { localDraftOwner?.changed(); process.stderr.write('AFOS suspend cleanup failed\n') }) })
  return true
}

const worker = browserWorkerRequest()
if (worker !== undefined) {
  startBrowserWorker(worker)
} else {
app.setName('WorkDSH')
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.on('before-quit', event => {
    if (cleanupComplete) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void (async () => { await enterpriseSession?.suspend(); await stopRuntime() })().then(() => { cleanupComplete = true; app.quit() }).catch(() => {
      process.stderr.write('WorkDSH runtime cleanup failed; application remains open\n')
      quitting = false
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (window === undefined) {
      // A healthy runtime always owns a window. Relaunching keeps the profile
      // lifecycle simple after the last macOS window was closed.
      app.relaunch()
      app.quit()
    }
  })
  void app.whenReady().then(() => {
    if (installEnterpriseEntry()) return
    const home = runtimeHome()
    const profile = materializeRuntimeProfile(home)
    startRuntime(home, profile)
  }).catch(cause => {
    process.stderr.write(redactRuntimeLog(`WorkDSH failed to start: ${cause instanceof Error ? cause.message : String(cause)}\n`))
    app.quit()
  })
}
}
