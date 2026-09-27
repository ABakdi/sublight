import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test'
import { DEV_EXTENSION_ID } from '@sublight/protocol'
import { E2E_PLAYER_URL, E2E_TOKEN } from '../constants'

/**
 * The unpacked MV3 build in a real Chromium: stable ID, engine pairing,
 * video discovery and test captions over a page video. Extensions need a
 * persistent context; the `chromium` channel runs them headless too (no X
 * server). Opt in with EXTENSION_TESTS=1 (`pnpm e2e:extension`); the global
 * setup starts the engine with E2E_TOKEN.
 */
const EXT = `chrome-extension://${DEV_EXTENSION_ID}`
const SITE = 'http://video-site.test'
/** The slice of the extension API these pages call (e2e has no chrome types). */
type ChromeTabs = { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } }

const fixtureVideo = readFileSync(resolve(process.cwd(), 'fixtures', 'video-4s.mp4'))
/** What the stand-in site serves at /clip.mp4 (tests can swap in a speech clip). */
let served: Buffer = fixtureVideo
/** An HLS rendition of the fixture (made with ffmpeg when a test needs it). */
let hlsDir: string | null = null
/** 'missing': the playlist 404s (a dead or blocked stream). */
let hlsMode: 'ok' | 'missing' = 'ok'

