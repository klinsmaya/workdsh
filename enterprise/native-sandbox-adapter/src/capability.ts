import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export type NativeCapabilityState = 'full' | 'partial' | 'unavailable';
export interface NativeCapability {
  readonly state: NativeCapabilityState;
  readonly platform: NodeJS.Platform;
  readonly processFilesystem: boolean;
  readonly processNetwork: boolean;
  readonly localSockets: boolean;
  readonly managedRange: boolean;
  readonly diagnostics: readonly string[];
}
export interface DependencyResult { readonly errors: readonly string[]; readonly warnings: readonly string[]; }
export async function functionalNamespaceProbe(): Promise<DependencyResult> {
  if (process.platform !== 'linux') return { errors: [], warnings: ['Target platform enforcement has not been verified.'] };
  try {
    await execute('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'], { timeout: 3000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    return { errors: [], warnings: [] };
  } catch (error) {
    const native = error as { stderr?: string; code?: string | number };
    // Only a fixed diagnostic summary is returned: never echo a process environment or run content.
    return { errors: [`Linux namespace probe failed (${String(native.code ?? 'UNKNOWN')}): ${String(native.stderr ?? '').trim().slice(0, 512)}`], warnings: [] };
  }
}

/** Dependencies plus a functional namespace probe are prerequisites, not proof of full-path enterprise protection. */
export function classifyCapability(dependencies: DependencyResult, namespace: DependencyResult, platform: NodeJS.Platform = process.platform): NativeCapability {
  const errors = [...dependencies.errors, ...namespace.errors];
  const warnings = [...dependencies.warnings, ...namespace.warnings];
  const diagnostics = [...errors, ...warnings];
  if (platform === 'win32') diagnostics.push('Windows native sandbox installation, WFP and ACL changes require explicit approval and are not performed by this module.');
  if (errors.length === 0) diagnostics.push('File/link race, raw TCP/UDP/IPv6, local socket, managed-range and every enabled tool path need real enforcement evidence; enterprise activation is denied.');
  return Object.freeze({
    state: errors.length ? 'unavailable' : 'partial', platform,
    processFilesystem: false, processNetwork: false, localSockets: false, managedRange: false,
    diagnostics: Object.freeze(diagnostics),
  });
}

export type EnterprisePath = 'shell' | 'local-script' | 'stdio-mcp' | 'ptc' | 'host-file' | 'browser' | 'model-http' | 'desktop-ipc';
const processPaths = new Set<EnterprisePath>(['shell', 'local-script', 'stdio-mcp']);
/** A subprocess sandbox never certifies direct Host I/O, browser partitions or desktop/model gateways. */
export function uncoveredPaths(enabled: readonly EnterprisePath[]): EnterprisePath[] {
  return [...new Set(enabled.filter(path => !processPaths.has(path)))];
}
