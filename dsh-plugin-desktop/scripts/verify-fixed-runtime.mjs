/** Verify a relocated fixed runtime using only public package resolution and bytes. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, globSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contained, readJson, requireRuntime } from './fixed-runtime-graph.mjs'
import { inventory, sha256 } from './prepare-fixed-runtime.mjs'

export function verifyFixedRuntime({ root, expectedIntegritySha256 }) {
  root = realpathSync(root)
  const boundedMetadata = (path, maximum, expectedHash, expectedBytes, mismatch = 'chunk-integrity-mismatch') => {
    const info = lstatSync(path); requireRuntime(info.isFile() && info.size <= maximum, 'metadata-file-refused')
    let descriptor
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(descriptor)
      requireRuntime(opened.isFile() && opened.size <= maximum, 'metadata-file-refused')
      // Even if another process grows the opened file after fstat, read at most
      // maximum+1 bytes. A link substitution cannot redirect a NOFOLLOW fd.
      const bytes = Buffer.alloc(maximum + 1); let size = 0
      while (size < bytes.length) {
        const count = readSync(descriptor, bytes, size, bytes.length - size, null)
        if (!count) break
        size += count
      }
      requireRuntime(size <= maximum && size === opened.size, 'metadata-file-refused')
      const data = bytes.subarray(0, size)
      if (expectedBytes !== undefined) requireRuntime(size === expectedBytes, mismatch)
      if (expectedHash !== undefined) requireRuntime(createHash('sha256').update(data).digest('hex') === expectedHash, mismatch)
      return JSON.parse(data.toString('utf8'))
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  requireRuntime(typeof expectedIntegritySha256 === 'string' && /^[0-9a-f]{64}$/u.test(expectedIntegritySha256), 'integrity-anchor-required')
  const integrity = boundedMetadata(join(root, 'runtime-integrity.json'), 128 * 1024, expectedIntegritySha256, undefined, 'integrity-anchor-mismatch')
  const metadata = boundedMetadata(join(root, 'fixed-runtime.json'), 8 * 1024 ** 2)
  requireRuntime(integrity.format === 1 && metadata.format === 1 && metadata.target === 'linux-x64', 'integrity-format-refused')
  requireRuntime(metadata.enterpriseActivation.ingressValidated === false && metadata.enterpriseActivation.sandbox === 'unavailable', 'activation-must-remain-refused')
  requireRuntime(metadata.packages.length <= 1500 && integrity.chunks.length <= 200, 'integrity-budget-exceeded')
  const expected = [], metaPaths = new Set(['runtime-integrity.json'])
  for (const chunk of integrity.chunks) {
    requireRuntime(/^audit\/payload-[0-9]{3}\.json$/u.test(chunk.path) && !metaPaths.has(chunk.path), 'chunk-path-refused')
    const path = join(root, chunk.path)
    const entries = boundedMetadata(path, 2 * 1024 ** 2, chunk.sha256, chunk.bytes); requireRuntime(Array.isArray(entries) && entries.length <= 1000, 'chunk-size-refused')
    expected.push(...entries); metaPaths.add(chunk.path)
  }
  requireRuntime(expected.length === integrity.entries, 'entry-count-mismatch')
  const actual = inventory(root).filter(entry => !metaPaths.has(entry.path))
  requireRuntime(actual.length === expected.length, 'payload-count-mismatch')
  const expectedByPath = new Map()
  for (const entry of expected) {
    requireRuntime(typeof entry.path === 'string' && !entry.path.includes('\\') && entry.path.split('/').every(part => part && part !== '.' && part !== '..') && !expectedByPath.has(entry.path), 'payload-path-refused')
    expectedByPath.set(entry.path, entry)
  }
  for (const entry of actual) requireRuntime(JSON.stringify(entry) === JSON.stringify(expectedByPath.get(entry.path)), 'payload-integrity-mismatch')
  const packages = new Map(metadata.packages.map(node => [node.id, node]))
  requireRuntime(packages.size === metadata.packages.length && metadata.packages.filter(n => n.name === '@deepseek-ai/dsh').length === 1, 'package-identities-refused')
  for (const node of metadata.packages) {
    const directory = join(root, node.path)
    requireRuntime(contained(root, realpathSync(directory)), 'package-escaped')
    const pkg = readJson(join(directory, 'package.json'))
    requireRuntime(pkg.name === node.name && pkg.version === node.version && !pkg.devDependencies && !pkg.scripts, 'normalized-package-mismatch')
    const require = createRequire(join(directory, 'package.json'))
    if (Object.hasOwn(metadata.firstParty, node.name)) {
      const exports = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(exports)
        : value && typeof value === 'object' ? Object.values(value).flatMap(exports) : []
      const targets = [...exports(pkg.exports), ...[pkg.main, pkg.types].filter(Boolean), ...[pkg.dsh?.bundle?.patch].filter(Boolean)]
      for (const target of targets) {
        requireRuntime(typeof target === 'string' && contained(directory, resolve(directory, target)), 'owned-export-path-refused')
        const paths = target.includes('*') ? globSync(target.replace(/^\.\//u, ''), { cwd: directory }) : [target]
        requireRuntime(paths.length > 0 && paths.every(path => existsSync(join(directory, path)) && contained(root, realpathSync(join(directory, path)))), 'owned-public-target-missing')
      }
    }
    for (const [name, edge] of Object.entries(node.edges)) {
      const target = packages.get(edge.id); requireRuntime(target && target.version === edge.version && (!edge.providerName || target.name === edge.providerName), 'edge-target-mismatch')
      const provider = (require.resolve.paths('__afos_fixed_package_lookup__') ?? []).map(base => join(base, name))
        .find(path => existsSync(join(path, 'package.json')))
      requireRuntime(provider && realpathSync(provider) === realpathSync(join(root, target.path)), 'edge-resolution-mismatch')
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      requireRuntime(!version.startsWith('file:') && !version.startsWith('workspace:'), 'local-reference-remains')
      requireRuntime(Object.hasOwn(node.edges, name) || node.optionalMissing.includes(name), 'undeclared-provider-missing')
    }
  }
  for (const [name, version] of Object.entries(metadata.singletons ?? {})) requireRuntime(metadata.packages.filter(node => node.name === name && node.version === version).length === 1, 'singleton-identity-mismatch')
  const require = createRequire(join(root, 'package.json')), publicEntries = []
  for (const name of metadata.publicEntries) {
    const path = require.resolve(name)
    requireRuntime(contained(root, realpathSync(path)), 'public-entry-escaped')
    publicEntries.push({ name, path: relative(root, path), sha256: sha256(path) })
  }
  for (const [name, paths] of Object.entries(metadata.resources)) {
    const node = metadata.packages.find(node => node.name === name); requireRuntime(node, 'resource-provider-missing')
    for (const path of paths) requireRuntime(existsSync(join(root, node.path, path)), 'required-resource-missing')
  }
  // These are real carrier assets in the official fixed graph, not replacement UI.
  const assets = metadata.packages.filter(node => node.name === '@deepseek-ai/dsh-web-frontend')
  requireRuntime(assets.length === 1 && existsSync(join(root, assets[0].path, 'dist/index.html')), 'official-web-assets-missing')
  return { root, integritySha256: expectedIntegritySha256, packages: packages.size, entries: actual.length,
    payloadBytes: integrity.payloadBytes, publicEntries, enterpriseActivation: metadata.enterpriseActivation }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, expectedIntegritySha256] = process.argv.slice(2)
  requireRuntime(root && expectedIntegritySha256 && process.argv.length === 4, 'usage:root-integrity-sha256')
  console.log(JSON.stringify(verifyFixedRuntime({ root, expectedIntegritySha256 })))
}
