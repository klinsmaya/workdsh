import { Worker } from 'node:worker_threads';
import { NativeBoundaryError, type CompiledNativePolicy } from './policy.js';
import { classifyCapability, functionalNamespaceProbe, type DependencyResult, type NativeCapability } from './capability.js';

export interface SandboxLease {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly policyHash: string;
  close(): Promise<void>;
}
export interface NativeBackend {
  probe(): Promise<NativeCapability>;
  prepare(policy: CompiledNativePolicy, command: string, signal?: AbortSignal): Promise<SandboxLease>;
}
interface WorkerReply { id: number; kind: 'ready' | 'prepared' | 'closed' | 'error'; dependencies?: DependencyResult; argv?: string[]; env?: Record<string, string>; policyHash?: string; }
export class NativePreparationFailure extends NativeBoundaryError {
  constructor(readonly lease: SandboxLease) { super('CLEANUP_UNCONFIRMED', 'Sandbox preparation failed; owned manager cleanup must be confirmed.'); }
}

class WorkerClient {
  readonly worker: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: WorkerReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  resetConfirmed = false;
  constructor(env: Readonly<Record<string, string>>) {
    this.worker = new Worker(new URL('./manager-worker.js', import.meta.url), { env: { ...env } });
    this.worker.on('message', (reply: WorkerReply) => {
      if (reply.kind === 'closed') this.resetConfirmed = true;
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.kind === 'error') request.reject(new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'The isolated SRT manager failed.'));
      else request.resolve(reply);
    });
    this.worker.on('error', () => { this.fail(new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'The isolated SRT manager failed.')); });
    this.worker.on('exit', () => { this.closed = true; this.fail(new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'The isolated SRT manager exited.')); });
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async request(message: object, signal?: AbortSignal): Promise<WorkerReply> {
    if (this.closed) throw new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'Invalid isolated manager lifecycle.');
    signal?.throwIfAborted();
    const id = ++this.sequence;
    const rejectRequest = (error: Error): void => {
      const pending = this.pending.get(id);
      if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error); }
    };
    const abort = (): void => {
      this.worker.postMessage({ id: ++this.sequence, kind: 'abort' });
      rejectRequest(new NativeBoundaryError('RUN_REVOKED', 'Sandbox preparation was cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise<WorkerReply>((resolve, reject) => {
        const timer = setTimeout(() => { rejectRequest(new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'Isolated manager response timed out.')); }, 10000);
        this.pending.set(id, { resolve, reject, timer });
        this.worker.postMessage({ ...message, id });
        if (signal?.aborted) abort();
      });
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async terminate(): Promise<void> { if (!this.closed) { this.closed = true; await this.worker.terminate(); } }
}

/** Internal SRT backend. Capability remains partial until real complete enforcement is established. */
export class SrtBackend implements NativeBackend {
  async probe(): Promise<NativeCapability> {
    // Windows probe is read-only; never initialize, stamp ACLs, install a user, WFP service or CA.
    const client = new WorkerClient({ PATH: process.platform === 'win32' ? '' : '/usr/local/bin:/usr/bin:/bin', LANG: 'C' });
    try {
      const [reply, namespace] = await Promise.all([client.request({ kind: 'dependencies' }), functionalNamespaceProbe()]);
      return classifyCapability(reply.dependencies ?? { errors: ['SRT dependency reply missing.'], warnings: [] }, namespace);
    } catch {
      return classifyCapability({ errors: ['SRT dependency probe failed.'], warnings: [] }, { errors: [], warnings: [] });
    } finally { await client.terminate(); }
  }
  async prepare(policy: CompiledNativePolicy, command: string, signal?: AbortSignal): Promise<SandboxLease> {
    if (process.platform === 'win32') throw new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'Windows native sandbox setup has not been authorized and verified.');
    const client = new WorkerClient(policy.env);
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closePromise) closePromise = (async () => {
        if (!client.resetConfirmed) {
          const reply = await client.request({ kind: 'close' });
          if (reply.kind !== 'closed') throw new NativeBoundaryError('CLEANUP_UNCONFIRMED', 'SRT reset was not confirmed.');
        }
        await client.terminate();
      })().catch(error => { closePromise = undefined; throw error; });
      return closePromise;
    };
    const retainedLease: SandboxLease = Object.freeze({ argv: Object.freeze([]), env: policy.env, policyHash: policy.policyHash, close });
    try {
      const reply = await client.request({ kind: 'prepare', policy, command }, signal);
      if (reply.kind !== 'prepared' || !reply.argv || !reply.env || reply.policyHash !== policy.policyHash) throw new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'Isolated manager returned an invalid prepared descriptor.');
      return Object.freeze({
        argv: Object.freeze([...reply.argv]), env: Object.freeze({ ...reply.env }), policyHash: policy.policyHash,
        close,
      });
    } catch { throw new NativePreparationFailure(retainedLease); }
  }
}
