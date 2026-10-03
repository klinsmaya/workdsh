import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { mkdirSync, lstatSync } from 'node:fs';
import type { ModelPolicy } from '@afos/model-adapter';
import { EnterpriseProfileError } from './snapshot-authority.js';
interface NativeRow { readonly id:string; readonly name:string; readonly group?:boolean; readonly isolate?:Record<string,string|boolean>; readonly config?:unknown }
function managedDirectory(path:string):void {
 if(!isAbsolute(path))throw new EnterpriseProfileError('afos/profile-storage-denied');
 mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077))throw new EnterpriseProfileError('afos/profile-storage-denied');
}
/** Same exact original Controller/reader/mux Loader fragments for headless and managed CLI. */
export function fixedNativeLoaderRows(options:{readonly root:string;readonly model:ModelPolicy},mux:boolean):readonly NativeRow[] {
 const require=createRequire(import.meta.url),nativeWorkspace=join(options.root,'native-workspace');
 const rows:NativeRow[]=[];
  {
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
        row('workdsh-provider-enterprise-profile/native-controller-capture', 'afos-native-controller')] });
    rows.push({ id: 'afos-private-owned-native-reader', name: require.resolve('@deepseek-ai/cordis-plugin-group'), group: true,
      isolate: { connection: privateConnection, webServer: closedWeb, typertGateway: true, typert: true,
        llm: true, agentPresets: true, ...Object.fromEntries(aliases.map(name => [name, true])) },
      config: [row('@deepseek-ai/dsh-client-connection', 'afos-native-reader', { maxRequestBodyBytes: 2 * 1048576, trustedHosts: [] }),
        row('@deepseek-ai/dsh-typert-registry', 'afos-native-reader'), row('@deepseek-ai/dsh-api-gateway', 'afos-native-reader'),
        row('workdsh-provider-enterprise-profile/native-reader-capture', 'afos-native-reader')] });
  }
  if (mux) {
    const isolated = ['commands', 'attachments', 'fs', 'agentDefaultModel', 'sessionQuery', 'workspaceRegistry',
      'fileReferences', 'fileUploads', 'sessionController', 'sessionFileReferences', 'sessionSkillCatalog', 'afosOwnedNativeRead',
      'afosOwnedNativeMuxRead', 'afosNativePrivateController', 'afosNativePrivateReader', 'llm', 'agentPresets'];
    rows.push({ id: 'afos-native-loader-bridge', name: require.resolve('workdsh-provider-enterprise-profile/native-ws-bridge'), config: { workspace: nativeWorkspace } });
    rows.push({ id: 'afos-native-http-caller-proof', name: require.resolve('workdsh-provider-enterprise-profile/native-ws-http-admission') });
    rows.push({ id: 'afos-owned-original-native-mux', name: require.resolve('@deepseek-ai/cordis-plugin-group'), group: true,
      isolate: { connection: true, typertGateway: true, typert: true, webServer: true, ...Object.fromEntries(isolated.map(name => [name, true])) },
      config: ['@deepseek-ai/dsh-typert-registry', 'workdsh-provider-enterprise-profile/native-ws-connection', '@deepseek-ai/dsh-api-gateway',
        'workdsh-provider-enterprise-profile/native-ws-admission', 'workdsh-provider-enterprise-profile/native-ws-facade',
        'workdsh-provider-enterprise-profile/native-ws-capture'].map((name, index) => ({ id: 'afos-native-mux-' + index, name: require.resolve(name) })) });
  }
 return rows;
}
