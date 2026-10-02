import { parentPort } from 'node:worker_threads';
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import type { CompiledNativePolicy } from './policy.js';

const port = parentPort;
if (!port) throw new Error('Sandbox manager requires an owned Worker.');
let used = false;
let sequence: Promise<void> = Promise.resolve();
const preparing = new AbortController();
port.on('message', (message: { id: number; kind: string; policy?: CompiledNativePolicy; command?: string }) => {
  if (message.kind === 'abort') { preparing.abort(); return; }
  // Cleanup queues behind initialization/wrap even when the caller cancels its wait.
  // Request IDs prevent a late prepared reply from satisfying a close request.
  sequence = sequence.then(async () => {
  try {
    if (message.kind === 'dependencies') {
      port.postMessage({ id: message.id, kind: 'ready', dependencies: await SandboxManager.checkDependenciesAsync() });
    } else if (message.kind === 'prepare' && message.policy && typeof message.command === 'string' && !used) {
      if (process.platform === 'win32') throw new Error('Windows initialization prohibited.');
      used = true;
      const policy = message.policy;
      await SandboxManager.initialize(SandboxRuntimeConfigSchema.parse(policy.srt));
      const prepared = await SandboxManager.wrapWithSandboxArgv(message.command, '/bin/bash', undefined, preparing.signal, policy.workspaceRoot);
      port.postMessage({ id: message.id, kind: 'prepared', argv: prepared.argv, env: prepared.env, policyHash: policy.policyHash });
    } else if (message.kind === 'close') {
      await SandboxManager.reset();
      port.postMessage({ id: message.id, kind: 'closed' });
      port.close();
    } else throw new Error('Invalid manager operation.');
  } catch { port.postMessage({ id: message.id, kind: 'error' }); }
  });
});
