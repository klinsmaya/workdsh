import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { NativeSandboxBoundary, compileNativePolicy } from '../dist/index.js';
import { classifyCapability, uncoveredPaths } from '../dist/capability.js';
import { exactCommand } from '../dist/policy.js';
import { NativePreparationFailure, SrtBackend } from '../dist/backend.js';

const homes = [];
after(async () => { await Promise.all(homes.map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(id = 'run-a') {
  const home = await mkdtemp(join(tmpdir(), 'afos-d06-'));
  homes.push(home);
  const paths = Object.fromEntries(['input', 'workspace', 'tmp', 'runtime', 'host'].map(key => [key, join(home, key)]));
  await Promise.all(Object.values(paths).map(path => mkdir(path, { mode: 0o700 })));
  const executable = join(paths.runtime, 'fixed-tool');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(paths.input, 'source.txt'), 'approved source');
  await writeFile(join(paths.host, 'secret.txt'), 'synthetic forbidden secret');
  return { home, paths, executable, policy: { runId: id, inputRoot: paths.input, workspaceRoot: paths.workspace, tempRoot: paths.tmp, runtimeReadRoots: [paths.runtime], hostStateRoots: [paths.host], approvedExecutables: [executable], deadlineMs: 2000, maxOutputBytes: 1024, network: 'none' } };
}
const fakeFull = Object.freeze({ state: 'full', platform: 'linux', processFilesystem: true, processNetwork: true, localSockets: true, managedRange: true, diagnostics: ['Injected offline lifecycle fixture, not native enforcement evidence.'] });
function fakeBackend(events = [], options = {}) {
  return {
    async probe() { return options.capability ?? fakeFull; },
    async prepare(policy, command, signal) {
      events.push(['prepare', policy, command, signal]);
      if (options.prepare) return options.prepare(policy, command, signal);
      let closed = false;
      return Object.freeze({ argv: [policy.approvedExecutables[0]], env: policy.env, policyHash: policy.policyHash, async close() { if (!closed) { closed = true; events.push(['reset', policy.runId]); } } });
    },
  };
}
function fakeSubprocess(events = [], options = {}) {
  return {
    spawn(spec) {
      events.push(['spawn', spec]);
      options.onSpawn?.();
      const done = options.done ?? Promise.resolve({ exitCode: 0, signal: null });
      return {
        stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
        collected: { stdout: { readFrom: () => ({ text: 'draft', nextOffset: 5, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done,
        terminate() { events.push(['terminate']); options.terminate?.(); },
        async waitForExit() { events.push(['join']); return options.join?.() ?? true; },
      };
    },
  };
}
function code(expected) { return error => error?.code === expected; }
function deferred() { let resolve; let reject; const promise = new Promise((done, failed) => { resolve = done; reject = failed; }); return { promise, resolve, reject }; }
async function until(predicate) { for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'condition reached'); }

test('N01 immutable fixed policy denies reads by default and omits all ambient secrets and proxies', async () => {
  const f = await fixture();
  process.env.AFOS_NONCREDENTIAL_CANARY = 'synthetic-private-value';
  const policy = await compileNativePolicy(f.policy);
  assert.deepEqual(policy.srt.network.allowedDomains, []);
  assert.deepEqual(policy.srt.network.deniedDomains, ['*']);
  assert.equal(policy.srt.network.strictAllowlist, true);
  assert.equal(policy.srt.network.allowAllUnixSockets, false);
  assert.ok(policy.srt.filesystem.denyRead.includes('/'));
  assert.deepEqual(policy.srt.filesystem.allowWrite, [f.paths.workspace, f.paths.tmp]);
  assert.ok(policy.srt.filesystem.denyWrite.includes(f.paths.input));
  assert.equal(policy.env.HOME, f.paths.tmp);
  assert.equal(policy.env.AFOS_NONCREDENTIAL_CANARY, undefined);
  assert.equal(policy.env.HTTP_PROXY, undefined);
  assert.equal(policy.env.NODE_OPTIONS, undefined);
  f.policy.runtimeReadRoots.push('/');
  assert.equal(policy.runtimeReadRoots.length, 1);
  assert.throws(() => { policy.srt.filesystem.allowWrite.push('/'); }, TypeError);
  delete process.env.AFOS_NONCREDENTIAL_CANARY;
});

test('N02 policy rejects widened network, arbitrary env, malformed run IDs and overlapping Host regions', async () => {
  const f = await fixture();
  for (const input of [
    { ...f.policy, network: 'any' }, { ...f.policy, env: { API_KEY: 'synthetic' } },
    { ...f.policy, runId: 123 }, { ...f.policy, runId: undefined },
    { ...f.policy, runtimeReadRoots: [f.home] }, { ...f.policy, workspaceRoot: f.paths.input },
    { ...f.policy, maxOutputBytes: 1048577 }, { ...f.policy, runtimeReadRoots: ['/'] },
  ]) await assert.rejects(compileNativePolicy(input), code('POLICY_INVALID'));
});

test('N03 symlink, hardlink and nonregular run tree entries cannot expose unrelated input', async () => {
  const f = await fixture();
  const alias = join(f.paths.workspace, 'alias');
  await symlink(join(f.paths.host, 'secret.txt'), alias);
  await assert.rejects(compileNativePolicy(f.policy), code('POLICY_INVALID'));
  await rm(alias);
  await link(join(f.paths.host, 'secret.txt'), alias);
  await assert.rejects(compileNativePolicy(f.policy), code('POLICY_INVALID'));
  await rm(alias);
  const aliasRoot = join(f.home, 'input-alias');
  await symlink(f.paths.input, aliasRoot);
  await assert.rejects(compileNativePolicy({ ...f.policy, inputRoot: aliasRoot }), code('POLICY_INVALID'));
});

test('N04 SRT string API receives quoted exact argv and only a fixed approved executable', async () => {
  const f = await fixture();
  const policy = await compileNativePolicy(f.policy);
  const malicious = "'; $(printf stolen); `touch /unapproved` #";
  const command = exactCommand(policy, [f.executable, malicious, 'line\narg']);
  assert.equal(command, `exec '${f.executable}' '${malicious.replaceAll("'", "'\\''")}' 'line\narg'`);
  assert.throws(() => exactCommand(policy, ['/bin/bash', '-c', 'x']), code('POLICY_INVALID'));
  assert.throws(() => exactCommand(policy, [f.executable, '\0']), code('POLICY_INVALID'));
});

test('N05 dependencies or namespace errors are unavailable and even clean prerequisites remain partial', () => {
  assert.equal(classifyCapability({ errors: ['missing dependency'], warnings: [] }, { errors: [], warnings: [] }).state, 'unavailable');
  assert.equal(classifyCapability({ errors: [], warnings: [] }, { errors: ['uid map read-only'], warnings: [] }).state, 'unavailable');
  assert.equal(classifyCapability({ errors: [], warnings: [] }, { errors: [], warnings: [] }).state, 'partial');
  assert.equal(classifyCapability({ errors: [], warnings: ['missing seccomp'] }, { errors: [], warnings: [] }).state, 'partial');
  assert.equal(classifyCapability({ errors: [], warnings: [] }, { errors: [], warnings: [] }, 'win32').state, 'partial');
});

test('N06 unavailable, partial and uncovered/omitted tool inventories never reach process spawn', async () => {
  const f = await fixture();
  const events = [];
  for (const capability of [{ ...fakeFull, state: 'unavailable' }, { ...fakeFull, state: 'partial' }, { ...fakeFull, localSockets: false }]) {
    const boundary = new NativeSandboxBoundary(fakeSubprocess(events), fakeBackend(events, { capability }));
    await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell']), error => ['SANDBOX_UNAVAILABLE', 'SANDBOX_PARTIAL'].includes(error.code));
    await boundary.dispose();
  }
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events), fakeBackend(events));
  for (const paths of [[], ['shell', 'host-file'], ['ptc'], ['model-http'], ['desktop-ipc'], ['browser']]) {
    await assert.rejects(boundary.execute(f.policy, [f.executable], paths), code('SANDBOX_PARTIAL'));
  }
  assert.deepEqual(uncoveredPaths(['shell', 'local-script', 'stdio-mcp', 'host-file']), ['host-file']);
  assert.equal(events.length, 0);
  await boundary.dispose();
});

test('N07 official DSH handle settles and its managed range joins before isolated manager reset', async () => {
  const f = await fixture();
  const events = [];
  process.env.AFOS_NOT_A_TOKEN = 'synthetic-private-value';
  process.env.NODE_OPTIONS = '--trace-warnings';
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events), fakeBackend(events));
  const result = await boundary.execute(f.policy, [f.executable, 'draft'], ['local-script']);
  assert.equal(result.stdout, 'draft');
  const names = events.map(event => event[0]);
  assert.deepEqual(names, ['prepare', 'spawn', 'terminate', 'join', 'reset']);
  const spec = events.find(event => event[0] === 'spawn')[1];
  assert.ok(Object.hasOwn(spec.env, 'AFOS_NOT_A_TOKEN'));
  assert.equal(spec.env.AFOS_NOT_A_TOKEN, undefined);
  assert.equal(spec.env.NODE_OPTIONS, undefined);
  assert.equal(spec.cwd, f.paths.workspace);
  assert.deepEqual(spec.stdio, { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } });
  assert.equal(spec.env.HOME, f.paths.tmp);
  delete process.env.AFOS_NOT_A_TOKEN;
  delete process.env.NODE_OPTIONS;
  await boundary.dispose();
});

