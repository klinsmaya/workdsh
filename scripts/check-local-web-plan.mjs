import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const web = resolve(root, 'workdsh-web')

if (!existsSync(resolve(web, 'docs/modules.json'))) {
  process.stdout.write('SKIP: canonical local Web plan inventory is absent; separate local scope notes are not that inventory\n')
} else {
  const result = spawnSync(process.execPath, ['scripts/check-plan.mjs'], { cwd: web, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
