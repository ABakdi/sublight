#!/usr/bin/env node
/* global document, location, chrome -- these callbacks run inside the browser page */
/**
 * Checkpoint runner for real sites (Beta-1 matrix T2–T4, docs/checkpoints).
 * Drives the built extension in a throwaway profile against a real YouTube
 * video, with the engine you run (`sublight-engine start --detach`) and its
 * installed models. Not part of CI: it needs the network and real ASR.
 *
 *   node e2e/checkpoint/real-sites.mjs [--browser chromium|brave] [--url <watch url>] [--headed]
 *                                      [--shots <dir for failure screenshots>]
 *
 * Prints one JSON report: time to first caption, how many sampled on-screen
 * captions match the downloaded SRT at that moment (sync), seek and speed
 * checks, following the next video, and the browser's peak memory.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const EXT_ID = 'ehgdbfcecgkljnpmednociabmmjemfkf'
const EXT = `chrome-extension://${EXT_ID}`
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const browserName = arg('--browser', 'chromium')
const url = arg('--url', 'https://www.youtube.com/watch?v=86MUyplj7ZE')
const headed = process.argv.includes('--headed')
const home = process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
const token = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).token
const extensionPath = resolve(here, '..', '..', 'apps', 'extension', '.output', 'chrome-mv3')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BRAVE = ['/usr/bin/brave', '/usr/bin/brave-browser', '/opt/brave.com/brave/brave-browser']
const executablePath = browserName === 'brave' ? BRAVE.find(existsSync) : undefined
if (browserName === 'brave' && !executablePath) throw new Error('Brave not found')

const profile = mkdtempSync(join(tmpdir(), 'sublight-checkpoint-'))
const report = { browser: browserName, url, startedAt: new Date().toISOString() }

// Peak memory of this browser (every process started with this profile).
let peakRssMb = 0
const memTimer = setInterval(() => {
  try {
    const out = execFileSync('ps', ['-eo', 'rss,args'], { encoding: 'utf8' })
    const kb = out
      .split('\n')
      .filter((l) => l.includes(profile) || l.includes(`--user-data-dir=${profile}`))
      .reduce((n, l) => n + Number(l.trim().split(/\s+/)[0] || 0), 0)
    peakRssMb = Math.max(peakRssMb, Math.round(kb / 1024))
  } catch {
    // ps unavailable
  }
}, 1000)

const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: !headed,
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const cueText = (page) =>
  page.evaluate(
    () =>
      document
        .querySelector('[data-sublight-frame] [data-sublight-host]')
        ?.shadowRoot?.querySelector('.sl-cue')?.innerText ?? '',
  )
const videoTime = (page) =>
  page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find((x) => x.duration > 0)
    return v ? { t: v.currentTime, paused: v.paused, rate: v.playbackRate } : null
  })
const setVideo = (page, props) =>
  page.evaluate((p) => {
    const v = [...document.querySelectorAll('video')].find((x) => x.duration > 0)
    if (!v) return
    if (p.time !== undefined) v.currentTime = p.time
    if (p.rate !== undefined) v.playbackRate = p.rate
    if (p.play) void v.play()
  }, props)

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return { value: v, ms: Date.now() - start }
    await sleep(stepMs)
  }
  return null
}

/** YouTube ads replace the video for a while: skip them, or wait them out (≤ 60 s). */
async function endAds(page) {
  const start = Date.now()
  while (Date.now() - start < 60_000) {
    const ad = await page
      .evaluate(() => Boolean(document.querySelector('#movie_player.ad-showing')))
      .catch(() => false)
    if (!ad) return Date.now() - start
    await page
      .locator('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button')
      .first()
      .click({ timeout: 1000 })
      .catch(() => {})
    await sleep(500)
  }
  return null
}

const shots = arg('--shots', tmpdir())
/** What the page shows when a step fails: video state, caption, overlay, a screenshot. */
async function diagnose(step) {
  const site = context.pages().find((p) => !p.url().startsWith('chrome-extension'))
  if (!site) return { step, page: null }
  const file = join(shots, `checkpoint-${browserName}-${step}.png`)
  await site.screenshot({ path: file }).catch(() => {})
  return {
    step,
    url: site.url(),
    video: await videoTime(site).catch(() => null),
    videos: await site.evaluate(() => document.querySelectorAll('video').length).catch(() => null),
    overlay: await site
      .evaluate(() => Boolean(document.querySelector('[data-sublight-frame] [data-sublight-host]')))
      .catch(() => null),
    caption: await cueText(site).catch(() => null),
    screenshot: file,
  }
}

async function openPopupFor(site) {
  await site.bringToFront()
  const popup = await context.newPage()
  await popup.goto(`${EXT}/popup.html`)
  const tabId = await popup.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => !t.url?.startsWith('chrome-extension')).id,
  )
  await popup.goto(`${EXT}/popup.html?tab=${tabId}`)
  return popup
}

