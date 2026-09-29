#!/usr/bin/env node
/**
 * Try the extension in a real browser: builds apps/extension and opens
 * Brave or Chromium with the unpacked build loaded into a dedicated profile.
 *
 *   pnpm ext:try [url] [--browser brave|chromium|<path>] [--fresh] [--no-build] [--debug-port 9222]
 *
 * The profile lives in ~/.sublight/browser-profiles/<browser> so the pasted
 * engine token survives restarts; --fresh uses a throwaway profile instead.
 * --debug-port exposes CDP so scripts (Playwright connectOverCDP) can drive
 * the same window. Your everyday browser profile is never touched.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const extensionDir = join(repoRoot, 'apps', 'extension', '.output', 'chrome-mv3')

const CANDIDATES = {
  brave: [
    '/usr/bin/brave',
    '/usr/bin/brave-browser',
    '/opt/brave.com/brave/brave',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  chromium: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
}

function parseArgs(argv) {
  const opts = { url: 'about:blank', browser: null, fresh: false, build: true, debugPort: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--browser') opts.browser = argv[++i]
    else if (a === '--fresh') opts.fresh = true
    else if (a === '--no-build') opts.build = false
    else if (a === '--debug-port') opts.debugPort = Number(argv[++i])
    else if (a === '--help' || a === '-h') opts.help = true
    else if (!a.startsWith('--')) opts.url = a
    else throw new Error(`unknown option ${a}`)
  }
  return opts
}

/** Brave first (ADR-0003 target), then Chromium. Google Chrome 137+ ignores --load-extension. */
function findBrowser(choice) {
  if (choice && existsSync(choice)) return { name: basename(choice), path: choice }
  const order = choice ? [choice] : ['brave', 'chromium']
  for (const name of order) {
    const path = (CANDIDATES[name] ?? []).find((p) => existsSync(p))
    if (path) return { name, path }
  }
  return null
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(
    'usage: pnpm ext:try [url] [--browser brave|chromium|<path>] [--fresh] [--no-build] [--debug-port N]',
  )
  process.exit(0)
}

const browser = findBrowser(opts.browser)
if (!browser) {
  console.error(
    `No ${opts.browser ?? 'Brave or Chromium'} install found. Pass --browser <path>, or load ` +
      `${extensionDir} by hand: chrome://extensions → Developer mode → Load unpacked.`,
  )
  process.exit(1)
}

if (opts.build) {
  const build = spawnSync('pnpm', ['--filter', '@sublight/extension', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (build.status !== 0) process.exit(build.status ?? 1)
}
if (!existsSync(join(extensionDir, 'manifest.json'))) {
  console.error(`No build at ${extensionDir}; run without --no-build.`)
  process.exit(1)
}

let profile
if (opts.fresh) profile = mkdtempSync(join(tmpdir(), 'sublight-browser-'))
else {
  profile = join(homedir(), '.sublight', 'browser-profiles', browser.name)
  mkdirSync(profile, { recursive: true })
}

/**
 * Chromium 13x+ disables unpacked extensions after their first reload unless
 * the profile has Developer mode on, so seed that pref before launch (the
 * browser rewrites Preferences on exit, so this must happen while it's closed).
 */
function enableDeveloperMode(profileDir) {
  const dir = join(profileDir, 'Default')
  const file = join(dir, 'Preferences')
  mkdirSync(dir, { recursive: true })
  let prefs = {}
  try {
    prefs = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // first run: no Preferences yet
  }
  prefs.extensions ??= {}
  prefs.extensions.ui ??= {}
  if (prefs.extensions.ui.developer_mode === true) return
  prefs.extensions.ui.developer_mode = true
  writeFileSync(file, JSON.stringify(prefs))
}

const inUse = existsSync(join(profile, 'SingletonLock'))
if (inUse) {
  console.error(
    `The ${browser.name} profile ${profile} is already open. Close that window first, or pass --fresh.`,
  )
  process.exit(1)
}
enableDeveloperMode(profile)

/**
 * The native host (M06b.3). Chromium looks for hosts in the browser's config
 * folder, not the profile. An installed host (install.sh) stays; otherwise a
 * development one is registered that runs the engine from source, so the
 * extension starts the dev engine and takes its token without pairing.
 */
function registerDevHost(browserName) {
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const product = { brave: 'BraveSoftware/Brave-Browser', chromium: 'chromium' }[browserName]
  if (!product) return 'none (unknown browser: pair by hand)'
  const hosts = join(config, product, 'NativeMessagingHosts')
  const manifest = join(hosts, 'sublight.engine.json')
  if (existsSync(manifest)) {
    const current = JSON.parse(readFileSync(manifest, 'utf8'))
    if (!String(current.description).includes('development')) return `installed (${current.path})`
  }
  const dir = join(homedir(), '.sublight', 'dev')
  mkdirSync(dir, { recursive: true })
  const wrapper = join(dir, 'native-host')
  const tsx = join(repoRoot, 'apps', 'engine', 'node_modules', '.bin', 'tsx')
  const main = join(repoRoot, 'apps', 'engine', 'src', 'main.ts')
  writeFileSync(wrapper, `#!/bin/sh\nSUBLIGHT_DEV=1 exec "${tsx}" "${main}" native-host "$@"\n`)
  chmodSync(wrapper, 0o755)
  mkdirSync(hosts, { recursive: true })
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: 'sublight.engine',
        description: 'sublight engine (development)',
        path: wrapper,
        type: 'stdio',
        allowed_origins: ['chrome-extension://ehgdbfcecgkljnpmednociabmmjemfkf/'],
      },
      null,
      2,
    ),
  )
  return `development (${wrapper})`
}
const host = registerDevHost(browser.name)
// Chromium reads hosts from its profile folder (Brave from its config folder):
// this profile is a dedicated one, so it gets a copy.
{
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const product = { brave: 'BraveSoftware/Brave-Browser', chromium: 'chromium' }[browser.name]
  const source = product && join(config, product, 'NativeMessagingHosts', 'sublight.engine.json')
  if (source && existsSync(source)) {
    mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true })
    writeFileSync(
      join(profile, 'NativeMessagingHosts', 'sublight.engine.json'),
      readFileSync(source),
    )
  }
}

const args = [
  `--user-data-dir=${profile}`,
  `--load-extension=${extensionDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  ...(opts.debugPort ? [`--remote-debugging-port=${opts.debugPort}`] : []),
  opts.url,
]

const child = spawn(browser.path, args, { detached: true, stdio: 'ignore' })
child.unref()

console.log(`
sublight extension loaded in ${browser.name} (${browser.path})
  build    ${extensionDir}
  profile  ${profile}
  host     ${host}${opts.debugPort ? `\n  CDP      http://127.0.0.1:${opts.debugPort}` : ''}

Next:
  1. open a page with a video and click the sublight toolbar icon: the extension
     starts the engine from source when it needs it (or run pnpm dev:engine yourself)
  2. "Show test captions" works without the engine

After changing extension code: run \`pnpm ext:try --no-build\` again after
\`pnpm --filter @sublight/extension build\`, or press ↻ on chrome://extensions.
`)
