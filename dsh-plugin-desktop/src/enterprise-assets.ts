import { constants, openSync, closeSync, readFileSync, fstatSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; script-src-elem 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
function denied(): Response { return new Response(null, { status: 404 }) }
function readRegular(path: string, maximum: number): Buffer {
  if (lstatSync(path).isSymbolicLink()) throw new Error('enterprise/local-assets-refused')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error('enterprise/local-assets-refused'); return readFileSync(fd) }
  finally { closeSync(fd) }
}
/** Release-owned assets only. No file proxy, Host forward, arbitrary path or remote route. */
export function localAssetHandler(directory: string): (request: Request) => Response {
  const decoded: unknown = JSON.parse(readRegular(join(directory, 'assets.json'), 1048576).toString('utf8'))
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).some(key => !['contractVersion', 'files'].includes(key))) throw new Error('enterprise/local-assets-refused')
  const input = decoded as { contractVersion?: unknown; files?: unknown }
  if (input.contractVersion !== 'afos.local-assets.v1' || !Array.isArray(input.files) || !input.files.length || input.files.length > 256) throw new Error('enterprise/local-assets-refused')
  const assets = new Map<string, { file: string; bytes: number; sha256: string; type: string }>()
  for (const raw of input.files) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'bytes,file,sha256,type') throw new Error('enterprise/local-assets-refused')
    const row = raw as { file: string; bytes: number; sha256: string; type: string }
    if (typeof row.file !== 'string' || !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/u.test(row.file) || row.file.split('/').some(part => part === '.' || part === '..')
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 16777216 || !/^[a-f0-9]{64}$/u.test(row.sha256)
      || !['text/html', 'text/javascript', 'text/css', 'image/svg+xml', 'image/png', 'font/woff2', 'application/octet-stream'].includes(row.type)
      || assets.has('/' + row.file)) throw new Error('enterprise/local-assets-refused')
    assets.set('/' + row.file, Object.freeze({ ...row }))
  }
  return request => {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET' || url.href !== request.url || url.protocol !== 'afos-local:' || url.hostname !== 'drafts' || url.username || url.password || url.port || url.search || url.hash || url.pathname.includes('%')) return denied()
      const row = assets.get(url.pathname); if (!row) return denied()
      const value = readRegular(join(directory, row.file), row.bytes)
      if (value.length !== row.bytes || createHash('sha256').update(value).digest('hex') !== row.sha256) return denied()
      return new Response(new Uint8Array(value), { headers: { 'Content-Type': row.type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
    } catch { return denied() }
  }
}
