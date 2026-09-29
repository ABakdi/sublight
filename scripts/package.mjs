#!/usr/bin/env node
/**
 * Package a release from the built workspaces (after `pnpm build`), as the
 * release workflow publishes it and install.sh expects it (M06b.12):
 *
 *   node scripts/package.mjs [outDir]      (default: release/)
 *
 *   sublight-<v>.tar.gz          the engine, the Player and the extension
 *   sublight-extension-<v>-chromium.zip   the extension alone (needs `zip`)
 *   install.sh                   the Linux installer
 *   SHA256SUMS
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(ROOT, 'release'))
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const engine = join(ROOT, 'apps/engine/dist/sublight-engine.mjs')
const player = join(ROOT, 'apps/player/dist')
const extension = join(ROOT, 'apps/extension/.output/chrome-mv3')
for (const p of [engine, player, extension])
  if (!existsSync(p)) {
    console.error(`${p} is missing: run pnpm build first`)
    process.exit(1)
  }

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`${cmd} failed`)
    process.exit(1)
  }
}

rmSync(out, { recursive: true, force: true })
const name = `sublight-${version}`
const stage = join(out, '.stage', name)
mkdirSync(stage, { recursive: true })
cpSync(engine, join(stage, 'sublight-engine.mjs'))
cpSync(player, join(stage, 'player'), { recursive: true })
cpSync(extension, join(stage, 'extension'), { recursive: true })
for (const f of ['INSTALL.md', 'CHANGELOG.md', 'LICENSE'])
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(stage, f))

run('tar', ['-czf', join(out, `${name}.tar.gz`), name], join(out, '.stage'))
cpSync(join(ROOT, 'scripts/install.sh'), join(out, 'install.sh'))
if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0)
  run('zip', ['-qr', join(out, `sublight-extension-${version}-chromium.zip`), '.'], extension)
else console.warn('zip not found: skipping the extension zip')
rmSync(join(out, '.stage'), { recursive: true, force: true })

const sums = readdirSync(out)
  .filter((f) => f !== 'SHA256SUMS')
  .sort()
  .map(
    (f) =>
      `${createHash('sha256')
        .update(readFileSync(join(out, f)))
        .digest('hex')}  ${f}`,
  )
writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n')
console.log(`${out}:\n${sums.join('\n')}`)