test('N08 two independent concurrent runs keep fixed policies and environments separate', async () => {
  const [a, b] = await Promise.all([fixture('run-a'), fixture('run-b')]);
  const events = [];
  const done = deferred();
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events, { done: done.promise }), fakeBackend(events));
  const first = boundary.execute(a.policy, [a.executable], ['shell']);
  const second = boundary.execute(b.policy, [b.executable], ['shell']);
  await until(() => events.filter(event => event[0] === 'spawn').length === 2);
  const prepared = events.filter(event => event[0] === 'prepare').map(event => event[1]);
  assert.equal(new Set(prepared.map(policy => policy.policyHash)).size, 2);
  assert.equal(new Set(prepared.map(policy => policy.env.HOME)).size, 2);
  assert.ok(prepared.every(policy => policy.srt.filesystem.allowRead.includes(policy.workspaceRoot)));
  assert.ok(prepared.every(policy => !policy.srt.filesystem.allowRead.includes(policy.runId === 'run-a' ? b.paths.workspace : a.paths.workspace)));
  done.resolve({ exitCode: 0, signal: null });
  await Promise.all([first, second]);
  await boundary.dispose();
});

test('N09 concurrent run cannot reuse a root or read another run through runtime dependencies', async () => {
  const [a, b] = await Promise.all([fixture('run-a'), fixture('run-b')]);
  const events = [];
  const done = deferred();
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events, { done: done.promise }), fakeBackend(events));
  const first = boundary.execute(a.policy, [a.executable], ['shell']);
  await until(() => events.some(event => event[0] === 'spawn'));
  await assert.rejects(boundary.execute(a.policy, [a.executable], ['shell']), code('RUN_REVOKED'));
  await assert.rejects(boundary.execute({ ...b.policy, workspaceRoot: a.paths.workspace }, [b.executable], ['shell']), code('POLICY_INVALID'));
  await assert.rejects(boundary.execute({ ...b.policy, runtimeReadRoots: [...b.policy.runtimeReadRoots, a.paths.workspace] }, [b.executable], ['shell']), code('POLICY_INVALID'));
  done.resolve({ exitCode: 0, signal: null });
  await first;
  await boundary.dispose();
});

