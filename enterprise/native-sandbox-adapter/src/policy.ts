import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { SandboxRuntimeConfigSchema, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export type BoundaryCode = 'SANDBOX_UNAVAILABLE' | 'SANDBOX_PARTIAL' | 'POLICY_INVALID' | 'RUN_REVOKED' | 'CLEANUP_UNCONFIRMED';
export class NativeBoundaryError extends Error {
  constructor(readonly code: BoundaryCode, message: string) { super(message); this.name = 'NativeBoundaryError'; }
}
export interface NativeRunPolicy {
  readonly runId: string;
  readonly inputRoot: string;
  readonly workspaceRoot: string;
  readonly tempRoot: string;
  readonly runtimeReadRoots: readonly string[];
  readonly hostStateRoots: readonly string[];
  readonly approvedExecutables: readonly string[];
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
  readonly network: 'none';
}
export interface CompiledNativePolicy {
  readonly runId: string;
  readonly policyHash: string;
  readonly inputRoot: string;
  readonly workspaceRoot: string;
  readonly tempRoot: string;
  readonly runtimeReadRoots: readonly string[];
  readonly hostStateRoots: readonly string[];
  readonly approvedExecutables: readonly string[];
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
  readonly srt: Readonly<SandboxRuntimeConfig>;
}

export function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest));
}
export function overlaps(a: string, b: string): boolean { return within(a, b) || within(b, a); }
function invalid(message: string): never { throw new NativeBoundaryError('POLICY_INVALID', message); }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
async function canonical(path: unknown, directory: boolean): Promise<string> {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f*?\[\]{}~]/u.test(path)) invalid('Roots must be explicit absolute literal paths.');
  const resolved = resolve(path);
  if (resolved === parse(resolved).root) invalid('A filesystem root cannot be an allowed region.');
  const actual = await realpath(resolved).catch(() => invalid('A configured region does not exist.'));
  if (actual !== resolved) invalid('Configured regions must already be canonical, with no symlink or junction.');
  for (let current = resolved; current !== parse(current).root; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) invalid('A configured region has a symlink ancestor.');
  }
  const info = await lstat(actual);
  if (directory ? !info.isDirectory() : !info.isFile()) invalid('A configured region has the wrong file kind.');
  if (!directory && info.nlink !== 1) invalid('Executable hardlinks are not accepted.');
  return actual;
}
async function controlledTree(root: string): Promise<void> {
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const path = pending.pop()!;
    if (++count > 10000) invalid('A run tree exceeds the inspection limit.');
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) invalid('Run trees may only contain regular files and directories.');
    if (info.isFile() && info.nlink !== 1) invalid('Run trees cannot expose hardlinks to other files.');
    if (info.isDirectory()) for (const item of await readdir(path)) pending.push(resolve(path, item));
  }
}

/** Trusted Broker input only. This validation is not an OS enforcement claim or a material provenance check. */
export async function compileNativePolicy(input: NativeRunPolicy): Promise<CompiledNativePolicy> {
  const keys = ['runId', 'inputRoot', 'workspaceRoot', 'tempRoot', 'runtimeReadRoots', 'hostStateRoots', 'approvedExecutables', 'deadlineMs', 'maxOutputBytes', 'network'];
  if (!plain(input) || Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !(key in input))) invalid('The native policy has unknown or missing fields.');
  if (typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.runId)) invalid('Invalid run identifier.');
  if (input.network !== 'none') invalid('This adapter does not accept network grants.');
  if (!Number.isInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 3600000) invalid('Invalid task deadline.');
  if (!Number.isInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 1048576) invalid('Invalid output bound.');
  for (const roots of [input.runtimeReadRoots, input.hostStateRoots, input.approvedExecutables]) {
    if (!Array.isArray(roots) || roots.length === 0 || roots.length > 32) invalid('Bounded nonempty runtime, executable, and Host protection lists are required.');
  }
  const [inputRoot, workspaceRoot, tempRoot] = await Promise.all([input.inputRoot, input.workspaceRoot, input.tempRoot].map(path => canonical(path, true)));
  const runtimeReadRoots = [...new Set(await Promise.all(input.runtimeReadRoots.map(path => canonical(path, true))))].sort();
  const hostStateRoots = [...new Set(await Promise.all(input.hostStateRoots.map(path => canonical(path, true))))].sort();
  const approvedExecutables = [...new Set(await Promise.all(input.approvedExecutables.map(path => canonical(path, false))))].sort();
  const runRoots = [inputRoot!, workspaceRoot!, tempRoot!];
  for (let i = 0; i < runRoots.length; i++) for (let j = i + 1; j < runRoots.length; j++) {
    if (overlaps(runRoots[i]!, runRoots[j]!)) invalid('Input, workspace and temporary roots must be separate.');
  }
  for (const readable of [...runtimeReadRoots, ...runRoots]) {
    for (const protectedRoot of hostStateRoots) if (overlaps(readable, protectedRoot)) invalid('An allowed region overlaps protected Host state.');
  }
  for (const runtimeRoot of runtimeReadRoots) for (const runRoot of runRoots) {
    if (overlaps(runtimeRoot, runRoot)) invalid('Runtime dependencies cannot overlap a run region.');
  }
  for (const executable of approvedExecutables) {
    if (!runtimeReadRoots.some(root => within(root, executable))) invalid('Executables must come from a fixed read-only runtime region.');
  }
  await Promise.all(runRoots.map(controlledTree));
  const env = {
    PATH: [...new Set(approvedExecutables.map(dirname))].join(process.platform === 'win32' ? ';' : ':'),
    HOME: tempRoot!, TMPDIR: tempRoot!, TMP: tempRoot!, TEMP: tempRoot!, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  };
  const srt = SandboxRuntimeConfigSchema.parse({
    network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true, allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false, allowMachLookup: [] },
    filesystem: { denyRead: [parse(inputRoot!).root, ...hostStateRoots], allowRead: [...runtimeReadRoots, ...runRoots], allowWrite: [workspaceRoot, tempRoot], denyWrite: [inputRoot, ...runtimeReadRoots, ...hostStateRoots] },
    enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false, allowAppleEvents: false,
  });
  const data = { runId: input.runId, inputRoot: inputRoot!, workspaceRoot: workspaceRoot!, tempRoot: tempRoot!, runtimeReadRoots, hostStateRoots, approvedExecutables, deadlineMs: input.deadlineMs, maxOutputBytes: input.maxOutputBytes, env, srt };
  const policyHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return freeze({ ...data, policyHash });
}

/** Build a command for SRT's public string API without accepting a caller-selected shell or environment. */
export function exactCommand(policy: CompiledNativePolicy, argv: readonly string[]): string {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 128 || argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 65536)) invalid('Invalid exact argv.');
  if (!policy.approvedExecutables.includes(argv[0]!)) invalid('The executable is not approved for this run.');
  return `exec ${argv.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}`;
}
