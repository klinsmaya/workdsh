import { boot } from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import type { EnterpriseBinding } from 'workdsh-contracts';
import { constants, openSync, writeFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { SnapshotIdentityAuthority, EnterpriseProfileError } from './snapshot-authority.js';
import { fixedEnterpriseComposition, ENTERPRISE_HOST_PACKAGES } from './profile-policy.js';
import type { MainBusinessCapabilities } from './main-capabilities.js';
import type { ModelPolicy } from '@afos/model-adapter';
import './authority-service.js';
import { EnterpriseNativeReadBridge } from './native-reads.js';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type {} from './native-ws-bridge.js';
import type {} from './native-ws-connection.js';
import type {} from './native-ws-http-admission.js';
import type { NativeCallerProof } from './native-ws-admission.js';
import type { NativeAssemblyCaptures } from './native-captures.js';

export interface EnterpriseAssemblyOptions {
  /** Namespace directory already protected by trusted Main, not a browser/model path. */
  readonly root: string;
  readonly binding: EnterpriseBinding;
  readonly projectId: string;
  readonly business: MainBusinessCapabilities;
  readonly model: ModelPolicy;
  readonly signal: AbortSignal;
}
function managedDirectory(path: string): void {
  if (!isAbsolute(path)) throw new EnterpriseProfileError('afos/profile-storage-denied');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new EnterpriseProfileError('afos/profile-storage-denied');
}
/** Fixed original Loader tree; no default bundle, home patches, expressions or generic controllers. */
export async function bootEnterpriseCore(options: EnterpriseAssemblyOptions): Promise<Context> {
  return bootCore(options, false);
}
/** Explicit opt-in headless assembly. It does not certify or activate a desktop carrier. */
export async function bootEnterpriseNativeReadCore(options: EnterpriseAssemblyOptions): Promise<Context> {
  return bootCore(options, true);
}
export interface EnterpriseNativeWsAssemblyOptions extends EnterpriseAssemblyOptions {
  /** Main-owned carrier caller proof, not a browser/model value. Missing capability refuses upgrades. */
  readonly nativeCaller: NativeCallerProof;
}
/** Original mux candidate only; does not activate an Electron carrier. */
export async function bootEnterpriseNativeWsCore(options: EnterpriseNativeWsAssemblyOptions): Promise<Context> {
  if (!options.nativeCaller || typeof options.nativeCaller.assertRequest !== 'function') throw new EnterpriseProfileError('afos/native-read-denied');
  return bootCore(options, true, options.nativeCaller);
}
async function bootCore(options: EnterpriseAssemblyOptions, nativeReads: boolean, nativeCaller?: NativeCallerProof): Promise<Context> {
  options.signal.throwIfAborted(); managedDirectory(options.root);
  const storage = join(options.root, 'business-storage'), sessions = join(options.root, 'sessions');
  managedDirectory(storage); managedDirectory(sessions);
  const require = createRequire(import.meta.url);
  const config: Record<string, unknown> = {
    '@deepseek-ai/dsh-storage-json': { root: storage }, '@deepseek-ai/dsh-storage-domain': { backend: 'json' },
    '@deepseek-ai/dsh-tools': { mode: 'native' },
    '@deepseek-ai/dsh-session-persistence-jsonl': { root: sessions, compression: 'none' },
    '@deepseek-ai/dsh-agent-loop': { agents: [], maxParallelToolCalls: 1 },
    '@deepseek-ai/dsh-agent-preset-registry': { default: 'afos-fixed' },
    '@deepseek-ai/dsh-agent-preset': { id: 'afos-fixed', name: 'AFOS material draft', plugins: [
      { name: require.resolve('@deepseek-ai/dsh-persona'), config: { prefix: 'You prepare evidence-based internal drafts for human review.', complete: false, includeRuntimeContext: false } },
    ] },
    '@deepseek-ai/dsh-host-webserver': { host: '127.0.0.1', port: 0 },
    '@deepseek-ai/dsh-credentials-local': { path: join(options.root, 'browser-auth.yaml'), dshHome: options.root, watch: false },
    '@deepseek-ai/dsh-client-connection': { maxRequestBodyBytes: 1048576, trustedHosts: [] },
    'workdsh-provider-identity-nocobase': { binding: options.binding, freshnessMs: 1000 },
    'workdsh-plugin-access': { enterprise: true },
    'workdsh-provider-enterprise-profile/runtime': { model: options.model },
    'workdsh-provider-enterprise-profile': fixedEnterpriseComposition(),
  };
  const rows = ENTERPRISE_HOST_PACKAGES.map((name, index) => ({ id: `afos-${index}`, name: require.resolve(name), ...(config[name] ? { config: config[name] } : {}) }));
  let nativeController: SessionController | undefined, nativeReader: Context | undefined, nativeMux: Context | undefined;
  let rootOwner: Context | undefined;
  const nativeWorkspace = join(options.root, 'native-workspace');
  const nativeCaptures: NativeAssemblyCaptures = {
    controller(value) { if (nativeController) throw new EnterpriseProfileError('afos/native-read-denied'); nativeController = value; if(nativeCaller)rootOwner?.provide('afosNativePrivateController',value); },
    reader(value) { if (nativeReader) throw new EnterpriseProfileError('afos/native-read-denied'); nativeReader = value; if(nativeCaller)rootOwner?.provide('afosNativePrivateReader',value); },
    mux(value) { if (nativeMux) throw new EnterpriseProfileError('afos/native-read-denied'); nativeMux = value; },
  };
  if (nativeReads) {
    managedDirectory(nativeWorkspace);
    const row = (name: string, prefix: string, value?: unknown) => ({ id: prefix + '-' + name,
      name: require.resolve(name), ...(value === undefined ? {} : { config: value }) });
    const privateConnection = 'afos-owned-native-connection';
    const closedWeb = 'afos-owned-native-web-absent';
    const aliases = ['commands', 'attachments', 'fs', 'agentDefaultModel', 'sessionQuery', 'workspaceRegistry',
      'fileReferences', 'fileUploads', 'sessionController', 'sessionFileReferences', 'sessionSkillCatalog'];
    const nativeConfig: Record<string, unknown> = {
      '@deepseek-ai/dsh-attachment-local': { dshHome: options.root, maxImageBytes: 65536, maxImagesPerMessage: 1, maxMessageImageBytes: 65536 },
      '@deepseek-ai/dsh-fs-local': { cwd: nativeWorkspace },
      '@deepseek-ai/dsh-agent-default-model': { provider: options.model.provider, model: options.model.model },
      '@deepseek-ai/dsh-session-query-sqlite': { path: join(options.root, 'native-derived-index.db'), openAt: 'never' },
      '@deepseek-ai/dsh-api-session-controller': { nativeOpen: false },
    };
    const controllerNames = ['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-attachment-local',
      '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-session-query-sqlite',
      '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-file-reference', '@deepseek-ai/dsh-client-file-upload', '@deepseek-ai/dsh-api-session-controller'];
    rows.push({ id: 'afos-private-native-controller', name: require.resolve('@deepseek-ai/cordis-plugin-group'), group: true,
      isolate: { connection: privateConnection, webServer: closedWeb, typertGateway: true, typert: true,
        ...Object.fromEntries(aliases.map(name => [name, true])) },
      config: [...controllerNames.map(name => row(name, 'afos-native-controller', nativeConfig[name])),
        row('workdsh-provider-enterprise-profile/native-controller-capture', 'afos-native-controller')] } as typeof rows[number]);
    rows.push({ id: 'afos-private-owned-native-reader', name: require.resolve('@deepseek-ai/cordis-plugin-group'), group: true,
      isolate: { connection: privateConnection, webServer: closedWeb, typertGateway: true, typert: true,
        llm: true, agentPresets: true, ...Object.fromEntries(aliases.map(name => [name, true])) },
      config: [row('@deepseek-ai/dsh-client-connection', 'afos-native-reader', { maxRequestBodyBytes: 2 * 1048576, trustedHosts: [] }),
        row('@deepseek-ai/dsh-typert-registry', 'afos-native-reader'), row('@deepseek-ai/dsh-api-gateway', 'afos-native-reader'),
        row('workdsh-provider-enterprise-profile/native-reader-capture', 'afos-native-reader')] } as typeof rows[number]);
  }
  if (nativeCaller) {
    if (typeof nativeCaller.assertRequest !== 'function') throw new EnterpriseProfileError('afos/native-read-denied');
    const isolated = ['commands', 'attachments', 'fs', 'agentDefaultModel', 'sessionQuery', 'workspaceRegistry',
      'fileReferences', 'fileUploads', 'sessionController', 'sessionFileReferences', 'sessionSkillCatalog', 'afosOwnedNativeRead',
      'afosOwnedNativeMuxRead', 'afosNativePrivateController', 'afosNativePrivateReader', 'llm', 'agentPresets'];
    rows.push({ id: 'afos-native-loader-bridge', name: require.resolve('workdsh-provider-enterprise-profile/native-ws-bridge'), config: { workspace: nativeWorkspace } });
    rows.push({ id: 'afos-native-http-caller-proof', name: require.resolve('workdsh-provider-enterprise-profile/native-ws-http-admission') });
    rows.push({ id: 'afos-owned-original-native-mux', name: require.resolve('@deepseek-ai/cordis-plugin-group'), group: true,
      isolate: { connection: true, typertGateway: true, typert: true, webServer: true, ...Object.fromEntries(isolated.map(name => [name, true])) },
      config: ['@deepseek-ai/dsh-typert-registry', 'workdsh-provider-enterprise-profile/native-ws-connection', '@deepseek-ai/dsh-api-gateway',
        'workdsh-provider-enterprise-profile/native-ws-admission', 'workdsh-provider-enterprise-profile/native-ws-facade',
        'workdsh-provider-enterprise-profile/native-ws-capture'].map((name, index) => ({ id: 'afos-native-mux-' + index, name: require.resolve(name) })) } as typeof rows[number]);
  }
  const filename = join(options.root, `afos-core-${randomUUID()}.json`);
  const descriptor = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, JSON.stringify(rows)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  const identity = new SnapshotIdentityAuthority(options.binding, options.projectId,
    async (projectId, signal) => { if (projectId !== options.projectId) throw new EnterpriseProfileError('afos/profile-project-denied'); return options.business.currentAuthority(AbortSignal.any([signal, options.signal])); });
  let ctx: Context | undefined;
  try {
    ctx = await boot('afos-enterprise', filename, [], root => {
      rootOwner = root; root.provide('afosMainBusiness', options.business); root.provide('afosIdentityAuthority', identity);
      if (nativeReads) root.provide('afosNativeAssemblyCapture', nativeCaptures);
      if (nativeCaller) {
        root.provide('afosNativeCallerProof', nativeCaller);
        root.inject(['webServer'], owner => { owner.provide('afosNativeParentWebServer', owner.webServer); });
        root.inject(['connection'], owner => { owner.provide('afosNativeParentConnection', owner.connection); });
      }
    }, import.meta.url);
    ctx.effect(() => () => { try { unlinkSync(filename); } catch { /* Already removed during a failed start. */ } }, 'afosGeneratedConfig');
    options.signal.throwIfAborted();
    for (const required of ['storage', 'storageDomain', 'tools', 'sessions', 'sessionProjections', 'sessionPersistence',
      'llm', 'systemPrompt', 'agents', 'agentLoop', 'skills', 'agentPresets', 'webServer', 'credentials', 'connection',
      'workdshIdentity', 'workdshAudit', 'workdshAccess', 'afosProfileAuthority', 'afosProfileBridge', 'afosDraftRuntime', 'afosEnterpriseIngress']) {
      if (ctx.get(required) === undefined) throw new EnterpriseProfileError('afos/profile-required-service-inactive');
    }
    for (const forbidden of ['typertGateway', 'fs', 'mcp', 'bash', 'ptc', 'settings', 'sessionController']) {
      if (ctx.get(forbidden) !== undefined) throw new EnterpriseProfileError('afos/profile-unapproved-service');
    }
    if (nativeReads) {
      if (!nativeController || !nativeReader) throw new EnterpriseProfileError('afos/native-read-denied');
      if (!nativeCaller) await ctx.plugin(EnterpriseNativeReadBridge, { controller: nativeController, reader: nativeReader, workspace: nativeWorkspace });
      if (!ctx.get('afosNativeReadBridge')) throw new EnterpriseProfileError('afos/native-read-denied');
      if (nativeCaller && (!nativeMux || nativeMux.get('connection')?.operator !== ctx.get('connection')?.operator
        || nativeMux.get('webServer') === ctx.get('webServer') || !ctx.get('afosNativeHttpProof'))) throw new EnterpriseProfileError('afos/native-read-denied');
    }
    const cutoff = () => {
      identity.cutoff(); ctx?.get('workdshIdentity')?.cutoff(); ctx?.get('afosEnterpriseIngress')?.cutoff();
      for (const agent of ctx?.get('agents')?.list() ?? []) agent.cancel({ kind: 'hook', reason: 'afos-main-cutoff' });
      void ctx?.fiber.dispose().catch(() => undefined);
    };
    ctx.effect(() => { options.signal.addEventListener('abort', cutoff, { once: true }); return () => { options.signal.removeEventListener('abort', cutoff); identity.cutoff(); }; }, 'afosMainLifetime');
    if (options.signal.aborted) { cutoff(); throw new EnterpriseProfileError('afos/profile-cutoff'); }
    return ctx;
  } catch (error) { identity.cutoff(); if (ctx) await ctx.fiber.dispose(); try { unlinkSync(filename); } catch { /* Only our generated file. */ } throw error; }
}