test('N10 an abort during asynchronous policy compilation cannot later start a process', async () => {
  const f = await fixture();
  const events = [];
  const signal = new AbortController();
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events), fakeBackend(events));
  const run = boundary.execute(f.policy, [f.executable], ['shell'], signal.signal);
  signal.abort(new Error('cancelled during file inspection'));
  await assert.rejects(run, /cancelled/);
  assert.equal(events.length, 0);
  await boundary.dispose();
});

test('N11 dispose waits for a cancelled preparation and cleanup before completing', async () => {
  const f = await fixture();
  const events = [];
  const preparing = deferred();
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events), fakeBackend(events, { prepare: async policy => {
    await preparing.promise;
    return { argv: [f.executable], env: policy.env, policyHash: policy.policyHash, async close() { events.push(['reset']); } };
  } }));
  const run = boundary.execute(f.policy, [f.executable], ['shell']);
  const failure = assert.rejects(run);
  await until(() => events.some(event => event[0] === 'prepare'));
  let disposed = false;
  const dispose = boundary.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  preparing.resolve();
  await Promise.all([failure, dispose]);
  assert.equal(events.filter(event => event[0] === 'reset').length, 1);
  assert.equal(events.filter(event => event[0] === 'spawn').length, 0);
  await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell']), code('RUN_REVOKED'));
});

