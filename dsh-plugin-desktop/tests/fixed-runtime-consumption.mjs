/** Reuse the reviewed real CLI/owner cases with a relocated fixed runtime.
 * Parent Main/IdP fixtures stay test-only. The child's runtime imports resolve
 * from the materialized graph; test stdin consumers are explicit, separate files.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { requireRuntime } from '../scripts/fixed-runtime-graph.mjs'
import { verifyFixedRuntime } from '../scripts/verify-fixed-runtime.mjs'
import { sha256 } from '../scripts/prepare-fixed-runtime.mjs'

const [source, runtime, expectedIntegritySha256, output, suite] = process.argv.slice(2)
requireRuntime(source && runtime && expectedIntegritySha256 && output && ['owner', 'core', 'public', 'personal'].includes(suite), 'test-arguments-refused')
const verified = verifyFixedRuntime({ root: runtime, expectedIntegritySha256 })
const require = createRequire(join(runtime, 'package.json')), executable = join(runtime, 'bin/node')
const cli = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const environment = { PATH: dirname(executable), LANG: 'C.UTF-8', DSH_TELEMETRY_DISABLED: '1' }
mkdirSync(output, { recursive: false, mode: 0o700 })
if (suite === 'personal') {
  const metadata = JSON.parse(readFileSync(join(runtime, 'fixed-runtime.json'), 'utf8'))
  const profile = join(output, 'profiles/workdsh'); mkdirSync(profile, { recursive: true, mode: 0o700 })
  symlinkSync(join(runtime, 'node_modules'), join(profile, 'node_modules'), 'dir')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'afos-personal-compose-test', private: true, type: 'module', dsh: {
    profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...metadata.personalBundles] } } }) + '\n')
  // Existing Source21 personal support order from prepare-workdsh-runtime, without
  // invoking its installer or activating a generic Web/Agent tree.
  const support = ['workdsh-provider-identity-local', 'workdsh-provider-browser-session', 'workdsh-plugin-audit', 'workdsh-plugin-access', 'workdsh-plugin-activity', 'workdsh-plugin-office', 'workdsh-bundle']
  const patches = support.flatMap(name => {
    const node = metadata.packages.find(node => node.name === name)
    requireRuntime(node, 'personal-support-provider-missing')
    const directory = join(runtime, node.path), pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return pkg.dsh?.bundle?.patch ? [readFileSync(join(directory, pkg.dsh.bundle.patch), 'utf8').trim()] : []
  })
  writeFileSync(join(profile, 'cordis.patch.yml'), patches.join('\n') + '\n')
  const result = spawnSync(executable, [cli, '--profile', 'workdsh', '--dump-config'], { cwd: output,
    env: { ...environment, HOME: output, DSH_HOME: output, TMPDIR: output }, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 ** 2 })
  writeFileSync(join(output, 'config.stdout.txt'), result.stdout ?? ''); writeFileSync(join(output, 'config.stderr.txt'), result.stderr ?? '')
  requireRuntime(result.status === 0, 'personal-public-composition-failed')
  for (const id of ['workdsh-identity-local', 'workdsh-access', 'workdsh-audit', 'workdsh-office']) requireRuntime(result.stdout.includes(`id: ${id}`), 'personal-support-composition-missing')
  console.log(JSON.stringify({ suite, publicCli: cli, bundles: metadata.personalBundles, originalBaseAndWeb: true,
    support, graphIntegritySha256: expectedIntegritySha256, execution: 'dump-config only; no Web/Agent activation',
    legacyMarketplaceAddons: 'not part of Source21 fixed graph or this test' }))
} else if (suite === 'public') {
  const result = spawnSync(executable, [cli, '--help'], { cwd: output, env: { ...environment, HOME: output, DSH_HOME: output, TMPDIR: output }, encoding: 'utf8', timeout: 20000 })
  writeFileSync(join(output, 'help.stdout.txt'), result.stdout ?? ''); writeFileSync(join(output, 'help.stderr.txt'), result.stderr ?? '')
  requireRuntime(result.status === 0 && result.stdout.includes('Usage:'), 'relocated-public-cli-help-failed')
  const native = verified.publicEntries.length && JSON.parse(readFileSync(join(runtime, 'fixed-runtime.json'), 'utf8')).packages.find(n => n.name === '@deepseek-ai/dsh-session-query-sqlite')
  requireRuntime(native, 'native-provider-missing')
  const nativeBinding = JSON.parse(readFileSync(join(runtime, 'fixed-runtime.json'), 'utf8')).packages.find(n => n.name === 'node-addon-require-builtin')
  requireRuntime(nativeBinding, 'native-binding-provider-missing')
  const code = `import {DatabaseSync} from 'node:sqlite';import {createRequire} from 'node:module';const binding=createRequire(${JSON.stringify(join(runtime, nativeBinding.path, 'package.json'))})('./').getBindingInfo();const require=createRequire(${JSON.stringify(join(runtime, native.path, 'package.json'))});const query=await import(require.resolve('./'));if(Object.keys(query).length===0)process.exit(3);const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE proof(value TEXT)');db.prepare('INSERT INTO proof VALUES (?)').run('relocated');if(db.prepare('SELECT value FROM proof').get().value!=='relocated')process.exit(2);db.close();console.log(JSON.stringify({node:process.version,modules:process.versions.modules,nativeBinding:binding,sqlite:'real-Node-SQLite-memory-db',officialQueryExports:Object.keys(query)}));`
  const probe = spawnSync(executable, ['--input-type=module', '-e', code], { cwd: output, env: { ...environment, HOME: output, TMPDIR: output }, encoding: 'utf8', timeout: 20000 })
  process.stdout.write(result.stdout); process.stdout.write(probe.stdout ?? ''); process.stderr.write(probe.stderr ?? '')
  requireRuntime(probe.status === 0, 'relocated-native-sqlite-failed')
  console.log(JSON.stringify({ suite, publicEntries: verified.publicEntries.length, enterpriseActivation: verified.enterpriseActivation }))
} else {
  const path = join(source, 'enterprise/plugin-agent-bridge/src/server/__tests__', suite === 'owner' ? 'cli-host.integration.mjs' : 'cli-ipc-flow.integration.mjs')
  const inputs = [{ path: path.slice(source.length + 1), sha256: sha256(path) }], edits = []
  let test = readFileSync(path, 'utf8')
  function change(before, after) {
    requireRuntime(test.includes(before) && test.split(before).length === 2, 'test-source-shape-changed')
    test = test.replace(before, after); edits.push({ before, after })
  }
  change("from './desktop-fixture.mjs'", `from ${JSON.stringify(pathToFileURL(join(source, 'enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs')).href)}`)
  if (suite === 'owner') {
    change("from '../../../../../dsh-plugin-desktop/src/enterprise-cli-host.ts'", `from ${JSON.stringify(pathToFileURL(join(source, 'dsh-plugin-desktop/src/enterprise-cli-host.ts')).href)}`)
    change("const runtimeProfile=fileURLToPath(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/',import.meta.url));", `const runtimeProfile=${JSON.stringify(resolve(runtime))};`)
    change('executable:process.execPath', `executable:${JSON.stringify(executable)}`)
  } else {
    change("from '../../../../../dsh-plugin-desktop/src/runtime-security.ts'", `from ${JSON.stringify(pathToFileURL(join(source, 'dsh-plugin-desktop/src/runtime-security.ts')).href)}`)
    for (const [name, entry] of [['main-ipc', 'main-ipc'], ['cli-profile', 'cli-profile']]) change(`from '../../../../../workdsh-web/packages/providers/enterprise-profile/dist/${name}.js'`, `from ${JSON.stringify(pathToFileURL(require.resolve(`workdsh-provider-enterprise-profile/${entry}`)).href)}`)
    change("const providerRoot=fileURLToPath(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/',import.meta.url));", `const providerRoot=${JSON.stringify(resolve(runtime))};`)
    for (const name of ['cli-bootstrap', 'cli-ready']) change(`join(providerRoot,'dist','${name}.js')`, JSON.stringify(require.resolve(`workdsh-provider-enterprise-profile/${name}`)))
    change("join(providerRoot,'tests','fixtures',core?'cli-core-consumer.mjs':'cli-read-consumer.mjs')", `join(${JSON.stringify(join(output, 'consumers'))},core?'cli-core-consumer.mjs':'cli-read-consumer.mjs')`)
    change('spawn(process.execPath,[cli', `spawn(${JSON.stringify(executable)},[cli`)
    mkdirSync(join(output, 'consumers'))
    // These existing test-only consumers value-import original public peers.
    // Match the product provider's resolver context rather than giving the test
    // plugin an invented global/second DSH installation.
    symlinkSync(join(dirname(require.resolve('workdsh-provider-enterprise-profile/package.json')), 'node_modules'), join(output, 'consumers/node_modules'), 'dir')
    for (const name of ['cli-core-consumer.mjs', 'cli-read-consumer.mjs']) {
      const input = join(source, 'workdsh-web/packages/providers/enterprise-profile/tests/fixtures', name)
      writeFileSync(join(output, 'consumers', name), readFileSync(input)); inputs.push({ path: input.slice(source.length + 1), sha256: sha256(input) })
    }
  }
  const copied = join(output, `${suite}.integration.mjs`)
  writeFileSync(copied, test)
  writeFileSync(join(output, 'TEST_INPUTS.json'), JSON.stringify({ inputs, edits, copiedSha256: sha256(copied), runtimeIntegritySha256: expectedIntegritySha256 }, null, 2) + '\n')
  // Existing Main server fixtures use TS parameter properties. Match the prior
  // headless test mode; the shipped original CLI itself remains plain JS.
  mkdirSync(join(output, 'tmp'), { mode: 0o700 })
  const result = spawnSync(executable, ['--experimental-transform-types', '--test', '--test-concurrency=1', copied], { cwd: output, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', TMPDIR: join(output, 'tmp'), DSH_TELEMETRY_DISABLED: '1' }, maxBuffer: 8 * 1024 ** 2 })
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
  requireRuntime(result.status === 0, `relocated-${suite}-suite-failed`)
}
