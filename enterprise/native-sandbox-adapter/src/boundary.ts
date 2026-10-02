import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { compileNativePolicy, exactCommand, NativeBoundaryError, overlaps, type NativeRunPolicy } from './policy.js';
import { uncoveredPaths, type EnterprisePath, type NativeCapability } from './capability.js';
import { NativePreparationFailure, SrtBackend, type NativeBackend, type SandboxLease } from './backend.js';

export interface BoundaryResult {
  readonly runId: string;
  readonly policyHash: string;
  readonly outcome: SubprocessOutcome;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}
type ProcessService = Pick<SubprocessRuntime, 'spawn'>;
interface ActiveRange { roots: readonly string[]; runtimeRoots: readonly string[]; abort: AbortController; finished: Promise<void>; finish: () => void; handle?: SubprocessHandle; lease?: SandboxLease; }

async function outcomeOrAbort(done: Promise<SubprocessOutcome>, signal: AbortSignal): Promise<SubprocessOutcome> {
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { abort = () => { reject(signal.reason); }; });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  // Promise.race retains a rejection handler for done after cancellation, so a late provider
  // failure cannot become an unhandled rejection. The listener is removed on either branch.
  try { return await Promise.race([done, aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Consumes the existing DSH process service; no new tool, Agent or execution state engine is installed. */
export class NativeSandboxBoundary {
  private readonly ranges = new Map<string, ActiveRange>();
  private disposed = false;
  constructor(private readonly subprocess: ProcessService, private readonly backend: NativeBackend = new SrtBackend()) {}
  probe(): Promise<NativeCapability> { return this.backend.probe(); }

  assertCoverage(capability: NativeCapability, enabledPaths: readonly EnterprisePath[]): void {
    if (!Array.isArray(enabledPaths) || enabledPaths.length === 0 || enabledPaths.length > 8) throw new NativeBoundaryError('SANDBOX_PARTIAL', 'The enabled path inventory is required.');
    const uncovered = uncoveredPaths(enabledPaths);
    if (uncovered.length) throw new NativeBoundaryError('SANDBOX_PARTIAL', `Process confinement does not cover: ${uncovered.join(', ')}.`);
    if (capability.state === 'unavailable') throw new NativeBoundaryError('SANDBOX_UNAVAILABLE', 'Native enforcement is unavailable; unrestricted fallback is prohibited.');
    if (capability.state !== 'full' || !capability.processFilesystem || !capability.processNetwork || !capability.localSockets || !capability.managedRange) throw new NativeBoundaryError('SANDBOX_PARTIAL', 'Complete process enforcement has not been established; unrestricted fallback is prohibited.');
  }

  async execute(input: NativeRunPolicy, argv: readonly string[], enabledPaths: readonly EnterprisePath[], signal?: AbortSignal): Promise<BoundaryResult> {
    if (this.disposed) throw new NativeBoundaryError('RUN_REVOKED', 'Native boundary has been disposed.');
    signal?.throwIfAborted();
    const policy = await compileNativePolicy(input);
    // Reserve before awaiting probe/wrap, so two simultaneous calls cannot reuse a run or writable root.
    if (this.disposed || this.ranges.has(policy.runId)) throw new NativeBoundaryError('RUN_REVOKED', 'The run is inactive or already has a live invocation.');
    const roots = [policy.inputRoot, policy.workspaceRoot, policy.tempRoot];
    for (const active of this.ranges.values()) for (const a of roots) for (const b of active.roots) {
      if (overlaps(a, b)) throw new NativeBoundaryError('POLICY_INVALID', 'Live runs must not share input, workspace or temporary roots.');
    }
    for (const active of this.ranges.values()) {
      for (const runtime of policy.runtimeReadRoots) for (const root of active.roots) {
        if (overlaps(runtime, root)) throw new NativeBoundaryError('POLICY_INVALID', 'A run cannot expose another run through a runtime read grant.');
      }
      for (const runtime of active.runtimeRoots) for (const root of roots) {
        if (overlaps(runtime, root)) throw new NativeBoundaryError('POLICY_INVALID', 'A run region cannot overlap another live runtime read grant.');
      }
    }
    let finish!: () => void;
    const finished = new Promise<void>(resolveFinished => { finish = resolveFinished; });
    const active: ActiveRange = { roots, runtimeRoots: policy.runtimeReadRoots, abort: new AbortController(), finished, finish };
    this.ranges.set(policy.runId, active);
    const relay = (): void => { active.abort.abort(signal?.reason); };
    signal?.addEventListener('abort', relay, { once: true });
    if (signal?.aborted) relay();
    const timer = setTimeout(() => { active.abort.abort(new NativeBoundaryError('RUN_REVOKED', 'Run deadline reached.')); }, policy.deadlineMs);
    let quiescent = true;
    try {
      this.assertCoverage(await this.probe(), enabledPaths);
      active.abort.signal.throwIfAborted();
      const command = exactCommand(policy, argv);
      try { active.lease = await this.backend.prepare(policy, command, active.abort.signal); }
      catch (error) { if (error instanceof NativePreparationFailure) active.lease = error.lease; throw error; }
      active.abort.signal.throwIfAborted();
      if (active.lease.policyHash !== policy.policyHash) throw new NativeBoundaryError('POLICY_INVALID', 'Prepared policy identity mismatch.');
      // DSH providers merge a scrubbed ambient base. Explicit tombstones remove every ambient key
      // so a non-credential-looking secret or proxy cannot survive that merge.
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
      Object.assign(env, active.lease.env);
      const spec: SubprocessSpawnSpec = {
        argv: active.lease.argv, cwd: policy.workspaceRoot, env,
        stdio: { stdin: 'ignore', stdout: { maxBytes: policy.maxOutputBytes }, stderr: { maxBytes: policy.maxOutputBytes } },
        graceMs: 1000, signal: active.abort.signal,
      };
      active.handle = this.subprocess.spawn(spec);
      quiescent = false;
      const outcome = await outcomeOrAbort(active.handle.done, active.abort.signal);
      // A direct-child exit does not prove descendants have stopped. SRT reset cannot occur first.
      active.handle.terminate();
      quiescent = await active.handle.waitForExit(AbortSignal.timeout(5000));
      if (!quiescent) throw new NativeBoundaryError('CLEANUP_UNCONFIRMED', 'DSH could not confirm managed process-range quiescence.');
      const stdout = active.handle.collected.stdout?.readFrom(0);
      const stderr = active.handle.collected.stderr?.readFrom(0);
      return Object.freeze({ runId: policy.runId, policyHash: policy.policyHash, outcome, stdout: stdout?.text ?? '', stderr: stderr?.text ?? '', truncated: Boolean(stdout?.lossy || stderr?.lossy) });
    } finally {
      try {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
      if (active.handle && !quiescent) {
        active.handle.terminate();
        quiescent = await active.handle.waitForExit(AbortSignal.timeout(5000)).catch(() => false);
      }
      if (quiescent) {
        await active.lease?.close();
        this.ranges.delete(policy.runId);
      }
      // Keep the range and its isolated policy alive when cleanup cannot be proved. No new run
      // may reuse its roots; disposal/recovery must retry termination rather than lifting restrictions.
      if (!quiescent) throw new NativeBoundaryError('CLEANUP_UNCONFIRMED', 'Native range is still retained for cleanup.');
      } finally { active.finish(); }
    }
  }
  cancel(runId: string): void { this.ranges.get(runId)?.abort.abort(new NativeBoundaryError('RUN_REVOKED', 'Run cancelled.')); }
  async dispose(): Promise<void> {
    this.disposed = true;
    const failures: Error[] = [];
    const live = [...this.ranges.values()];
    for (const active of live) active.abort.abort();
    // One owner finishes invocation cleanup. Disposal cannot finish while a pending prepare
    // can still publish a lease or start a process after resources appear absent.
    await Promise.all(live.map(active => active.finished));
    for (const [id, active] of this.ranges) {
      active.abort.abort();
      active.handle?.terminate();
      if (active.handle && !await active.handle.waitForExit(AbortSignal.timeout(5000)).catch(() => false)) {
        failures.push(new NativeBoundaryError('CLEANUP_UNCONFIRMED', 'Native range is still retained for cleanup.'));
        continue;
      }
      try { await active.lease?.close(); this.ranges.delete(id); }
      catch { failures.push(new NativeBoundaryError('CLEANUP_UNCONFIRMED', 'Isolated manager cleanup remains unconfirmed.')); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native boundary cleanup remains unconfirmed.');
  }
}
