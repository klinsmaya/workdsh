import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, symlinkSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyFixedRuntime } from '../scripts/verify-fixed-runtime.mjs'
import { sha256 } from '../scripts/prepare-fixed-runtime.mjs'

// Explicit author/reviewer test inputs, never environment inherited by a child.
const root = process.env.AFOS_TEST_RUNTIME, anchor = process.env.AFOS_TEST_INTEGRITY
assert.ok(root && anchor, 'explicit isolated test runtime and integrity anchor required')
const verify = () => verifyFixedRuntime({ root, expectedIntegritySha256: anchor })
test('fixed runtime refuses an oversized integrity index before anchor hashing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'afos-runtime-budget-'))
  try {
    writeFileSync(join(directory, 'runtime-integrity.json'), Buffer.alloc(128 * 1024 + 1, 32))
    assert.throws(() => verifyFixedRuntime({ root: directory, expectedIntegritySha256: anchor }), /metadata-file-refused/)
  } finally { rmSync(directory, { recursive: true }) }
})
test('fixed runtime refuses a linked integrity index before reading its target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'afos-runtime-link-'))
  try {
    writeFileSync(join(directory, 'synthetic-target.json'), 'public synthetic metadata')
    symlinkSync('synthetic-target.json', join(directory, 'runtime-integrity.json'))
    assert.throws(() => verifyFixedRuntime({ root: directory, expectedIntegritySha256: anchor }), /metadata-file-refused/)
  } finally { rmSync(directory, { recursive: true }) }
})
test('fixed runtime rejects a wrong trusted integrity anchor', () => {
  assert.throws(() => verifyFixedRuntime({ root, expectedIntegritySha256: '0'.repeat(64) }), /integrity-anchor-mismatch/)
})
test('fixed runtime rejects an unexpected dependency link to the source workspace', () => {
  const path = join(root, 'node_modules/afos-test-escaping-link')
  symlinkSync('/workspace', path, 'dir')
  try { assert.throws(verify, /link-escaped/) } finally { unlinkSync(path) }
})
test('fixed runtime rejects changed shipped original CLI bytes, then verifies exact restoration', () => {
  const path = createRequire(join(root, 'package.json')).resolve('@deepseek-ai/dsh/lib/bin.js')
  const before = readFileSync(path), beforeHash = sha256(path)
  writeFileSync(path, Buffer.concat([before, Buffer.from('\n// test-only alteration\n')]))
  try { assert.throws(verify, /payload-integrity-mismatch/) } finally { writeFileSync(path, before) }
  assert.equal(sha256(path), beforeHash)
  assert.equal(sha256(join(root, 'runtime-integrity.json')), anchor)
  assert.equal(verify().enterpriseActivation.ingressValidated, false)
})
