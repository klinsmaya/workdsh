/** Inspect public installed package metadata for a frozen production runtime graph. */
import { createRequire, isBuiltin } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { runtimeReferences } from './fixed-runtime-references.mjs'

export class FixedRuntimeError extends Error {
  constructor(code) { super(`runtime/${code}`) }
}
export function requireRuntime(value, code) { if (!value) throw new FixedRuntimeError(code) }
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
export function packageName(name) {
  requireRuntime(typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name), 'package-name-refused')
  return name
}
export function contained(root, path) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'))
}
/** Resolve installed manifest paths without importing package code or falling back to global modules. */
export function installedPackage(source, owner, name, firstParty) {
  packageName(name)
  if (firstParty[name]) return realpathSync(resolve(source, firstParty[name]))
  const require = createRequire(join(owner, 'package.json'))
  // Builtin names (buffer, util, string_decoder) also occur as declared npm
  // packages. Ask Node for the ordinary package lookup directories so their
  // shipped npm providers are retained rather than silently substituting a builtin.
  for (const base of require.resolve.paths('__afos_fixed_package_lookup__') ?? []) {
    const path = join(base, name, 'package.json')
    if (!existsSync(path)) continue
    const directory = realpathSync(join(base, name))
    if (!contained(source, directory)) continue
    return directory
  }
  return undefined
}
function supported(pkg, target) {
  const [platform, architecture] = target.split('-')
  const allowed = (values, value) => !values || (!values.includes(`!${value}`) && (!values.some(v => !v.startsWith('!')) || values.includes(value)))
  return allowed(pkg.os, platform) && allowed(pkg.cpu, architecture) && allowed(pkg.libc, 'glibc')
}
/** Every production dependency and non-optional peer must have a contained, installed provider. */
export function inspectFixedRuntimeGraph({ source, manifest }) {
  source = realpathSync(source)
  requireRuntime(manifest.format === 1 && manifest.target === 'linux-x64', 'manifest-refused')
  requireRuntime(readJson(join(source, 'upstream.json')).version === manifest.dshVersion, 'source-dsh-version-mismatch')
  const anchor = join(source, 'workdsh-web'), providers = { ...manifest.firstParty }
  for (const [name, version] of Object.entries(manifest.singletons ?? {})) {
    const path = installedPackage(source, anchor, name, manifest.firstParty)
    requireRuntime(path && readJson(join(path, 'package.json')).version === version, 'singleton-provider-missing')
    providers[name] = relative(source, path)
  }
  const nodes = [], byPath = new Map(), bySingleton = new Map(), rootEdges = {}, omitted = [], sourceAliases = []
  const add = (directory, expectedName) => {
    const path = realpathSync(directory)
    requireRuntime(contained(source, path), 'source-package-escaped')
    if (byPath.has(path)) return byPath.get(path)
    const pkg = readJson(join(path, 'package.json'))
    requireRuntime(pkg.name === expectedName && typeof pkg.version === 'string', 'package-metadata-mismatch')
    requireRuntime(supported(pkg, manifest.target), 'required-package-platform-mismatch')
    if (pkg.name === '@deepseek-ai/dsh' || pkg.name.startsWith('@deepseek-ai/dsh-')) requireRuntime(pkg.version === manifest.dshVersion, 'dsh-family-mismatch')
    if (pkg.name === '@deepseek-ai/cordis') requireRuntime(pkg.version === manifest.cordisVersion, 'cordis-version-mismatch')
    const singleton = pkg.name === '@deepseek-ai/dsh' || pkg.name.startsWith('@deepseek-ai/dsh-') || Object.hasOwn(manifest.singletons ?? {}, pkg.name)
    if (singleton && bySingleton.has(pkg.name)) {
      const canonical = bySingleton.get(pkg.name)
      requireRuntime(canonical.version === pkg.version, 'singleton-version-mismatch')
      byPath.set(path, canonical); sourceAliases.push({ name: pkg.name, source: path, canonical: canonical.id })
      return canonical
    }
    const node = { id: `p${String(nodes.length).padStart(4, '0')}`, name: pkg.name, version: pkg.version, source: path,
      sourcePackageSha256: createHash('sha256').update(readFileSync(join(path, 'package.json'))).digest('hex'),
      firstParty: Object.hasOwn(manifest.firstParty, pkg.name), manifest: pkg, edges: {}, optionalMissing: [] }
    byPath.set(path, node); if (singleton) bySingleton.set(pkg.name, node); nodes.push(node); return node
  }
  for (const [name, version] of Object.entries(manifest.roots)) {
    const cliOwner = nodes.find(node => node.name === '@deepseek-ai/dsh')?.source
    const path = installedPackage(source, anchor, name, providers)
      ?? (cliOwner && installedPackage(source, cliOwner, name, providers))
    requireRuntime(path, `root-package-missing:${name}`)
    const node = add(path, name); requireRuntime(node.version === version, 'root-version-mismatch'); rootEdges[name] = node.id
  }
  let index = 0
  const expandDeclarations = () => { for (; index < nodes.length; index++) {
    const node = nodes[index], pkg = node.manifest
    const declarations = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const [name, range] of Object.entries(declarations).sort()) {
      const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, name)
        || !Object.hasOwn(pkg.dependencies ?? {}, name) && pkg.peerDependenciesMeta?.[name]?.optional === true
      const path = installedPackage(source, node.source, name, providers)
      if (!path || !supported(readJson(join(path, 'package.json')), manifest.target)) {
        requireRuntime(optional, `required-provider-missing:${node.name}:${name}`)
        node.optionalMissing.push(name); omitted.push({ owner: node.id, name, optional: true }); continue
      }
      const alias = typeof range === 'string' && range.startsWith('npm:') ? /^npm:((?:@[^/]+\/)?[^@]+)@/u.exec(range)?.[1] : undefined
      const child = add(path, alias ?? name)
      node.edges[name] = { id: child.id, providerName: child.name, version: child.version, declared: range, optional,
        declarations: ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap(kind =>
          Object.hasOwn(pkg[kind] ?? {}, name) ? [{ kind, range: pkg[kind][name] }] : []) }
    }
  } }
  expandDeclarations()
  const scannerNode = nodes.find(node => node.name === 'typescript' && node.version === '6.0.3')
  requireRuntime(scannerNode, 'public-import-scanner-missing')
  const ts = createRequire(join(scannerNode.source, 'package.json'))('./')
  // Supplement only literal runtime imports from the curated shipping JS. A
  // devDependencies declaration alone never causes a development tool to ship.
  for (const node of nodes.filter(node => node.firstParty)) {
    const files = globSync('dist/**/*.{js,mjs,cjs}', { cwd: node.source }).sort()
    node.runtimeImportFiles = []; node.runtimeImports = []; node.dynamicRuntimeImports = []
    for (const file of files) {
      const text = readFileSync(join(node.source, file), 'utf8')
      node.runtimeImportFiles.push({ file, sha256: createHash('sha256').update(text).digest('hex') })
      const references = runtimeReferences(ts, text, file)
      node.dynamicRuntimeImports.push(...references.dynamic.map(item => ({ file, ...item })))
      for (const item of references.literals) {
        const specifier = item.specifier
        if (isBuiltin(specifier) || specifier.startsWith('.') || specifier.startsWith('#')) continue
        const name = packageName(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
        const path = installedPackage(source, node.source, name, providers)
        requireRuntime(path, `owned-runtime-source-provider-missing:${node.name}:${name}`)
        requireRuntime(path.includes('/node_modules/') || Object.hasOwn(manifest.firstParty, name), 'uncurated-source-package-refused')
        const declaration = node.manifest.dependencies?.[name] ?? node.manifest.peerDependencies?.[name] ?? node.manifest.devDependencies?.[name] ?? readJson(join(path, 'package.json')).version
        const alias = declaration.startsWith('npm:') ? /^npm:((?:@[^/]+\/)?[^@]+)@/u.exec(declaration)?.[1] : undefined
        const child = add(path, alias ?? name)
        if (!node.edges[name]) node.edges[name] = { id: child.id, providerName: child.name, version: child.version, declared: declaration,
          optional: false, declarations: [{ kind: 'runtimeImport', range: declaration }], supplementalRuntimeImport: true }
        node.runtimeImports.push({ file, specifier, provider: child.id })
      }
    }
  }
  expandDeclarations()
  requireRuntime(nodes.filter(n => n.name === '@deepseek-ai/dsh').length === 1, 'multiple-physical-dsh')
  for (const name of Object.keys(manifest.singletons ?? {})) requireRuntime(nodes.filter(n => n.name === name).length === 1, 'multiple-singleton-provider')
  // Use the exact installed public semver package already in this graph, never
  // a global build tool. Local references resolve to a curated exact provider.
  const semverNode = nodes.find(n => n.name === 'semver' && n.version === '7.8.5')
  requireRuntime(semverNode, 'range-validator-missing')
  const semver = createRequire(join(semverNode.source, 'package.json'))('./index.js')
  const overrides = readJson(join(source, 'workdsh-web/package.json')).pnpm?.overrides ?? {}
  const overridden = (node, name, range, version) => Object.entries(overrides).find(([selector, replacement]) => {
    if (replacement !== version) return false
    const [parent, dependency] = selector.includes('>') ? selector.split('>') : [undefined, selector]
    const matches = (value, actualName, actualRange) => {
      const split = value.lastIndexOf('@'), hasRange = split > 0
      const wantedName = hasRange ? value.slice(0, split) : value
      const wantedRange = hasRange ? value.slice(split + 1) : '*'
      return wantedName === actualName && semver.validRange(actualRange) && semver.validRange(wantedRange)
        && semver.intersects(actualRange, wantedRange, { includePrerelease: true })
    }
    return (!parent || matches(parent, node.name, node.version)) && matches(dependency, name, range)
  })?.[0]
  for (const node of nodes) for (const [name, edge] of Object.entries(node.edges)) for (const declaration of edge.declarations) {
    let range = declaration.range
    if (range.startsWith('file:') || range.startsWith('workspace:')) {
      requireRuntime(Object.hasOwn(manifest.firstParty, name), 'unapproved-local-reference')
      continue
    }
    if (range.startsWith('npm:')) range = range.slice(range.lastIndexOf('@') + 1)
    if (!semver.satisfies(edge.version, range, { includePrerelease: true })) {
      declaration.sourceOverride = overridden(node, name, range, edge.version)
      requireRuntime(declaration.sourceOverride, `provider-range-mismatch:${node.name}:${name}`)
      if (declaration.range === edge.declared) edge.sourceOverride = declaration.sourceOverride
    }
  }
  return { nodes, roots: rootEdges, omitted, sourceAliases }
}
