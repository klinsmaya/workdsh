import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import type { EnterpriseBinding } from 'workdsh-contracts';
import type { ModelPolicy } from '@afos/model-adapter';
import { EnterpriseProfileError } from './snapshot-authority.js';
import { fixedEnterpriseComposition, ENTERPRISE_HOST_PACKAGES } from './profile-policy.js';
export interface CoreRowOptions { readonly root:string; readonly binding:EnterpriseBinding; readonly model:ModelPolicy; readonly signal:AbortSignal; readonly nativeCaller?:true; }
function managedDirectory(path:string):void {
  if(!isAbsolute(path))throw new EnterpriseProfileError('afos/profile-storage-denied');
  mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)))throw new EnterpriseProfileError('afos/profile-storage-denied');
}
/** Shared fixed rows for the original headless boot or existing managed CLI scope. */
export function fixedEnterpriseCoreRows(options: CoreRowOptions) {
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
  return ENTERPRISE_HOST_PACKAGES.map((name, index) => ({ id: `afos-${index}`, name: require.resolve(name), ...(config[name] ? { config: config[name] } : {}) }));
}
