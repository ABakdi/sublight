#!/usr/bin/env node
/**
 * Versions and releases (M06.5, CONTRIBUTING "Releasing").
 *
 *   node scripts/release.mjs 0.2.0        set every package to 0.2.0, the engine's
 *                                         ENGINE_VERSION and install.sh too, and move the changelog's
 *                                         Unreleased notes under [0.2.0]
 *   node scripts/release.mjs --check [--tag v0.2.0]
 *                                         versions agree (and match the tag), and the
 *                                         changelog has a section for them (CI)
 *   node scripts/release.mjs --notes 0.2.0
 *                                         print that version's changelog section
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = [
  'package.json',
  'apps/engine/package.json',
  'apps/extension/package.json',
  'apps/player/package.json',
  'packages/core/package.json',
  'packages/overlay/package.json',
  'packages/protocol/package.json',
]
const HEALTH = 'apps/engine/src/health.ts'
const INSTALLER = 'scripts/install.sh'
const INSTALLER_VERSION_RE = /^SUBLIGHT_VERSION="([^"]+)"/m
const CHANGELOG = 'CHANGELOG.md'
const ENGINE_VERSION_RE = /export const ENGINE_VERSION = '([^']+)'/
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const write = (p, s) => writeFileSync(join(ROOT, p), s)

function section(changelog, version) {
  const start = changelog.search(new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm'))
  if (start < 0) return null
  const rest = changelog.slice(start)
  const next = rest.slice(1).search(/^## \[/m)
  return (next < 0 ? rest : rest.slice(0, next + 1)).trim()
}

function versions() {
  const found = PACKAGES.map((p) => [p, JSON.parse(read(p)).version])
  found.push([HEALTH, read(HEALTH).match(ENGINE_VERSION_RE)?.[1]])
  found.push([INSTALLER, read(INSTALLER).match(INSTALLER_VERSION_RE)?.[1]])
  return found
}

function check(tag) {
  const found = versions()
  const version = found[0][1]
  const problems = found
    .filter(([, v]) => v !== version)
    .map(([p, v]) => `${p} is ${v}, not ${version}`)
  if (tag && tag !== `v${version}`) problems.push(`tag ${tag} doesn't match version ${version}`)
  if (!section(read(CHANGELOG), version)) problems.push(`${CHANGELOG} has no [${version}] section`)
  if (problems.length) {
    console.error(problems.join('\n'))
    return 1
  }
  console.log(`version ${version}: packages, engine and changelog agree`)
  return 0
}

function bump(version) {
  if (!SEMVER_RE.test(version)) {
    console.error(`not a version: ${version}`)
    return 1
  }
  for (const p of PACKAGES) {
    const pkg = JSON.parse(read(p))
    pkg.version = version
    write(p, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  write(
    HEALTH,
    read(HEALTH).replace(ENGINE_VERSION_RE, `export const ENGINE_VERSION = '${version}'`),
  )
  write(INSTALLER, read(INSTALLER).replace(INSTALLER_VERSION_RE, `SUBLIGHT_VERSION="${version}"`))
  let changelog = read(CHANGELOG)
  if (!section(changelog, version)) {
    if (!/^## \[Unreleased\]/m.test(changelog)) {
      console.error(`${CHANGELOG} needs an "## [Unreleased]" section`)
      return 1
    }
    const date = new Date().toISOString().slice(0, 10)
    changelog = changelog.replace(
      /^## \[Unreleased\]/m,
      `## [Unreleased]\n\n## [${version}] — ${date}`,
    )
    write(CHANGELOG, changelog)
  }
  console.log(`set ${version}. Review CHANGELOG.md, then:
  git commit -am "release: v${version}" && git tag v${version} && git push --follow-tags`)
  return 0
}

const [a, b, c] = process.argv.slice(2)
let code
if (a === '--check') code = check(b === '--tag' ? c : undefined)
else if (a === '--notes') {
  const s = b && section(read(CHANGELOG), b)
  if (s) console.log(s.split('\n').slice(1).join('\n').trim())
  code = s ? 0 : 1
} else if (a && !a.startsWith('-')) code = bump(a)
else {
  console.error('usage: release.mjs <version> | --check [--tag vX.Y.Z] | --notes <version>')
  code = 1
}
process.exit(code)
