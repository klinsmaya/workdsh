#!/usr/bin/env node
// Keep optional native test dependencies and database files out of the product workspace.
import { cp, mkdir, mkdtemp, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('../', import.meta.url));
const sources = { 'model-adapter': join(bridge, '../model-adapter'), 'plugin-agent-bridge': bridge };
const output = await mkdtemp(join(tmpdir(), 'afos-sql-validation-'));
const evidence = join(output, 'evidence');
await mkdir(evidence);
console.log(`Isolated SQL evidence: ${evidence}`);
const names = new Set(['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.core.json', 'src', 'scripts']);
const hashes = {};
async function hashFiles(root, file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) throw Error('SQL validation source must not contain symbolic links');
  if (stat.isDirectory()) {
    for (const name of (await readdir(file)).sort()) await hashFiles(root, join(file, name));
  } else if (stat.isFile()) {
    hashes[relative(dirname(root), file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
}
for (const [name, source] of Object.entries(sources)) {
  const target = join(output, 'enterprise', name);
  await mkdir(target, { recursive: true });
  for (const child of (await readdir(source)).filter(name => names.has(name)).sort()) {
    await hashFiles(source, join(source, child));
    await cp(join(source, child), join(target, child), { recursive: true, errorOnExist: true, force: false });
  }
}
await writeFile(join(output, 'SOURCE_SHA256.json'), `${JSON.stringify(hashes, null, 2)}\n`);
const configFile = join(output, 'enterprise/plugin-agent-bridge/package.json');
const config = JSON.parse(await readFile(configFile, 'utf8'));
config.devDependencies = { ...config.devDependencies, sqlite3: '5.1.7' };
config.pnpm = { ...config.pnpm, onlyBuiltDependencies: ['sqlite3'] };
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
const env = {
  ...process.env,
  COREPACK_HOME: join(output, 'corepack'),
  XDG_CACHE_HOME: join(output, 'cache'),
  XDG_DATA_HOME: join(output, 'data'),
  XDG_CONFIG_HOME: join(output, 'config'),
  npm_config_cache: join(output, 'npm-cache'),
};
const store = `--store-dir=${join(output, 'pnpm-store')}`;
const registry = '--registry=https://registry.npmjs.org';
const results = [];
async function run(name, cwd, command, args) {
  const started = Date.now(), stdout = [], stderr = [];
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const status = await new Promise((resolve, reject) => {
    child.once('error', error => {
      stderr.push(Buffer.from(`${error.message}\n`));
      resolve({ code: 1, signal: null });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await writeFile(join(evidence, `${name}.stdout.txt`), Buffer.concat(stdout));
  await writeFile(join(evidence, `${name}.stderr.txt`), Buffer.concat(stderr));
  const result = { name, command: [command, ...args], cwd, exitCode: status.code,
    signal: status.signal, durationMs: Date.now() - started };
  results.push(result);
  await writeFile(join(evidence, 'RESULTS.json'), `${JSON.stringify({ node: process.version, platform: process.platform,
    architecture: process.arch, results }, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (status.code !== 0) {
    console.error(`SQL validation stopped; failed evidence remains in ${evidence}`);
    process.exit(status.code ?? 1);
  }
}
const modelRoot = join(output, 'enterprise/model-adapter');
const bridgeRoot = join(output, 'enterprise/plugin-agent-bridge');
await run('model-install', modelRoot, 'corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', store, registry]);
await run('model-build', modelRoot, 'corepack', ['pnpm', 'build']);
await run('bridge-install-with-test-driver', bridgeRoot, 'corepack', ['pnpm', 'install', '--no-frozen-lockfile', '--ignore-scripts', store, registry]);
await run('sqlite-driver-build', bridgeRoot, 'corepack', ['pnpm', 'rebuild', 'sqlite3', store]);
await run('bridge-build', bridgeRoot, 'corepack', ['pnpm', 'build']);
await run('sql-integration', bridgeRoot, process.execPath, ['--test', 'src/server/__tests__/sql-flow.integration.mjs']);
console.log(`SQL integration passed; retained source, generated lock and raw evidence: ${output}`);
