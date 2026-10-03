import type { Context } from '@deepseek-ai/cordis';
import type {} from './native-ws-http-admission.js';

/** One definition-owned RPC invocation, never an Agent or tool lifetime. */
export interface RpcCallerGuard {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  assertFresh(): Promise<void>;
  wait<T>(operation: () => Promise<T>): Promise<T>;
  complete<T>(value: T): Promise<T>;
}

/** Physical HTTP already passed original Connection and Main admission. Private
 * in-process calls have no physical caller, and retain their existing authority. */
export function captureRpcCaller(ctx: Context, callerSignal: AbortSignal): RpcCallerGuard {
  const proof = ctx.get('afosNativeHttpProof')?.current();
  const signal = proof ? AbortSignal.any([callerSignal, proof.signal]) : callerSignal;
  const assertCurrent = () => { signal.throwIfAborted(); proof?.assertCurrent(); };
  const assertFresh = async () => {
    assertCurrent();
    if (proof) await proof.assertFresh(signal);
    assertCurrent();
  };
  return Object.freeze({ signal, assertCurrent, assertFresh,
    async wait<T>(operation: () => Promise<T>): Promise<T> {
      await assertFresh();
      const value = await operation();
      await assertFresh();
      return value;
    },
    async complete<T>(value: T): Promise<T> { await assertFresh(); return value; },
  });
}
