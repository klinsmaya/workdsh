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
  const filename = join(options.root, `afos-core-${randomUUID()}.json`);
  const descriptor = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, JSON.stringify(rows)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  const identity = new SnapshotIdentityAuthority(options.binding, options.projectId,
    async (projectId, signal) => { if (projectId !== options.projectId) throw new EnterpriseProfileError('afos/profile-project-denied'); return options.business.currentAuthority(AbortSignal.any([signal, options.signal])); });
  let ctx: Context | undefined;
  try {
    ctx = await boot('afos-enterprise', filename, [], root => {
      root.provide('afosMainBusiness', options.business); root.provide('afosIdentityAuthority', identity);
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