/** Cues from an SRT, seconds. */
function parseSrt(text) {
  const t = (s) => {
    const [h, m, rest] = s.split(':')
    return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'))
  }
  return text
    .replace(/\r/g, '')
    .split(/\n\n+/)
    .map((b) => b.split('\n'))
    .filter((l) => l.length >= 3 && l[1].includes('-->'))
    .map((l) => {
      const [a, b] = l[1].split(' --> ')
      return { start: t(a), end: t(b), text: l.slice(2).join(' ') }
    })
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

try {
  // Pair.
  const options = await context.newPage()
  await options.goto(`${EXT}/options.html`)
  await options.getByTestId('token-input').fill(token)
  await options.getByTestId('token-save').click()
  await options
    .getByTestId('engine-status')
    .and(options.locator('[data-state="online"]'))
    .waitFor({ timeout: 10_000 })
  await options.close()

  // The video, past any consent wall.
  const site = context.pages()[0] ?? (await context.newPage())
  await site.goto(url, { waitUntil: 'domcontentloaded' })
  const consent = site.getByRole('button', {
    name: /^(Accept all|Reject all|Alle akzeptieren|Alle ablehnen|Tout accepter)$/i,
  })
  if (
    await consent
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false)
  ) {
    await consent.first().click()
    await site.waitForLoadState('domcontentloaded')
  }
  await site.evaluate(() => {
    const v = document.querySelector('video')
    if (v) {
      v.muted = true
      void v.play()
    }
  })
  const playing = await waitFor(async () => {
    const v = await videoTime(site)
    return v && v.t > 1 ? v : null
  }, 45_000)
  report.videoPlays = Boolean(playing)
  if (!playing) throw new Error('the video never started (consent, ad or bot check?)')
  report.adMs = await endAds(site)

  // T2: captions ahead of playback.
  const popup = await openPopupFor(site)
  await popup.getByTestId('captions-toggle').click()
  const clickedAt = Date.now()
  await site.bringToFront()
  const first = await waitFor(async () => (await cueText(site)) || null, 180_000)
  report.firstCaptionMs = first ? Date.now() - clickedAt : null
  report.firstCaption = first?.value ?? null

  // Sample what's on screen against the video clock.
  const samples = []
  for (let i = 0; i < 20; i++) {
    const v = await videoTime(site)
    samples.push({ t: v?.t ?? null, text: await cueText(site), rate: v?.rate ?? 1 })
    await sleep(1500)
  }

  // T3: seek, then faster playback.
  // YouTube's player fights direct currentTime changes: use its own API when it has one.
  await site.evaluate(() => {
    const player = document.querySelector('#movie_player')
    if (player && typeof player.seekTo === 'function') player.seekTo(300, true)
    else {
      const v = [...document.querySelectorAll('video')].find((x) => x.duration > 0)
      if (v) v.currentTime = 300
    }
  })
  await setVideo(site, { play: true })
  report.seekAdMs = await endAds(site)
  const seekStart = Date.now()
  const afterSeek = await waitFor(async () => {
    const v = await videoTime(site)
    const text = await cueText(site)
    return v && v.t >= 300 && text ? text : null
  }, 120_000)
  report.seekCaptionMs = afterSeek ? Date.now() - seekStart : null
  if (!afterSeek) report.afterSeek = await diagnose('seek')
  await setVideo(site, { rate: 1.5 })
  for (let i = 0; i < 10; i++) {
    const v = await videoTime(site)
    samples.push({ t: v?.t ?? null, text: await cueText(site), rate: v?.rate ?? 1 })
    await sleep(1500)
  }
  await setVideo(site, { rate: 1 })

  // The whole video as SRT (by sentence), to check the samples against.
  await popup.bringToFront()
  await popup.getByTestId('download-mode-words').click()
  const dlStart = Date.now()
  await popup.getByTestId('download-srt').click()
  // chrome.downloads doesn't raise Playwright's download event: ask the browser.
  const done = await waitFor(
    () =>
      popup.evaluate(async () =>
        (await chrome.downloads.search({})).find((d) => d.state === 'complete'),
      ),
    600_000,
    1000,
  )
  const srt = done ? readFileSync(done.value.filename, 'utf8') : null
  report.srtMs = srt ? Date.now() - dlStart : null
  if (srt) {
    const cues = parseSrt(srt)
    report.srtCues = cues.length
    // In sync: the last word on screen was spoken (its word cue started) within
    // the last 1.5 s, and not more than 0.3 s ahead of the video.
    const shown = samples.filter((s) => s.text && s.t !== null)
    const lastWord = (text) => norm(text).split(' ').pop()
    const inSync = shown.filter((s) =>
      cues.some(
        (c) =>
          c.start <= s.t + 0.3 &&
          c.start >= s.t - 1.5 * (s.rate || 1) &&
          norm(c.text).split(' ').includes(lastWord(s.text)),
      ),
    )
    report.syncSamples = { shown: shown.length, inSync: inSync.length, of: samples.length }
    report.outOfSync = shown
      .filter((s) => !inSync.includes(s))
      .slice(0, 5)
      .map((s) => ({ t: Number(s.t.toFixed(2)), text: s.text }))
  }

  // T4: in-page navigation to another video; captions follow.
  await site.bringToFront()
  const before = site.url()
  const next = await site.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="/watch?v="]')].find(
      (x) => !x.href.includes(new URL(location.href).searchParams.get('v')) && x.offsetParent,
    )
    if (!a) return null
    a.click()
    return a.href
  })
  report.nextVideo = next
  if (next) {
    await waitFor(async () => site.url() !== before, 20_000)
    await sleep(2000)
    report.nextAdMs = await endAds(site)
    await site.evaluate(() => {
      const v = document.querySelector('video')
      if (v) {
        v.muted = true
        void v.play()
      }
    })
    const followed = await waitFor(async () => (await cueText(site)) || null, 240_000)
    report.followMs = followed?.ms ?? null
    if (!followed) report.afterFollow = await diagnose('follow')
  }
} catch (err) {
  report.error = err instanceof Error ? err.message : String(err)
} finally {
  clearInterval(memTimer)
  report.peakBrowserRssMb = peakRssMb
  await context.close()
  console.log(JSON.stringify(report, null, 2))
}