test('N12 unconfirmed managed-range cleanup retains roots and forbids lifting policy until recovery', async () => {
  const f = await fixture();
  const events = [];
  let quiet = false;
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events, { join: () => quiet }), fakeBackend(events));
  await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell']), code('CLEANUP_UNCONFIRMED'));
  assert.equal(events.filter(event => event[0] === 'reset').length, 0);
  await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell']), code('RUN_REVOKED'));
  await assert.rejects(boundary.dispose(), AggregateError);
  quiet = true;
  await boundary.dispose();
  assert.equal(events.filter(event => event[0] === 'reset').length, 1);
});

test('N13 failed SRT preparation retains its owned lease until reset is confirmed', async () => {
  const f = await fixture();
  const events = [];
  let resets = 0;
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events), fakeBackend(events, { prepare: async policy => {
    throw new NativePreparationFailure({ argv: [], env: policy.env, policyHash: policy.policyHash, async close() { if (++resets === 1) throw new Error('reset failed'); events.push(['reset']); } });
  } }));
  await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell']), /reset failed/);
  await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell']), code('RUN_REVOKED'));
  assert.equal(events.filter(event => event[0] === 'spawn').length, 0);
  await boundary.dispose();
  assert.equal(events.filter(event => event[0] === 'reset').length, 1);
});

test('N14 real public SRT dependency probe never claims native full enforcement', async () => {
  const result = await new SrtBackend().probe();
  assert.ok(['partial', 'unavailable'].includes(result.state));
  assert.equal(result.processFilesystem, false);
  assert.equal(result.processNetwork, false);
  const f = await fixture();
  const events = [];
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events));
  await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell']), error => ['SANDBOX_PARTIAL', 'SANDBOX_UNAVAILABLE'].includes(error.code));
  assert.equal(events.length, 0);
  await boundary.dispose();
});

test('N15 real manager serializes cleanup after dependency operation and replies with matching IDs', async () => {
  const worker = new Worker(new URL('../dist/manager-worker.js', import.meta.url), { env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  const replies = [];
  const exited = new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject); });
  worker.on('message', reply => { replies.push(reply); });
  worker.postMessage({ id: 91, kind: 'dependencies' });
  worker.postMessage({ id: 92, kind: 'close' });
  assert.equal(await exited, 0);
  assert.deepEqual(replies.map(reply => [reply.id, reply.kind]), [[91, 'ready'], [92, 'closed']]);
});

test('N16 a deadline reaches bounded range cleanup even when direct process outcome never settles', async () => {
  const f = await fixture();
  const events = [];
  let quiet = false;
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events, { done: new Promise(() => {}), join: () => quiet }), fakeBackend(events));
  const started = Date.now();
  await assert.rejects(boundary.execute({ ...f.policy, deadlineMs: 20 }, [f.executable], ['shell']), code('CLEANUP_UNCONFIRMED'));
  assert.ok(Date.now() - started < 1000);
  assert.ok(events.some(event => event[0] === 'terminate'));
  assert.ok(events.some(event => event[0] === 'join'));
  assert.equal(events.filter(event => event[0] === 'reset').length, 0);
  await assert.rejects(boundary.dispose(), AggregateError);
  quiet = true;
  await boundary.dispose();
});

test('N17 disposal cannot hang on a never-settling direct outcome or reset an unconfirmed range', async () => {
  const f = await fixture();
  const events = [];
  let quiet = false;
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events, { done: new Promise(() => {}), join: () => quiet }), fakeBackend(events));
  const run = boundary.execute(f.policy, [f.executable], ['shell']);
  const failed = assert.rejects(run, code('CLEANUP_UNCONFIRMED'));
  await until(() => events.some(event => event[0] === 'spawn'));
  const started = Date.now();
  await assert.rejects(boundary.dispose(), AggregateError);
  await failed;
  assert.ok(Date.now() - started < 1000);
  assert.equal(events.filter(event => event[0] === 'reset').length, 0);
  quiet = true;
  await boundary.dispose();
});

test('N18 synchronous spawn cancellation still handles a late direct-outcome rejection', async () => {
  const f = await fixture();
  const events = [];
  const signal = new AbortController();
  const done = deferred();
  const boundary = new NativeSandboxBoundary(fakeSubprocess(events, { done: done.promise, onSpawn: () => { signal.abort(new Error('cancelled during spawn')); } }), fakeBackend(events));
  await assert.rejects(boundary.execute(f.policy, [f.executable], ['shell'], signal.signal), /cancelled during spawn/);
  done.reject(new Error('late provider failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event[0] === 'reset').length, 1);
  await boundary.dispose();
});
