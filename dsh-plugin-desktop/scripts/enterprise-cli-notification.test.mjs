import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EnterpriseCliHost } from '../src/enterprise-cli-host.ts';
import { fixture } from '../../enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs';

const realProfile = process.env.AFOS_TEST_RUNTIME_PROFILE ?? fileURLToPath(new URL('../../workdsh-web/packages/providers/enterprise-profile/', import.meta.url));
const model = { provider: 'afos-managed', model: 'fixed-model', maxTokens: 64 };
async function wait(predicate) { for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('bounded lifecycle observation timed out'); }
async function composed(t, { runtimeProfile = realProfile, failReady = false } = {}) {
  const notifications = [], owner = new EnterpriseCliHost({ executable: process.execPath, runtimeProfile, model, onUnexpectedStop: async () => { notifications.push('unexpected'); }, writeLog() {} });
  const f = await fixture({ stopHost: () => owner.stop() }); t.after(() => f.cleanup()); await f.ready(); f.capability({ ingressValidated: true, sandbox: 'full' });
  let calls = 0;
  f.startHook((signal, layout, authority, business) => owner.start(layout, authority, signal, failReady ? { ...business, currentAuthority: async signal => { if (++calls === 2) throw Error('fixture-before-ready'); return business.currentAuthority(signal); } } : business));
  return { ...f, owner, notifications };
}
test('real original CLI intentional owner stop emits no unexpected event', { timeout: 15000 }, async t => {
  const f = await composed(t); await f.main.startHost(); assert.ok(f.owner.processId()); await f.owner.stop(); assert.equal(f.owner.processId(), undefined); assert.deepEqual(f.notifications, []);
});
test('real original CLI kill with exit+disconnect reports unexpected stop exactly once after readiness', { timeout: 15000 }, async t => {
  const f = await composed(t); await f.main.startHost(); process.kill(f.owner.processId(), 'SIGTERM'); await wait(() => f.owner.processId() === undefined); assert.deepEqual(f.notifications, ['unexpected']);
});
test('real original CLI failed handshake before readiness never reports an established Host stop', { timeout: 15000 }, async t => {
  const f = await composed(t, { failReady: true }); await assert.rejects(f.main.startHost(), /cli-host-refused/); assert.equal(f.owner.processId(), undefined); assert.deepEqual(f.notifications, []);
});
test('original CLI natural process exit after public appReady emits once; only test plugin asks to exit', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'afos-cli-natural-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'runtime'), modules = join(runtime, 'node_modules'); await mkdir(modules, { recursive: true }); await writeFile(join(runtime, 'package.json'), '{"type":"module"}\n');
  // A fixture package delegates the exact public managed Profile and Main IPC. It only adds a
  // Cordis appReady consumer which exits this test child. No production tree or loader is copied.
  for (const entry of await readdir(join(realProfile, 'node_modules'))) if (!['workdsh-provider-enterprise-profile', '@deepseek-ai'].includes(entry)) await symlink(join(realProfile, 'node_modules', entry), join(modules, entry), 'dir');
  await mkdir(join(modules, '@deepseek-ai'));
  for (const entry of await readdir(join(realProfile, 'node_modules', '@deepseek-ai'))) await symlink(join(realProfile, 'node_modules', '@deepseek-ai', entry), join(modules, '@deepseek-ai', entry), 'dir');
  const provider = join(modules, 'workdsh-provider-enterprise-profile'); await mkdir(provider);
  await writeFile(join(provider, 'package.json'), JSON.stringify({ name: 'workdsh-provider-enterprise-profile', type: 'module', exports: { './cli-profile': './cli-profile.mjs', './main-ipc': './main-ipc.mjs' } }));
  const require = createRequire(join(realProfile, 'package.json')), cliModule = require.resolve('workdsh-provider-enterprise-profile/cli-profile'), ipcModule = require.resolve('workdsh-provider-enterprise-profile/main-ipc');
  await symlink(dirname(require.resolve('@deepseek-ai/dsh/package.json')), join(modules, '@deepseek-ai', 'dsh'), 'dir');
  const plugin = join(directory, 'exit-fixture.mjs'); await writeFile(plugin, "export const name='afos-test-natural-exit';export const inject=['appReady'];export function apply(ctx){ctx.effect(()=>ctx.appReady.onReady(()=>{const timer=setTimeout(()=>process.exit(0),200);return()=>clearTimeout(timer);}));}\n");
  await writeFile(join(provider, 'cli-profile.mjs'), `import {managedCliProfilePatch as original} from ${JSON.stringify(pathToFileURL(cliModule).href)};export function managedCliProfilePatch(options){const patch=original(options);patch[0].insert[0].config.push({id:'afos-test-natural-exit',name:${JSON.stringify(pathToFileURL(plugin).href)}});return patch;}\n`);
  await writeFile(join(provider, 'main-ipc.mjs'), `export {attachMainBusinessIpc,CORE_READY_IPC_VERSION} from ${JSON.stringify(pathToFileURL(ipcModule).href)};\n`);
  const f = await composed(t, { runtimeProfile: runtime }); await f.main.startHost(); await wait(() => f.owner.processId() === undefined); assert.deepEqual(f.notifications, ['unexpected']);
});
