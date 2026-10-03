import { boot } from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import type { EnterpriseBinding } from 'workdsh-contracts';
import { constants, openSync, writeFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { SnapshotIdentityAuthority, EnterpriseProfileError } from './snapshot-authority.js';
import { fixedEnterpriseCoreRows } from './core-rows.js';
export { fixedEnterpriseCoreRows } from './core-rows.js';
import type { MainBusinessCapabilities } from './main-capabilities.js';
import type { ModelPolicy } from '@afos/model-adapter';
import './authority-service.js';
import { fixedNativeLoaderRows } from './native-loader-rows.js';
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
  const rows = fixedEnterpriseCoreRows(options);
  const require = createRequire(import.meta.url);
  let nativeController: SessionController | undefined, nativeControllerContext:Context|undefined, nativeReader: Context | undefined, nativeMux: Context | undefined;
  let rootOwner: Context | undefined;
  const nativeWorkspace = join(options.root, 'native-workspace');
  const nativeCaptures: NativeAssemblyCaptures = {
    controller(value,context) { if (nativeController) throw new EnterpriseProfileError('afos/native-read-denied'); nativeController = value; nativeControllerContext=context; if(nativeCaller){rootOwner?.provide('afosNativePrivateController',value);rootOwner?.provide('afosNativePrivateControllerContext',context);} },
    reader(value) { if (nativeReader) throw new EnterpriseProfileError('afos/native-read-denied'); nativeReader = value; if(nativeCaller)rootOwner?.provide('afosNativePrivateReader',value); },
    mux(value) { if (nativeMux) throw new EnterpriseProfileError('afos/native-read-denied'); nativeMux = value; },
  };
  if(nativeReads) rows.push(...fixedNativeLoaderRows(options,Boolean(nativeCaller)) as typeof rows);
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
      if (!nativeCaller) await ctx.plugin(EnterpriseNativeReadBridge, { controller: nativeController, controllerContext:nativeControllerContext, reader: nativeReader, workspace: nativeWorkspace });
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
