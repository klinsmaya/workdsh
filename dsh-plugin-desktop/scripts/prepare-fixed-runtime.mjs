/** Materialize one frozen public runtime graph. Does not install or run package hooks. */
import { createHash } from 'node:crypto'
import { copyFileSync, chmodSync, existsSync, globSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { contained, inspectFixedRuntimeGraph, readJson, requireRuntime } from './fixed-runtime-graph.mjs'
import { inspectOwnedRuntimeImports } from './fixed-runtime-imports.mjs'

export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
export const jsonFile = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
export const packageDirectory = (root, node) => join(root, 'node_modules/.fixed', node.id, 'node_modules', node.name)
const deniedName = name => name === 'node_modules' || name === '.git' || name === '.npmrc' || name.startsWith('.env') || name === '.yarnrc.yml'
function safeRelative(value) { return typeof value === 'string' && value !== '' && !value.includes('\\') && !value.startsWith('/') && value.split('/').every(p => p !== '..' && p !== '') }

/** Include package shipping roots, never source workspace configuration or caches. */
export function shippingPaths(node) {
  const selected = new Set(['package.json'])
  const add = part => {
    requireRuntime(safeRelative(part), 'shipping-path-refused')
    if (part.split('/').some(deniedName)) return
    const path = join(node.source, part), info = lstatSync(path)
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) add(`${part}/${name}`)
    else { requireRuntime(info.isFile() || info.isSymbolicLink(), 'shipping-file-kind-refused'); selected.add(part) }
  }
  if (node.firstParty) {
    requireRuntime(Array.isArray(node.manifest.files), 'first-party-shipping-list-missing')
    for (const pattern of node.manifest.files) {
      requireRuntime(safeRelative(pattern), 'shipping-pattern-refused')
      for (const part of globSync(pattern, { cwd: node.source }).sort()) add(part)
    }
    for (const name of readdirSync(node.source).sort()) if (/^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(name)) add(name)
  } else for (const name of readdirSync(node.source).sort()) if (!deniedName(name)) add(name)
  return [...selected].sort()
}
export function inventory(root) {
  const entries = []; let bytes = 0, visited = 0
  const walk = part => {
    const path = join(root, part), info = lstatSync(path)
    requireRuntime(++visited <= 250000 && part.split('/').length <= 64, 'payload-tree-budget-exceeded')
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(part ? `${part}/${name}` : name)
    else if (info.isSymbolicLink()) {
      const target = readlinkSync(path)
      requireRuntime(!target.startsWith('/') && contained(root, resolve(dirname(path), target)), 'link-escaped')
      requireRuntime(contained(root, realpathSync(path)), 'link-target-escaped')
      entries.push({ path: part, kind: 'link', target })
    } else {
      requireRuntime(info.isFile(), 'file-kind-refused')
      bytes += info.size
      requireRuntime(entries.length < 150000 && bytes <= 3 * 1024 ** 3 && info.size <= 256 * 1024 ** 2, 'payload-byte-budget-exceeded')
      entries.push({ path: part, kind: 'file', bytes: info.size, mode: info.mode & 0o777, sha256: sha256(path) })
    }
  }
  walk(''); return entries
}
function link(target, path) { mkdirSync(dirname(path), { recursive: true }); symlinkSync(relative(dirname(path), target), path, 'dir') }
function normalizedPackage(node) {
  const result = { ...node.manifest }
  delete result.devDependencies; delete result.scripts; delete result.packageManager; delete result.devEngines
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) if (result[field]) {
    result[field] = { ...result[field] }
    for (const [name, edge] of Object.entries(node.edges)) if (Object.hasOwn(result[field], name)) result[field][name] =
      result[field][name].startsWith('npm:') ? `npm:${edge.providerName}@${edge.version}` : edge.version
  }
  for (const [name, edge] of Object.entries(node.edges)) if (edge.supplementalRuntimeImport) {
    result.dependencies ??= {}
    result.dependencies[name] = edge.declared.startsWith('npm:') ? `npm:${edge.providerName}@${edge.version}` : edge.version
  }
  return result
}
export function prepareFixedRuntime({ source, manifestPath, nodeArchive, output }) {
  source = realpathSync(source); output = resolve(output)
  const manifest = readJson(manifestPath)
  requireRuntime(process.platform === 'linux' && process.arch === 'x64' && Boolean(process.report.getReport().header.glibcVersionRuntime), 'linux-glibc-x64-build-required')
  requireRuntime(!existsSync(output) && !contained(source, output), 'output-must-be-new-and-isolated')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' })
  requireRuntime(head.status === 0 && head.stdout.trim() === manifest.sourceRevision, 'source-head-mismatch')
  const clean = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8', timeout: 10000 })
  requireRuntime(clean.status === 0 && clean.stdout.trim() === '', 'source-tracked-changes-refused')
  requireRuntime(sha256(nodeArchive) === manifest.node.sha256, 'node-archive-hash-mismatch')
  const primaryLockPath = 'deepseek-harness/scripts/primary-runtime/lock.json', primaryLock = readJson(join(source, primaryLockPath))
  requireRuntime(primaryLock.nodeVersion === manifest.node.version && primaryLock.targets[manifest.target]?.nodeSha256 === manifest.node.sha256
    && manifest.node.url === `https://nodejs.org/dist/v${primaryLock.nodeVersion}/node-v${primaryLock.nodeVersion}-${primaryLock.targets[manifest.target].nodeArchive}`, 'upstream-node-reference-mismatch')
  const policyPaths = ['yarn.lock', 'workdsh-web/pnpm-lock.yaml', 'enterprise/model-adapter/pnpm-lock.yaml', 'deepseek-harness/pnpm-lock.yaml', 'workdsh-web/package.json', primaryLockPath]
  const policyInputs = policyPaths.map(path => ({ path, bytes: lstatSync(join(source, path)).size, sha256: sha256(join(source, path)) }))
  const overrides = readJson(join(source, 'workdsh-web/package.json')).pnpm?.overrides ?? {}
  const graph = inspectFixedRuntimeGraph({ source, manifest }), inputFiles = [], packageRecords = []
  let bytes = 0, files = 0
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  mkdirSync(output, { recursive: false, mode: 0o700 })
  for (const node of graph.nodes) {
    for (const file of node.runtimeImportFiles ?? []) requireRuntime(sha256(join(node.source, file.file)) === file.sha256, 'source-import-file-changed')
    const destination = packageDirectory(output, node), selected = shippingPaths(node)
    mkdirSync(destination, { recursive: true })
    const paths = new Set(selected)
    for (const part of selected) {
      const from = join(node.source, part), to = join(destination, part), info = lstatSync(from)
      mkdirSync(dirname(to), { recursive: true })
      if (info.isSymbolicLink()) {
        const target = readlinkSync(from), resolved = resolve(dirname(from), target)
        requireRuntime(!target.startsWith('/') && contained(node.source, resolved) && paths.has(relative(node.source, realpathSync(from))), 'package-link-target-not-shipped')
        symlinkSync(target, to); continue
      }
      bytes += info.size; files++
      requireRuntime(bytes <= 2 * 1024 ** 3 && files <= 150000 && info.size <= 256 * 1024 ** 2, 'shipping-budget-exceeded')
      inputFiles.push({ path: relative(source, from), bytes: info.size, sha256: sha256(from) })
      if (part === 'package.json') {
        requireRuntime(sha256(from) === node.sourcePackageSha256, 'package-metadata-changed')
        jsonFile(to, normalizedPackage(node))
      }
      else { copyFileSync(from, to); chmodSync(to, info.mode & 0o755) }
    }
    for (const [name, edge] of Object.entries(node.edges)) link(packageDirectory(output, graph.nodes.find(n => n.id === edge.id)), join(destination, 'node_modules', name))
    packageRecords.push({ id: node.id, name: node.name, version: node.version, path: relative(output, destination), edges: node.edges, optionalMissing: node.optionalMissing,
      ...(node.runtimeImports ? { runtimeImports: node.runtimeImports, dynamicRuntimeImports: node.dynamicRuntimeImports } : {}) })
  }
  for (const [name, id] of Object.entries(graph.roots)) link(packageDirectory(output, graph.nodes.find(n => n.id === id)), join(output, 'node_modules', name))
  // Public entry requirements that are transitive-only still have a fixed root provider.
  for (const name of ['@deepseek-ai/dsh-app-boot']) {
    const node = graph.nodes.find(n => n.name === name); requireRuntime(node, 'entry-provider-missing')
    link(packageDirectory(output, node), join(output, 'node_modules', name))
  }
  jsonFile(join(output, 'package.json'), { name: manifest.name, version: manifest.version, private: true, type: 'module', dependencies: { ...manifest.roots } })
  mkdirSync(join(output, 'bin')); const archiveRoot = `node-v${manifest.node.version}-${manifest.target}`
  const extracted = spawnSync('tar', ['-xzf', resolve(nodeArchive), '--strip-components=1', '-C', output, `${archiveRoot}/bin/node`, `${archiveRoot}/LICENSE`], { encoding: 'utf8', timeout: 30000 })
  requireRuntime(extracted.status === 0, 'node-selected-extract-failed')
  chmodSync(join(output, 'bin/node'), 0o755)
  const nodeVersion = spawnSync(join(output, 'bin/node'), ['--version'], { encoding: 'utf8', timeout: 10000 })
  requireRuntime(nodeVersion.status === 0 && nodeVersion.stdout.trim() === `v${manifest.node.version}`, 'packaged-node-version-mismatch')
  const metadata = { ...manifest, packages: packageRecords, roots: graph.roots, omitted: graph.omitted,
    sourceAliases: graph.sourceAliases.map(a => ({ ...a, source: relative(source, a.source) })) }
  jsonFile(join(output, 'fixed-runtime.json'), metadata)
  mkdirSync(join(output, 'audit'))
  jsonFile(join(output, 'audit/owned-runtime-imports.json'), inspectOwnedRuntimeImports(output, metadata))
  // Bounded chunks carry complete source-byte provenance without one huge Library leaf.
  for (let i = 0; i < inputFiles.length; i += 1000) jsonFile(join(output, 'audit', `source-${String(i / 1000).padStart(3, '0')}.json`), inputFiles.slice(i, i + 1000))
  jsonFile(join(output, 'audit/source-policy.json'), { sourceRevision: manifest.sourceRevision, buildNode: process.version,
    upstream: readJson(join(source, 'upstream.json')), nodeArchiveSha256: manifest.node.sha256,
    inputLocks: policyInputs.filter(input => input.path.endsWith('lock') || input.path.endsWith('lock.yaml')),
    policyInputs, overrides, inputFiles: inputFiles.length, inputBytes: bytes })
  // Detect source mutation during copying rather than signing a mixed revision.
  for (const file of inputFiles) requireRuntime(sha256(join(source, file.path)) === file.sha256, 'source-changed-during-materialization')
  for (const file of policyInputs) requireRuntime(sha256(join(source, file.path)) === file.sha256, 'source-policy-changed')
  const finalHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' })
  requireRuntime(finalHead.status === 0 && finalHead.stdout.trim() === manifest.sourceRevision, 'source-head-changed')
  const finalClean = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8', timeout: 10000 })
  requireRuntime(finalClean.status === 0 && finalClean.stdout.trim() === '', 'source-tracked-changes-during-build')
  const entries = inventory(output)
  const chunks = []
  for (let i = 0; i < entries.length; i += 1000) {
    const path = `audit/payload-${String(i / 1000).padStart(3, '0')}.json`
    jsonFile(join(output, path), entries.slice(i, i + 1000)); chunks.push({ path, sha256: sha256(join(output, path)), bytes: lstatSync(join(output, path)).size })
  }
  jsonFile(join(output, 'runtime-integrity.json'), { format: 1, chunks, entries: entries.length,
    payloadBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), enterpriseActivation: manifest.enterpriseActivation })
  return { output, packages: graph.nodes.length, files, inputBytes: bytes, integritySha256: sha256(join(output, 'runtime-integrity.json')) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, manifestPath, nodeArchive, output] = process.argv.slice(2)
  requireRuntime(source && manifestPath && nodeArchive && output && process.argv.length === 6, 'usage:source-manifest-archive-output')
  console.log(JSON.stringify(prepareFixedRuntime({ source, manifestPath, nodeArchive, output })))
}
