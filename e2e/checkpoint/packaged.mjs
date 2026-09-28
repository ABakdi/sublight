#!/usr/bin/env node
/* global document, chrome -- these callbacks run inside the browser page */
/**
 * Checkpoint runner for the packaged release (M06.1, Beta-1 acceptance 1).
 * Packages the current build exactly as the release workflow does
 * (`sublight-<version>.tar.gz` with the engine and the Player, the extension
 * zip), unpacks both outside the repository, runs that engine with a fresh
 * home and loads that extension into a clean browser profile. Then the
 * journey a new user takes: pair from the popup, open the Player the engine
 * serves and pair it, caption a local file there, caption a YouTube video
 * from the extension.
 *
 *   pnpm build && node e2e/checkpoint/packaged.mjs [--browser chromium|brave] [--url <watch url>] [--headed]
 *
 * Port 17421 must be free (stop your engine first). The models and worker
 * binaries are linked from ~/.sublight so nothing is downloaded or built;
 * everything else (token, config, caches) starts empty. Prints one JSON report.
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
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
const executablePath = browserName === 'brave' ? BRAVE.find(existsSync) : undefined
if (browserName === 'brave' && !executablePath) throw new Error('Brave not found')

const up = await fetch(`${ENGINE}/v1/pair/info`).then(
  () => true,
  () => false,
)
if (up) throw new Error('port 17421 is in use: stop your engine first (sublight-engine stop)')

const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
const work = mkdtempSync(join(tmpdir(), 'sublight-packaged-'))
const report = { browser: browserName, version, work, startedAt: new Date().toISOString() }

// 1. Package, as .github/workflows/release.yml does.
const name = `sublight-${version}`
const staging = join(work, 'staging', name)
mkdirSync(staging, { recursive: true })
cpSync(join(repo, 'apps/engine/dist/sublight-engine.mjs'), join(staging, 'sublight-engine.mjs'))
cpSync(join(repo, 'apps/player/dist'), join(staging, 'player'), { recursive: true })
for (const f of ['INSTALL.md', 'CHANGELOG.md', 'LICENSE'])
  if (existsSync(join(repo, f))) cpSync(join(repo, f), join(staging, f))
const tarball = join(work, `${name}.tar.gz`)
execFileSync('tar', ['-czf', tarball, '-C', join(work, 'staging'), name])
const zip = join(work, `sublight-extension-${version}-chromium.zip`)
// The workflow uses `zip -qr`; Python's zipfile makes the same archive where zip isn't installed.
const zipDir = (dir, out) =>
  execFileSync('python3', [
    '-c',
    'import os,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as z:\n for r,_,fs in os.walk(sys.argv[1]):\n  for f in fs: p=os.path.join(r,f); z.write(p,os.path.relpath(p,sys.argv[1]))',
    dir,
    out,
  ])
zipDir(join(repo, 'apps/extension/.output/chrome-mv3'), zip)

// 2. Unpack where a user would, far from the repository.
const install = join(work, 'install')
mkdirSync(install)
execFileSync('tar', ['-xzf', tarball, '-C', install])
const extensionPath = join(work, 'extension')
execFileSync('python3', ['-m', 'zipfile', '-e', zip, extensionPath])
report.packages = {
  tarballMb: Number((readFileSync(tarball).length / 1e6).toFixed(1)),
  zipMb: Number((readFileSync(zip).length / 1e6).toFixed(1)),
}

// 3. The packaged engine, with a fresh home (only models and binaries linked in).
const home = join(work, 'home')
mkdirSync(home)
for (const dir of ['models', 'bin'])
  if (existsSync(join(realHome, dir))) symlinkSync(join(realHome, dir), join(home, dir), 'dir')
const engineLog = []
const engine = spawn(process.execPath, [join(install, name, 'sublight-engine.mjs'), 'start'], {
  cwd: install,
  env: { ...process.env, SUBLIGHT_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
engine.stdout.on('data', (d) => engineLog.push(String(d)))
engine.stderr.on('data', (d) => engineLog.push(String(d)))
const engineStart = Date.now()
for (;;) {
  const ok = await fetch(`${ENGINE}/v1/pair/info`).then(
    (r) => r.ok,
    () => false,
  )
  if (ok) break
  if (Date.now() - engineStart > 20_000 || engine.exitCode !== null)
    throw new Error(`the packaged engine didn't start:\n${engineLog.join('')}`)
  await sleep(250)
}
report.engineStartMs = Date.now() - engineStart

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

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
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
  // The extension: pinned ID, then one-click pairing from the popup.
  await step('extensionPairs', async () => {
    const popup = await context.newPage()
    await popup.goto(`${EXT}/popup.html`)
    const id = await popup.evaluate(() => chrome.runtime.id)
    if (id !== EXT_ID) throw new Error(`extension ID ${id}, expected ${EXT_ID}`)
    const code = await approve(() => popup.getByTestId('pair-engine').first().click())
    await popup.close()
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    await options
      .locator('[data-testid=engine-status][data-state=online]')
      .waitFor({ timeout: 15_000 })
    await options.close()
    return { extensionId: id, code }
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
  engine.kill('SIGTERM')
  await new Promise((r) => engine.once('exit', r))
  report.engineErrors = engineLog
    .join('')
    .split('\n')
    .filter((l) => /"level":"(error|warn)"|Error:/.test(l))
    .slice(0, 5)
  console.log(JSON.stringify(report, null, 2))
}
