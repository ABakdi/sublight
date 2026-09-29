#!/usr/bin/env node
/* global document, chrome -- these callbacks run inside the browser page */
/**
 * Checkpoint runner for the packaged release (M06.1, M06b.12, Beta-1
 * acceptance 1): the path a new user takes. Packages the current build as the
 * release workflow does (`scripts/package.mjs`), runs the shipped install.sh
 * into a fresh home, and loads the extension from the folder it installed
 * into a clean browser profile that finds the native host it registered.
 * Then: the extension starts the engine by itself and takes its token (no
 * pairing), opens the Player (which pairs by itself on its page), captions a
 * local file there, and captions a YouTube video from the extension.
 *
 *   pnpm build && node e2e/checkpoint/packaged.mjs [--browser chromium|brave] [--url <watch url>] [--headed]
 *
 * Port 17421 must be free (stop your engine first). The worker binaries'
 * records are copied and the model files linked from ~/.sublight, so nothing
 * is built or downloaded; everything else (token, config, caches) starts
 * empty. Prints one JSON report.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const EXT_ID = 'ehgdbfcecgkljnpmednociabmmjemfkf'
const EXT = `chrome-extension://${EXT_ID}`
const ENGINE = 'http://127.0.0.1:17421'
const PLAYER = 'http://127.0.0.1:17420'
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const browserName = arg('--browser', 'chromium')
const url = arg('--url', 'https://www.youtube.com/watch?v=-moW9jvvMr4')
const headed = process.argv.includes('--headed')
const realHome = process.env.SUBLIGHT_REAL_HOME ?? join(homedir(), '.sublight')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BRAVE = ['/usr/bin/brave', '/usr/bin/brave-browser', '/opt/brave.com/brave/brave-browser']
// A real Chromium: Playwright's own build (Chrome for Testing) doesn't read
// user-level native messaging hosts, so it can't start the engine.
const CHROMIUM = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
const executablePath = (browserName === 'brave' ? BRAVE : CHROMIUM).find(existsSync)
if (!executablePath) throw new Error(`${browserName} not found`)

const up = await fetch(`${ENGINE}/v1/pair/info`).then(
  () => true,
  () => false,
)
if (up) throw new Error('port 17421 is in use: stop your engine first (sublight-engine stop)')

const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
const work = mkdtempSync(join(tmpdir(), 'sublight-packaged-'))
const report = { browser: browserName, version, work, startedAt: new Date().toISOString() }

// 1. Package, as .github/workflows/release.yml does.
const release = join(work, 'release')
execFileSync(process.execPath, [join(repo, 'scripts/package.mjs'), release], { stdio: 'ignore' })
report.packages = Object.fromEntries(
  readdirSync(release).map((f) => [
    f,
    Number((readFileSync(join(release, f)).length / 1e6).toFixed(2)),
  ]),
)

// 2. A new user's home: the browsers' config folders exist (install.sh registers
// the native host there); the worker binaries' records and the models come
// from this machine, so nothing is rebuilt or downloaded.
const userHome = join(work, 'home')
const sub = join(userHome, '.sublight')
for (const d of ['bin', 'models']) mkdirSync(join(sub, d), { recursive: true })
for (const f of ['whisper.json', 'llama.json', 'yt-dlp.json'])
  if (existsSync(join(realHome, 'bin', f)))
    copyFileSync(join(realHome, 'bin', f), join(sub, 'bin', f))
for (const f of readdirSync(join(realHome, 'models')))
  if (f === 'installed.json') copyFileSync(join(realHome, 'models', f), join(sub, 'models', f))
  else symlinkSync(join(realHome, 'models', f), join(sub, 'models', f))
for (const b of ['chromium', 'google-chrome-for-testing', 'BraveSoftware/Brave-Browser'])
  mkdirSync(join(userHome, '.config', b), { recursive: true })
const userEnv = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config') }
delete userEnv.SUBLIGHT_HOME

// 3. The shipped installer, then the engine it started stopped: the extension
// has to start it itself.
const installStart = Date.now()
const installed = spawnSync(
  'bash',
  [join(release, 'install.sh'), '--from', release, '--no-translation', '--no-browser'],
  { env: userEnv, encoding: 'utf8', timeout: 600_000 },
)
if (installed.status !== 0)
  throw new Error(`install.sh failed:\n${installed.stdout}\n${installed.stderr}`)
report.installMs = Date.now() - installStart
const launcher = join(userHome, '.local/bin/sublight-engine')
execFileSync(launcher, ['stop'], { env: userEnv })
const extensionPath = join(sub, 'extension')
// Playwright's Chromium is Chrome for Testing, with a config folder of its
// own: give it the host install.sh registered for Chromium (real browsers
// read theirs).
const hostDir = (b) => join(userHome, '.config', b, 'NativeMessagingHosts')
mkdirSync(hostDir('google-chrome-for-testing'), { recursive: true })
copyFileSync(
  join(hostDir('chromium'), 'sublight.engine.json'),
  join(hostDir('google-chrome-for-testing'), 'sublight.engine.json'),
)
// Chromium reads hosts from its profile folder (for a default profile, that is
// ~/.config/chromium, where install.sh writes); this run's profile is elsewhere.
const profile = join(work, 'profile')
mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true })
copyFileSync(
  join(hostDir('chromium'), 'sublight.engine.json'),
  join(profile, 'NativeMessagingHosts', 'sublight.engine.json'),
)

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn().catch(() => null)
    if (v) return { value: v, ms: Date.now() - start }
    await sleep(stepMs)
  }
  return null
}

const clip = join(work, 'jfk.mp4')
execFileSync('ffmpeg', [
  ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10'],
  ...['-i', join(repo, 'apps/engine/tests/fixtures/jfk.wav')],
  ...['-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip],
])

const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  // The user's home: the browser finds the native host install.sh registered.
  env: userEnv,
  headless: !headed,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})

/** Click Approve on the engine's pairing page that `click` opens; returns the code shown. */
async function approve(click) {
  const [page] = await Promise.all([context.waitForEvent('page'), click()])
  await page.waitForLoadState()
  const code = (await page.locator('[data-code]').textContent())?.trim()
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.getByRole('status').filter({ hasText: 'Approved' }).waitFor({ timeout: 10_000 })
  await page.close()
  return code
}

