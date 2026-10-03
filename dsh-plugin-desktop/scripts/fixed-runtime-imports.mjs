/** Public TypeScript scanner; no browser/server product module execution. */
import { createRequire, isBuiltin } from 'node:module'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { contained, requireRuntime } from './fixed-runtime-graph.mjs'
import { runtimeReferences } from './fixed-runtime-references.mjs'

export function inspectOwnedRuntimeImports(root, metadata) {
  const scanner = metadata.packages.find(node => node.name === 'typescript' && node.version === '6.0.3')
  requireRuntime(scanner, 'public-import-scanner-missing')
  const ts = createRequire(join(root, scanner.path, 'package.json'))('./')
  const rows = [], dynamic = [], ownedFiles = []
  for (const node of metadata.packages.filter(node => Object.hasOwn(metadata.firstParty, node.name))) {
    const walk = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const next = join(path, entry.name)
        if (entry.isDirectory()) walk(next)
        else if (entry.isFile() && /\.(?:[cm]?js)$/u.test(entry.name)) ownedFiles.push({ node, path: next })
      }
    }
    walk(join(root, node.path))
  }
  for (const { node, path } of ownedFiles) {
    const require = createRequire(path), source = readFileSync(path, 'utf8')
    const references = runtimeReferences(ts, source, relative(root, path))
    dynamic.push(...references.dynamic.map(item => ({ owner: node.id, package: node.name, file: relative(join(root, node.path), path), ...item })))
    for (const item of references.literals) {
      const specifier = item.specifier
      if (isBuiltin(specifier)) { rows.push({ owner: node.id, file: relative(root, path), specifier, builtin: true }); continue }
      let resolved
      try { resolved = realpathSync(require.resolve(specifier)) } catch { throw Error(`runtime/owned-runtime-import-unresolved:${node.name}:${specifier}`) }
      requireRuntime(contained(root, resolved), 'owned-runtime-import-escaped')
      rows.push({ owner: node.id, file: relative(root, path), specifier, target: relative(root, resolved) })
    }
  }
  const dynamicSupport = (metadata.dynamicImportPolicy ?? []).map(policy => {
    const matches = dynamic.filter(item => item.package === policy.owner && item.file === policy.file
      && item.kind === policy.kind && item.expression === policy.expression)
    requireRuntime(matches.length === policy.occurrences, 'dynamic-import-policy-mismatch')
    return { ...policy, observed: matches.length }
  })
  for (const item of dynamic) requireRuntime(dynamicSupport.some(policy => item.package === policy.owner
    && item.file === policy.file && item.kind === policy.kind && item.expression === policy.expression), 'unknown-dynamic-import-refused')
  return { scanner: 'typescript.createSourceFile/forEachChild', version: ts.version, firstPartyPackages: Object.keys(metadata.firstParty).length,
    files: ownedFiles.length, literalReferences: rows.length, rows, dynamic, dynamicSupport,
    coverage: 'Shipping JS/MJS/CJS literal imports/export-from/require/dynamic-import literals; no product execution',
    nonLiteralCoverage: 'Not resolved statically. Existing fixed public CLI/provider/Loader entries and real consumer tests cover the managed composition; generic user-defined plugins/configuration are outside this artifact test.' }
}
