import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadManagedDesktopConfig } from '../src/enterprise-entry.ts'

const config = { contractVersion: 'afos.desktop-config.v1', releaseId: 'release1', policyRevision: 'policy1',
  auth: { issuer: 'https://enterprise.example/api', clientId: 'desktop', resource: 'https://enterprise.example/api/afos', scope: 'afos offline_access' } }
describe('distribution-owned enterprise entry', () => {
  it('keeps personal startup when configuration is absent and freezes managed input', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afos-entry-'))
    try {
      const path = join(directory, 'config.json')
      expect(loadManagedDesktopConfig(path)).toBeUndefined()
      writeFileSync(path, JSON.stringify(config))
      const value = loadManagedDesktopConfig(path)
      expect(value).toEqual(config)
      expect(Object.isFrozen(value)).toBe(true)
      expect(Object.isFrozen(value?.auth)).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('refuses credentials, extra endpoints, redirected resource and symlink configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afos-entry-'))
    try {
      const path = join(directory, 'config.json')
      for (const value of [{ ...config, access_token: 'fixture-only' }, { ...config, auth: { ...config.auth, tokenEndpoint: 'https://other.example' } },
        { ...config, auth: { ...config.auth, resource: 'https://other.example/afos' } }, { ...config, auth: { ...config.auth, issuer: 'http://enterprise.example/api' } }]) {
        writeFileSync(path, JSON.stringify(value))
        expect(() => loadManagedDesktopConfig(path)).toThrow('enterprise/invalid-managed-config')
      }
      writeFileSync(path, '{"access_token":"fixture-only"')
      expect(() => loadManagedDesktopConfig(path)).toThrow('enterprise/invalid-managed-config')
      writeFileSync(path, JSON.stringify(config))
      const alias = join(directory, 'alias.json')
      symlinkSync(path, alias)
      expect(() => loadManagedDesktopConfig(alias)).toThrow('enterprise/invalid-managed-config')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