const step = async (key, fn) => {
  const start = Date.now()
  try {
    const detail = await fn()
    report[key] = { ok: true, ms: Date.now() - start, ...(detail ?? {}) }
  } catch (err) {
    report[key] = {
      ok: false,
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
    }
  }
  return report[key].ok
}

try {
  // The extension: pinned ID; the engine off, then started by the extension
  // itself, with the token from the native host (no pairing).
  await step('extensionStartsEngine', async () => {
    const popup = await context.newPage()
    await popup.goto(`${EXT}/popup.html`)
    const id = await popup.evaluate(() => chrome.runtime.id)
    if (id !== EXT_ID) throw new Error(`extension ID ${id}, expected ${EXT_ID}`)
    await popup.getByTestId('tab-engine').click()
    await popup.locator('[data-testid=engine-card][data-state=off]').waitFor({ timeout: 15_000 })
    const start = Date.now()
    const [player] = await Promise.all([
      context.waitForEvent('page'),
      popup.getByTestId('open-player').click(),
    ])
    await player.waitForLoadState()
    const startedMs = Date.now() - start
    if (!player.url().startsWith(PLAYER)) throw new Error(`opened ${player.url()}`)
    await popup.reload()
    await popup.getByTestId('tab-engine').click()
    await popup.locator('[data-testid=engine-card][data-state=on]').waitFor({ timeout: 15_000 })
    await popup.close()
    await player.close()
    return { extensionId: id, engineStartedAndPlayerOpenMs: startedMs }
  })

  // The Player the engine serves: pairs on its own, captions a local file.
  await step('playerCaptionsLocalFile', async () => {
    const player = await context.newPage()
    await player.goto(PLAYER)
    await player.setInputFiles('input[data-testid="file-input"]', clip)
    await player.getByTestId('panel-caption').click()
    await approve(() => player.getByTestId('pair-engine').click())
    await player
      .getByTestId('engine-status')
      .filter({ hasText: 'engine online' })
      .waitFor({ timeout: 15_000 })
    await player.getByTestId('caption-model').selectOption('whisper-small')
    const start = Date.now()
    await player.getByTestId('caption-start').click()
    await player.getByTestId('caption-done').waitFor({ timeout: 180_000 })
    const captionMs = Date.now() - start
    await player.evaluate(() => {
      const v = document.querySelector('video')
      v.pause()
      v.currentTime = 6.5
    })
    const cue = await waitFor(
      () =>
        player.evaluate(
          () =>
            document.querySelector('[data-sublight-host]')?.shadowRoot?.querySelector('.sl-cue')
              ?.textContent ?? '',
        ),
      10_000,
    )
    if (!/country/i.test(cue?.value ?? '')) throw new Error(`cue at 6.5 s: "${cue?.value ?? ''}"`)
    await player.close()
    return { captionMs, cue: cue.value }
  })

  // A YouTube video captioned from the extension, ahead of playback.
  await step('extensionCaptionsYouTube', async () => {
    // The profile's first tab: other tabs' URLs are hidden without the `tabs`
    // permission, so the popup finds the site as the one non-extension tab.
    const site =
      context.pages().find((p) => !p.url().startsWith('chrome-extension')) ??
      (await context.newPage())
    await site.goto(url, { waitUntil: 'domcontentloaded' })
    const consent = site.getByRole('button', {
      name: /^(Accept all|Reject all|Alle akzeptieren|Alle ablehnen|Tout accepter)$/i,
    })
    if (
      await consent
        .first()
        .isVisible({ timeout: 8000 })
        .catch(() => false)
    )
      await consent.first().click()
    await site.evaluate(() => {
      const v = document.querySelector('video')
      if (v) {
        v.muted = true
        void v.play()
      }
    })
    const playing = await waitFor(
      () =>
        site.evaluate(() => {
          const v = [...document.querySelectorAll('video')].find((x) => x.duration > 0)
          return v && v.currentTime > 1 && !document.querySelector('#movie_player.ad-showing')
        }),
      90_000,
      500,
    )
    if (!playing) throw new Error('the video never started (consent, ad or bot check?)')
    const popup = await context.newPage()
    await popup.goto(`${EXT}/popup.html`)
    const tabId = await popup.evaluate(
      async () =>
        (await chrome.tabs.query({})).find((t) => !t.url?.startsWith('chrome-extension'))?.id,
    )
    await popup.goto(`${EXT}/popup.html?tab=${tabId}`)
    const start = Date.now()
    await popup.getByTestId('captions-toggle').click()
    await site.bringToFront()
    const first = await waitFor(
      () =>
        site.evaluate(
          () =>
            document
              .querySelector('[data-sublight-frame] [data-sublight-host]')
              ?.shadowRoot?.querySelector('.sl-cue')?.innerText ?? '',
        ),
      180_000,
      500,
    )
    if (!first) throw new Error('no caption within 180 s')
    return { firstCaptionMs: Date.now() - start, firstCaption: first.value }
  })
} finally {
  await context.close()
  spawnSync(launcher, ['stop'], { env: userEnv })
  const log = join(sub, 'logs', 'engine.log')
  report.engineErrors = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => /"level":"(error|warn)"/.test(l))
        .slice(0, 5)
    : []
  console.log(JSON.stringify(report, null, 2))
}
