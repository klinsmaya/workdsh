// Reproduction of the read-only public API probe. Run from workdsh-web.
// Fixture output is evidence only; it does not establish an AFOS AT PASS.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';

const pkg = (await readdir('node_modules/.pnpm')).find(name => name.startsWith('@deepseek-ai+dsh-client-connection@'));
assert.ok(pkg, 'The pinned published Connection package must be installed.');
const { HostConnectionService } = await import(pathToFileURL(process.cwd() + '/node_modules/.pnpm/' + pkg + '/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js').href);
const connectionCtx = new Context();
try {
  const connection = new HostConnectionService(connectionCtx, [], { isAuthenticated() { return true; } });
  connection.rpc.intercept('/api', () => true, async () => ({ ok: true, value: {} }));
  assert.throws(() => connection.rpc.intercept('/api', () => true, async () => ({ ok: true, value: {} })), /already has an interceptor/u);
  console.log(JSON.stringify({ probe: 'official HostConnectionService sole shared interceptor', result: 'PASS' }));
} finally {
  await connectionCtx.fiber.dispose();
}

async function run(fuseAtInput) {
  const ctx = new Context();
  try {
    ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
    await ctx.plugin(Tools);
    const caller = new AbortController();
    const authority = new AbortController();
    let effects = 0;
    ctx.tools.register({
      name: 'afos_boundary_probe', description: 'Offline guard signal probe.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render() { return []; } },
      async execute() { effects++; return {}; },
    });
    ctx.on('tools/execute', async (exec, next) => {
      const previous = exec.signal;
      exec.signal = AbortSignal.any([exec.signal, authority.signal]);
      try { return await next(); } finally { exec.signal = previous; }
    });
    ctx.on('tools/execute', async (exec, next) => {
      const previous = exec.signal;
      exec.signal = new AbortController().signal;
      authority.abort();
      try { return await next(); } finally { exec.signal = previous; }
    });
    const result = await ctx.tools.execute({
      name: 'afos_boundary_probe', callId: 'probe-' + fuseAtInput, arguments: {},
      signal: fuseAtInput ? AbortSignal.any([caller.signal, authority.signal]) : caller.signal,
    });
    assert.equal(effects, fuseAtInput ? 0 : 1);
    assert.equal(result.isError, fuseAtInput);
    console.log(JSON.stringify({
      probe: fuseAtInput ? 'authority fused in captured caller signal' : 'authority only in replaceable wrapper signal',
      effects, isError: result.isError, result: fuseAtInput ? 'PASS' : 'BYPASS_CONFIRMED', errorCode: result.error?.info?.code,
    }));
  } finally {
    await ctx.fiber.dispose();
  }
}
await run(false);
await run(true);
