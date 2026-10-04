import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EnterpriseCliHost } from '../src/enterprise-cli-host.ts';
import { accountNamespace } from '../src/desktop-auth.ts';
import { fixture } from '../../enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs';

const realProfile = process.env.AFOS_TEST_RUNTIME_PROFILE ?? fileURLToPath(new URL('../../workdsh-web/packages/providers/enterprise-profile/', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate) { for (let n = 0; n < 500; n++) { if (predicate()) return; await delay(10); } throw Error('bounded log observation timed out'); }
async function composed(t, source, { removeCore = false, capability = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'afos-cli-log-'));
  // Only this owned fixture is removed. Original runtimes and failed-repro evidence are retained.
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'runtime'), modules = join(runtime, 'node_modules');
  await mkdir(modules, { recursive: true }); await writeFile(join(runtime, 'package.json'), '{"type":"module"}\n');
  for (const entry of await readdir(join(realProfile, 'node_modules'))) if (!['workdsh-provider-enterprise-profile', '@deepseek-ai', '.bin', '.cache', '.pnpm'].includes(entry)) await symlink(join(realProfile, 'node_modules', entry), join(modules, entry), 'dir');
  await mkdir(join(modules, '@deepseek-ai'));
  for (const entry of await readdir(join(realProfile, 'node_modules', '@deepseek-ai'))) await symlink(join(realProfile, 'node_modules', '@deepseek-ai', entry), join(modules, '@deepseek-ai', entry), 'dir');
  const require = createRequire(join(realProfile, 'package.json'));
  await symlink(dirname(require.resolve('@deepseek-ai/dsh/package.json')), join(modules, '@deepseek-ai', 'dsh'), 'dir');
  const cliModule = require.resolve('workdsh-provider-enterprise-profile/cli-profile'), ipcModule = require.resolve('workdsh-provider-enterprise-profile/main-ipc');
  const provider = join(modules, 'workdsh-provider-enterprise-profile'); await mkdir(provider);
  await writeFile(join(provider, 'package.json'), JSON.stringify({ name: 'workdsh-provider-enterprise-profile', type: 'module', exports: { './cli-profile': './cli-profile.mjs', './main-ipc': './main-ipc.mjs' } }));
  const plugin = join(directory, 'log-fixture.mjs'); await writeFile(plugin, source);
  await writeFile(join(provider, 'cli-profile.mjs'), `import {managedCliProfilePatch as original} from ${JSON.stringify(pathToFileURL(cliModule).href)};export function managedCliProfilePatch(options){const patch=original(options);const group=patch[0].insert[0];${removeCore ? "group.config=group.config.filter(p=>p.id!=='afos-cli-core');" : ''}group.config.push({id:'afos-test-log-boundary',name:${JSON.stringify(pathToFileURL(plugin).href)}});return patch;}\n`);
  await writeFile(join(provider, 'main-ipc.mjs'), `export {attachMainBusinessIpc${capability ? ',CORE_READY_IPC_VERSION' : ''}} from ${JSON.stringify(pathToFileURL(ipcModule).href)};\n`);
  let log = '', notifications = 0;
  const owner = new EnterpriseCliHost({ executable: process.execPath, runtimeProfile: runtime, model: { provider: 'afos-managed', model: 'fixed-model', maxTokens: 64 },
    writeLog(text) { assert(log.length + text.length < 65536); log += text; }, onUnexpectedStop: async () => { notifications++; } });
  const f = await fixture({ stopHost: () => owner.stop() }); t.after(() => f.cleanup());
  const binding = { issuer: f.config.auth.issuer, subject: 'alice', organizationId: 'org1', deviceId: 'device1' };
  await f.vault.save(accountNamespace(binding.issuer, binding.subject, binding.organizationId, binding.deviceId), 'controlled-refresh-seed');
  await f.main.restoreAccount(binding, 'p1');
  // Controlled Host capability isolates this engineering pipeline; it asserts no OS containment.
  f.capability({ ingressValidated: true, sandbox: 'full' });
  f.startHook((signal, layout, authority, business) => owner.start(layout, authority, signal, business));
  return { ...f, owner, log: () => log, notifications: () => notifications };
}
const secret = { ready: 'AFOS_SYNTH_READY_29', code: 'AFOS_SYNTH_CODE_29', verifier: 'AFOS_SYNTH_VERIFIER_29', cookie: 'AFOS_SYNTH_COOKIE_29', password: 'AFOS_SYNTH_PASSWORD_29', api: 'AFOS_SYNTH_API_29' };
// Keep the exact prior producer sequence: a 20ms-yield inside ?token overlaps appReady.
// Before this fix the core's stdout marker inserted a newline between '?to' and 'ken'.
const oldRepro = `export const name='afos-controlled-log-probe';export const inject=['appReady'];export function apply(ctx){ctx.effect(()=>ctx.appReady.onReady(()=>{let cancelled=false;void(async()=>{process.stdout.write('AFOS_PIPELINE_PUBLIC_START_29\\n');process.stdout.write('dsh web: http://127.0.0.1:41019/?to');await new Promise(r=>setTimeout(r,20));if(cancelled)return;process.stdout.write('ken=${secret.ready}\\n');process.stdout.write('OAuth callback http://127.0.0.1:41020/oauth/callback?code=${secret.code}&code_verifier=${secret.verifier}\\n');console.error(new Error('controlled pipeline failure password=${secret.password} api_key=${secret.api}'));process.stderr.write('cookie=session=${secret.cookie}');process.stdout.write('AFOS_PIPELINE_PUBLIC_END_29\\n');})();return()=>{cancelled=true;};}));}\n`;
test('original CLI private ready preserves the old interleaved token record and redacts both real log streams', { timeout: 15000 }, async t => {
  const f = await composed(t, oldRepro); await f.main.startHost(); assert.ok(f.owner.processId());
  await wait(() => f.log().includes('AFOS_PIPELINE_PUBLIC_END_29')); await f.main.suspend();
  const log = f.log(); for (const value of Object.values(secret)) assert.ok(!log.includes(value), 'synthetic secret reached owner log sink');
  assert.ok(log.includes('AFOS_PIPELINE_PUBLIC_START_29') && log.includes('AFOS_PIPELINE_PUBLIC_END_29'));
  assert.ok(log.includes('?token=[REDACTED]') && log.includes('code=[REDACTED]') && log.includes('code_verifier=[REDACTED]'));
  assert.ok(log.includes('password=[REDACTED]') && log.includes('api_key=[REDACTED]') && log.includes('[REDACTED COOKIE]'));
  assert.ok(!log.includes('AFOS_CLI_READY v1')); assert.equal(f.owner.processId(), undefined); assert.equal(f.notifications(), 0);
  assert.ok(!f.calls.some(v => /authorizeLocal|model|commitDraft/.test(v))); assert.equal(f.tables.artifacts.size, 0);
});
const fragmented = `export const name='afos-test-fragmented-log';export const inject=['appReady'];export function apply(ctx){ctx.effect(()=>ctx.appReady.onReady(()=>{void Promise.all([new Promise(done=>setImmediate(()=>{for(let i=0;i<20;i++)process.stdout.write('PUBLIC_OUT_'+i+'\\n');done();})),new Promise(done=>setImmediate(()=>{for(let i=0;i<20;i++)process.stderr.write('PUBLIC_ERR_'+i+'\\n');done();}))]).then(async()=>{for(const stream of [process.stdout,process.stderr]){const line='diagnostic token=AFOS_SYNTH_FRAGMENT password=AFOS_SYNTH_FRAGMENT_PASSWORD\\n';for(let i=0;i<line.length;i++){stream.write(line[i]);if(i%7===0)await new Promise(r=>setTimeout(r,1));}}process.stdout.write('FRAGMENTS_COMPLETE\\n');});}));}\n`;
test('concurrent original ready and complete log records preserve normal lines and redact fragmented fields', { timeout: 15000 }, async t => {
  const f = await composed(t, fragmented); await f.main.startHost(); await wait(() => f.log().includes('FRAGMENTS_COMPLETE')); await f.main.suspend();
  const log = f.log(); for (const stream of ['OUT', 'ERR']) for (let i = 0; i < 20; i++) assert.ok(log.includes(`PUBLIC_${stream}_${i}\n`));
  assert.equal(log.match(/diagnostic token=\[REDACTED\] password=\[REDACTED\]/g)?.length, 2);
  assert.ok(!log.includes('AFOS_SYNTH_FRAGMENT')); assert.equal(f.notifications(), 0); assert.equal(f.owner.processId(), undefined);
});
const fakeReady = "export const name='afos-test-fake-ready-log';export const inject=['appReady'];export function apply(ctx){ctx.effect(()=>ctx.appReady.onReady(()=>{process.stdout.write('AFOS_CLI_READY v1\\n');}));}\n";
test('a stdout marker cannot admit an original CLI without core IPC readiness', { timeout: 15000 }, async t => {
  const f = await composed(t, fakeReady, { removeCore: true }); let settled = false;
  const started = f.main.startHost().finally(() => { settled = true; }); const refused = assert.rejects(started, /cli-host-refused/);
  await wait(() => f.log().includes('AFOS_CLI_READY v1')); await delay(100); assert.equal(settled, false);
  await f.main.suspend(); await refused; assert.equal(f.owner.processId(), undefined); assert.equal(f.notifications(), 0);
});
test('a runtime without the paired IPC capability fails before spawn', { timeout: 15000 }, async t => {
  const f = await composed(t, fakeReady, { capability: false }); await assert.rejects(f.main.startHost(), /cli-host-refused/);
  assert.equal(f.owner.processId(), undefined); assert.equal(f.log(), ''); assert.equal(f.notifications(), 0);
});