/** Byte-range responses: without them the media element can't seek. */
function fulfillVideo(range: string | undefined, route: Route) {
  const size = served.length
  const m = /bytes=(\d+)-(\d*)/.exec(range ?? '')
  if (!m) {
    return route.fulfill({
      body: served,
      contentType: 'video/mp4',
      headers: { 'accept-ranges': 'bytes' },
    })
  }
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : size - 1
  return route.fulfill({
    status: 206,
    body: served.subarray(start, end + 1),
    contentType: 'video/mp4',
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` },
  })
}

test.describe('extension in Chromium (Spec 09)', () => {
  test.skip(!process.env.EXTENSION_TESTS, 'set EXTENSION_TESTS=1 to run the extension spec')

  let context: BrowserContext

  test.beforeEach(async () => {
    const extensionPath = resolve(process.cwd(), '..', 'apps', 'extension', '.output', 'chrome-mv3')
    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'sublight-ext-')), {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
    // A stand-in "third-party site" with a <video>, served without a network.
    await context.route(`${SITE}/**`, (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/clip.mp4') return fulfillVideo(route.request().headers().range, route)
      if (url.pathname.startsWith('/hls/') && hlsDir) {
        if (hlsMode === 'missing') return route.fulfill({ status: 404, body: 'gone' })
        return route.fulfill({
          body: readFileSync(join(hlsDir, url.pathname.slice(5))),
          contentType: url.pathname.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : 'video/mp2t',
          // hls.js (browsers without native HLS) needs CORS; native playback doesn't.
          headers: { 'access-control-allow-origin': '*' },
        })
      }
      const src = url.pathname === '/watch-hls' ? '/hls/index.m3u8' : '/clip.mp4'
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>site</title><style>body{margin:0}video{width:640px;height:360px}</style>
          <video src="${src}" muted playsinline></video>`,
      })
    })
  })

  test.afterEach(async () => {
    await context.close()
    served = fixtureVideo
  })

  async function openPopupFor(site: Page): Promise<Page> {
    await site.bringToFront()
    const popup = await context.newPage()
    await popup.goto(`${EXT}/popup.html`)
    // Without the `tabs` permission other tabs' URLs are hidden: the one
    // that isn't an extension page is the site.
    const tabId = await popup.evaluate(
      async () =>
        (await (globalThis as unknown as { chrome: ChromeTabs }).chrome.tabs.query({})).find(
          (t) => !t.url?.startsWith('chrome-extension'),
        )!.id,
    )
    await popup.goto(`${EXT}/popup.html?tab=${tabId}`)
    // Live and test captions live under "More".
    await popup.locator('summary', { hasText: 'More' }).click()
    return popup
  }

  test('content script logs on a page', async () => {
    const page = context.pages()[0] ?? (await context.newPage())
    const logs: string[] = []
    page.on('console', (m) => logs.push(m.text()))
    await page.goto(`${SITE}/watch`)
    await expect
      .poll(() => logs.some((l) => l.includes('[sublight] content script loaded')))
      .toBe(true)
  })

  test('loads with the pinned dev ID and pairs with the engine', async () => {
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    await expect(options.getByTestId('extension-id')).toHaveText(DEV_EXTENSION_ID)
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'no-token')

    await options.getByTestId('token-input').fill('f'.repeat(64))
    await options.getByTestId('token-save').click()
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'unauthorized')

    await options.getByTestId('token-input').fill(E2E_TOKEN)
    await options.getByTestId('token-save').click()
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
  })

  test('popup sees the page video and test captions render over it', async () => {
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch`)
    await site.evaluate(async () => {
      const v = document.querySelector('video')!
      await new Promise((r) =>
        v.readyState >= 1 ? r(null) : v.addEventListener('loadedmetadata', r),
      )
      v.currentTime = 1 // inside the first test cue (0.0–2.0 s)
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
    })

    const popup = await openPopupFor(site)
    await expect(popup.getByTestId('video-status')).toHaveAttribute('data-videos', '1')
    await expect(popup.getByTestId('playhead')).toContainText('Paused')
    await popup.getByTestId('demo-toggle').click()
    await expect(popup.getByTestId('demo-toggle')).toHaveText('Hide test captions')

    // The overlay is rAF-driven, which only runs in the visible tab.
    await site.bringToFront()
    const cue = () =>
      site.evaluate(() => {
        const host = document.querySelector('[data-sublight-frame] [data-sublight-host]')
        return host?.shadowRoot?.querySelector('.sl-cue')?.textContent ?? null
      })
    await expect.poll(cue).toContain('cue starts at 0:00.0')

    // The overlay frame tracks the video's box exactly.
    const boxes = await site.evaluate(() => {
      const r = (el: Element) => {
        const b = el.getBoundingClientRect()
        return [b.left, b.top, b.width, b.height].map(Math.round)
      }
      return [
        r(document.querySelector('video')!),
        r(document.querySelector('[data-sublight-frame]')!),
      ]
    })
    expect(boxes[1]).toEqual(boxes[0])

    // Gap between cues renders nothing; toggling off removes the overlay.
    await site.evaluate(() => (document.querySelector('video')!.currentTime = 2.2))
    await expect.poll(cue).toBe('')
    await popup.getByTestId('demo-toggle').click()
    await expect
      .poll(() => site.evaluate(() => document.querySelectorAll('[data-sublight-frame]').length))
      .toBe(0)
  })

  async function pair(): Promise<void> {
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    await options.getByTestId('token-input').fill(E2E_TOKEN)
    await options.getByTestId('token-save').click()
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
    await options.close()
  }

  test('live captions explain a missing speech model (M05)', async () => {
    test.skip(Boolean(process.env.E2E_REAL_ASR), 'the real models are installed in this run')
    await pair()
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch`)
    const popup = await openPopupFor(site)
    await expect(popup.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
    await popup.getByTestId('live-toggle').click()
    await expect(popup.getByTestId('live-status')).toHaveAttribute('data-phase', 'error')
    await expect(popup.getByTestId('live-status')).toContainText('speech model isn’t installed')
  })

  test('live captions from the element audio, refined on stop (M05, real ASR)', async () => {
    test.skip(!process.env.E2E_REAL_ASR, 'set E2E_REAL_ASR=1 with whisper-small installed locally')
    test.setTimeout(120_000)
    const dir = mkdtempSync(join(tmpdir(), 'sublight-e2e-live-'))
    const clip = join(dir, 'jfk.mp4')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10'],
      ...['-i', resolve(process.cwd(), '..', 'apps', 'engine', 'tests', 'fixtures', 'jfk.wav')],
      ...['-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip],
    ])
    served = readFileSync(clip)
    await pair()
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch`)
    await site.evaluate(() => document.querySelector('video')!.play())
    const popup = await openPopupFor(site)
    await popup.getByTestId('live-toggle').click()
    await expect(popup.getByTestId('live-status')).toHaveAttribute('data-phase', 'listening')
    await expect(popup.getByTestId('live-status')).toContainText('this video’s audio')
    await site.bringToFront()
    await site.waitForFunction(() => document.querySelector('video')!.ended, null, {
      timeout: 30_000,
    })
    await popup.bringToFront()
    // While listening, the draft so far can already be saved.
    await expect(popup.getByTestId('live-download')).toContainText('Download draft SRT so far')
    await popup.getByTestId('live-toggle').click()
    await expect(popup.getByTestId('live-status')).toHaveAttribute('data-phase', 'done', {
      timeout: 60_000,
    })
    // The finished track can be saved as SRT from the popup.
    await expect(popup.getByTestId('live-download')).toContainText('Download SRT (')
    await expect(popup.getByTestId('live-download')).toHaveAttribute('data-final', 'true')
    await site.bringToFront()
    await site.evaluate(() => (document.querySelector('video')!.currentTime = 6.5))
    await expect
      .poll(() =>
        site.evaluate(
          () =>
            document
              .querySelector('[data-sublight-frame] [data-sublight-host]')
              ?.shadowRoot?.querySelector('.sl-cue')?.textContent ?? '',
        ),
      )
      .toMatch(/country/i)
  })

  test('Caption this video explains a missing speech model (ADR-0020)', async () => {
    test.skip(!!process.env.E2E_REAL_ASR, 'the real-ASR engine has the model installed')
    await pair()
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch`)
    const popup = await openPopupFor(site)
    await expect(popup.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
    await popup.getByTestId('captions-toggle').click()
    await expect(popup.getByTestId('captions-error')).toContainText('speech model isn’t installed')
  })

  test('captions ahead of playback from a direct media URL, and the SRT (ADR-0020, real ASR)', async () => {
    test.skip(!process.env.E2E_REAL_ASR, 'set E2E_REAL_ASR=1 with whisper-small installed locally')
    test.setTimeout(120_000)
    const dir = mkdtempSync(join(tmpdir(), 'sublight-e2e-ahead-'))
    const clip = join(dir, 'jfk.mp4')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10'],
      ...['-i', resolve(process.cwd(), '..', 'apps', 'engine', 'tests', 'fixtures', 'jfk.wav')],
      ...['-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip],
    ])
    served = readFileSync(clip)
    // A real HTTP server the engine can fetch from (Playwright routes are browser-only).
    // Loopback page + loopback media: Chrome blocks public pages from loading local media.
    const server: Server = createServer((req, res) => {
      if (req.url?.startsWith('/clip.mp4')) {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = m?.[2] ? Number(m[2]) : served.length - 1
        res.writeHead(m ? 206 : 200, {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
          ...(m ? { 'content-range': `bytes ${start}-${end}/${served.length}` } : {}),
        })
        res.end(served.subarray(start, end + 1))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        '<!doctype html><title>JFK</title><video src="/clip.mp4" style="width:640px;height:360px"></video>',
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      await pair()
      const site = context.pages()[0] ?? (await context.newPage())
      await site.goto(`http://127.0.0.1:${port}/watch`)
      await site.evaluate(() => document.querySelector('video')!.play())
      const popup = await openPopupFor(site)
      await expect(popup.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
      await popup.getByTestId('captions-toggle').click()
      await expect(popup.getByTestId('captions-status')).toHaveAttribute('data-phase', 'done', {
        timeout: 60_000,
      })
      // Exact timing: at 6.5 s the sentence around "country" is on screen.
      await site.bringToFront()
      await site.evaluate(() => {
        const v = document.querySelector('video')!
        v.pause()
        v.currentTime = 6.5
      })
      await expect
        .poll(() =>
          site.evaluate(
            () =>
              document
                .querySelector('[data-sublight-frame] [data-sublight-host]')
                ?.shadowRoot?.querySelector('.sl-cue')?.textContent ?? '',
          ),
        )
        .toMatch(/country/i)
      // The whole video as SRT, by sentence.
      await popup.bringToFront()
      await popup.getByTestId('download-mode-sentences').click()
      await popup.getByTestId('download-srt').click()
      type Dl = { state: string; filename: string }
      const chromeDl = () =>
        popup.evaluate(() =>
          (
            globalThis as unknown as { chrome: { downloads: { search(q: object): Promise<Dl[]> } } }
          ).chrome.downloads.search({}),
        )
      await expect
        .poll(async () => (await chromeDl()).some((d) => d.state === 'complete'))
        .toBe(true)
      const file = (await chromeDl()).find((d) => d.state === 'complete')!.filename
      expect(readFileSync(file, 'utf8')).toMatch(/ask not what your country/i)
    } finally {
      server.close()
    }
  })

  test('Open in Sublight Player hands the page video over (M05b)', async () => {
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    await options.evaluate(
      (url) =>
        (
          globalThis as unknown as {
            chrome: { storage: { local: { set(v: object): Promise<void> } } }
          }
        ).chrome.storage.local.set({ playerUrl: `${url}/` }),
      E2E_PLAYER_URL,
    )
    await options.close()
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch`)
    await site.evaluate(async () => {
      const v = document.querySelector('video')!
      await v.play()
      v.currentTime = 2
    })
    const popup = await openPopupFor(site)
    const [player] = await Promise.all([
      context.waitForEvent('page'),
      popup.getByTestId('open-in-player').click(),
    ])
    await player.waitForLoadState()
    expect(player.url().startsWith(E2E_PLAYER_URL)).toBe(true)
    // The page's own file plays in the Player, from where the page was.
    await expect(player.getByTestId('video')).toHaveAttribute('src', `${SITE}/clip.mp4`)
    await expect
      .poll(() =>
        player.evaluate(
          () => (document.querySelector('[data-testid=video]') as HTMLVideoElement).currentTime,
        ),
      )
      .toBeGreaterThan(1.5)
    // …and no longer on its page.
    expect(await site.evaluate(() => document.querySelector('video')!.paused)).toBe(true)
  })

  /** Point the extension at the e2e Player, paired with the e2e engine. */
  async function usePlayer(): Promise<void> {
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    await options.evaluate(
      (url) =>
        (
          globalThis as unknown as {
            chrome: { storage: { local: { set(v: object): Promise<void> } } }
          }
        ).chrome.storage.local.set({ playerUrl: `${url}/` }),
      E2E_PLAYER_URL,
    )
    await options.goto(E2E_PLAYER_URL)
    await options.evaluate((t) => localStorage.setItem('sublight.token', t), E2E_TOKEN)
    await options.close()
  }

  function makeHls(): void {
    if (hlsDir) return
    hlsDir = mkdtempSync(join(tmpdir(), 'sublight-e2e-hls-'))
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi'],
      ...['-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
      ...['-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod'],
      join(hlsDir, 'index.m3u8'),
    ])
  }

  async function openHlsPage(): Promise<Page> {
    makeHls()
    await usePlayer()
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch-hls`)
    const popup = await openPopupFor(site)
    await expect(popup.getByTestId('video-status')).not.toHaveAttribute('data-videos', '0')
    const [player] = await Promise.all([
      context.waitForEvent('page'),
      popup.getByTestId('open-in-player').click(),
    ])
    await player.waitForLoadState()
    return player
  }

  test('an HLS page plays in the Player (M05b.4)', async () => {
    hlsMode = 'ok'
    const player = await openHlsPage()
    await expect(player.getByTestId('video')).toBeVisible()
    // Natively where the browser can, else hls.js (a blob: MediaSource source).
    await expect
      .poll(() =>
        player.evaluate(() => {
          const v = document.querySelector('[data-testid=video]') as HTMLVideoElement
          return v.readyState >= 2 && v.duration > 5
        }),
      )
      .toBe(true)
  })

  test('a page video that can’t be reached explains itself (M05b.6)', async () => {
    // The stream is gone, and the engine can't reach this made-up host
    // either: an honest message and a way forward, never a hang.
    hlsMode = 'missing'
    const player = await openHlsPage()
    const error = player.getByTestId('page-video-error')
    await expect(error).toBeVisible({ timeout: 30_000 })
    await expect(error).toHaveAttribute('data-code', 'MEDIA_UNREACHABLE')
    await expect(player.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('pairs in one click: approve on the engine’s page (ADR-0022)', async () => {
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'no-token')
    const [approval] = await Promise.all([
      context.waitForEvent('page'),
      options.getByTestId('pair-engine').click(),
    ])
    await approval.waitForLoadState()
    expect(approval.url()).toMatch(/^http:\/\/127\.0\.0\.1:17421\/pair\?request=/)
    // The same code on both sides.
    const code = await approval.locator('[data-code]').textContent()
    await expect(options.getByTestId('pair-status')).toContainText(code!.trim())
    await approval.getByRole('button', { name: 'Approve' }).click()
    await expect(approval.getByRole('status')).toContainText('Approved')
    await expect(options.getByTestId('pair-status')).toHaveAttribute('data-state', 'paired')
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
  })

  test('caption size and position toggles apply to the overlay (M05.7)', async () => {
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch`)
    const popup = await openPopupFor(site)
    await popup.getByTestId('size-L').click()
    await popup.getByTestId('anchor-top').click()
    await popup.getByTestId('demo-toggle').click()
    await site.bringToFront()
    const box = () =>
      site.evaluate(() => {
        const cue = document
          .querySelector('[data-sublight-frame] [data-sublight-host]')
          ?.shadowRoot?.querySelector('.sl-cue') as HTMLElement | null
        return cue ? getComputedStyle(cue.parentElement!).alignItems : null
      })
    await expect.poll(box).toBe('flex-start') // top
  })
})
