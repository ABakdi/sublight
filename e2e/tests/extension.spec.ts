import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import {
  E2E_ENGINE_HEALTH_URL,
  E2E_ENGINE_URL,
  E2E_PLAYER_URL,
  E2E_TOKEN,
  findBravePath,
} from '../constants'

/**
 * The unpacked MV3 build in a real Chromium: stable ID, engine pairing,
 * video discovery and test captions over a page video. Extensions need a
 * persistent context; the `chromium` channel runs them headless too (no X
 * server). Opt in with EXTENSION_TESTS=1 (`pnpm e2e:extension`); the global
 * setup starts the engine with E2E_TOKEN.
 */
const EXT = `chrome-extension://${DEV_EXTENSION_ID}`
const BRAVE = process.env.E2E_BRAVE ? findBravePath() : null
if (process.env.E2E_BRAVE && !BRAVE) throw new Error('E2E_BRAVE: Brave not found')
const SITE = 'http://video-site.test'
/** The slice of the extension API these pages call (e2e has no chrome types). */
type ChromeTabs = { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } }

const fixtureVideo = readFileSync(resolve(process.cwd(), 'fixtures', 'video-4s.mp4'))
/** What the stand-in site serves at /clip.mp4 (tests can swap in a speech clip). */
let served: Buffer = fixtureVideo
/** HLS and DASH renditions of the fixture (made with ffmpeg when a test needs them). */
const streamDirs: { hls?: string; dash?: string } = {}
/** 'missing': the playlist 404s (a dead or blocked stream). */
let hlsMode: 'ok' | 'missing' = 'ok'
const STREAM_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mpd: 'application/dash+xml',
  m4s: 'video/iso.segment',
}
const streamType = (file: string) => STREAM_TYPES[file.split('.').pop() ?? ''] ?? 'video/mp4'

/** The fixture as a stream: HLS (`index.m3u8`) or DASH (`index.mpd`), 2 s segments. */
function makeStream(kind: 'hls' | 'dash', source?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sublight-e2e-${kind}-`))
  const input = source
    ? ['-i', source]
    : [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440',
      ]
  const format =
    kind === 'hls'
      ? ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', join(dir, 'index.m3u8')]
      : ['-f', 'dash', '-seg_duration', '2', join(dir, 'index.mpd')]
  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y', ...input, ...(source ? [] : ['-t', '6'])],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...format],
  ])
  return dir
}

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

  const launch = (profile: string, env?: Record<string, string>) => {
    const extensionPath = resolve(process.cwd(), '..', 'apps', 'extension', '.output', 'chrome-mv3')
    return chromium.launchPersistentContext(profile, {
      ...(env ? { env: { ...process.env, ...env } as Record<string, string> } : {}),
      // E2E_BRAVE=1: the same suite in Brave (the Chromium + Brave matrix).
      ...(BRAVE ? { executablePath: BRAVE } : { channel: 'chromium' }),
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
  }

  test.beforeEach(async () => {
    context = await launch(mkdtempSync(join(tmpdir(), 'sublight-ext-')))
    // A stand-in "third-party site" with a <video>, served without a network.
    await context.route(`${SITE}/**`, (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/clip.mp4') return fulfillVideo(route.request().headers().range, route)
      const kind = /^\/(hls|dash)\//.exec(url.pathname)?.[1] as 'hls' | 'dash' | undefined
      const dir = kind && streamDirs[kind]
      if (kind && dir) {
        if (hlsMode === 'missing') return route.fulfill({ status: 404, body: 'gone' })
        return route.fulfill({
          body: readFileSync(join(dir, url.pathname.slice(kind.length + 2))),
          contentType: streamType(url.pathname),
          // hls.js and dash.js need CORS; native playback doesn't.
          headers: { 'access-control-allow-origin': '*' },
        })
      }
      const src =
        url.pathname === '/watch-hls'
          ? '/hls/index.m3u8'
          : url.pathname === '/watch-dash'
            ? '/dash/index.mpd'
            : '/clip.mp4'
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

  test('takes the engine’s token from the native host: no pairing (M06b.3)', async () => {
    // What install.sh does: register `sublight-engine native-host`, here run
    // from source against the e2e engine's home. Chromium looks for hosts in
    // its config home (not the profile), which XDG_CONFIG_HOME moves.
    const config = mkdtempSync(join(tmpdir(), 'sublight-ext-host-'))
    const repo = resolve(process.cwd(), '..')
    const wrapper = join(config, 'native-host')
    writeFileSync(
      wrapper,
      `#!/bin/sh\nSUBLIGHT_HOME="${process.env.E2E_ENGINE_HOME}" exec "${repo}/apps/engine/node_modules/.bin/tsx" "${repo}/apps/engine/src/main.ts" native-host "$@"\n`,
    )
    chmodSync(wrapper, 0o755)
    const manifest = JSON.stringify({
      name: 'sublight.engine',
      description: 'sublight engine (e2e)',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`${EXT}/`],
    })
    for (const product of [
      'chromium',
      'google-chrome-for-testing',
      'BraveSoftware/Brave-Browser',
    ]) {
      mkdirSync(join(config, product, 'NativeMessagingHosts'), { recursive: true })
      writeFileSync(join(config, product, 'NativeMessagingHosts', 'sublight.engine.json'), manifest)
    }
    await context.close()
    context = await launch(mkdtempSync(join(tmpdir(), 'sublight-ext-')), {
      XDG_CONFIG_HOME: config,
    })
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    // Nothing pasted, nothing approved: the host handed the token over.
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'online', {
      timeout: 15_000,
    })
    const where = await options.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          chrome: { storage: Record<string, { get(k: string): Promise<Record<string, unknown>> }> }
        }
      ).chrome
      return {
        session: (await c.storage.session!.get('engineTokenFromHost')).engineTokenFromHost,
        local: (await c.storage.local!.get('engineToken')).engineToken,
      }
    })
    expect(where).toEqual({ session: E2E_TOKEN, local: undefined })

    // Everything in one place (M06b.6-8): the engine and its models in the popup.
    const popup = await context.newPage()
    await popup.goto(`${EXT}/popup.html`)
    await popup.getByTestId('tab-engine').click()
    await expect(popup.getByTestId('engine-card')).toHaveAttribute('data-state', 'on', {
      timeout: 15_000,
    })
    await expect(popup.getByTestId('engine-switch')).toHaveText('Turn off')
    await expect(popup.getByTestId('keep-running')).toBeVisible()
    await popup.getByTestId('tab-models').click()
    await expect(popup.getByTestId('models-card')).toHaveAttribute('data-state', 'on')
    await expect(popup.getByTestId('model-whisper-small')).toBeVisible()
    await popup.getByTestId('tab-settings').click()
    await expect(popup.getByTestId('caption-model-select')).toBeVisible()
    // Developer mode: where the models run.
    await expect(popup.getByTestId('device-choice')).toHaveCount(0)
    await popup.getByTestId('developer-mode').check()
    await expect(popup.getByTestId('device-gpu')).toBeVisible()
    await expect(popup.getByTestId('token-input')).toBeVisible() // pairing by hand
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

  /**
   * A real HTTP site the engine can fetch (Playwright routes are browser-only)
   * serving the JFK clip as a video. Loopback page + loopback media: Chrome
   * blocks public pages from loading local media. `/next` is a second page
   * with the same clip, for following a feed. `/watch-hls` plays it as HLS;
   * `/watch-blob` plays it from a blob: URL, with no file for the extension
   * to hand over, and names the file in `og:video` for the engine (yt-dlp's
   * generic extractor), the way a site like YouTube needs the engine.
   */
  async function speechSite(): Promise<{ port: number; server: Server }> {
    const dir = mkdtempSync(join(tmpdir(), 'sublight-e2e-ahead-'))
    const clip = join(dir, 'jfk.mp4')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10'],
      ...['-i', resolve(process.cwd(), '..', 'apps', 'engine', 'tests', 'fixtures', 'jfk.wav')],
      ...['-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip],
    ])
    served = readFileSync(clip)
    let hls: string | null = null
    const server: Server = createServer((req, res) => {
      if (req.url?.startsWith('/hls/')) {
        hls ??= makeStream('hls', clip)
        res.writeHead(200, {
          'content-type': streamType(req.url),
          'access-control-allow-origin': '*',
        })
        res.end(readFileSync(join(hls, req.url.slice(5).split('?')[0]!)))
        return
      }
      if (req.url?.startsWith('/clip.mp4')) {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = m?.[2] ? Number(m[2]) : served.length - 1
        res.writeHead(m ? 206 : 200, {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
          'access-control-allow-origin': '*',
          ...(m ? { 'content-range': `bytes ${start}-${end}/${served.length}` } : {}),
        })
        res.end(served.subarray(start, end + 1))
        return
      }
      const video = 'style="width:640px;height:360px"'
      res.writeHead(200, { 'content-type': 'text/html' })
      if (req.url === '/watch-blob') {
        res.end(
          `<!doctype html><title>JFK</title>` +
            `<meta property="og:video" content="http://${req.headers.host}/clip.mp4">` +
            `<meta property="og:video:type" content="video/mp4">` +
            `<video ${video}></video><script>fetch('/clip.mp4').then((r) => r.blob())` +
            `.then((b) => { document.querySelector('video').src = URL.createObjectURL(b) })</script>`,
        )
        return
      }
      const src = req.url === '/watch-hls' ? '/hls/index.m3u8' : '/clip.mp4'
      res.end(`<!doctype html><title>JFK</title><video src="${src}" ${video}></video>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    return { port, server }
  }

  // One url or live job at a time: a new one replaces the running one (one viewer, one video).
  test.describe.serial('with real speech recognition', () => {
    test('captions follow the next video of a feed (Spec 09 §4.8, real ASR)', async () => {
      test.skip(
        !process.env.E2E_REAL_ASR,
        'set E2E_REAL_ASR=1 with whisper-small installed locally',
      )
      test.setTimeout(150_000)
      const { port, server } = await speechSite()
      const urlJobs = async () =>
        (
          (await (
            await fetch(E2E_ENGINE_HEALTH_URL.replace('/v1/health', '/v1/jobs'), {
              headers: { authorization: `Bearer ${E2E_TOKEN}` },
            })
          ).json()) as { jobs: { type: string }[] }
        ).jobs.filter((j) => j.type === 'url').length
      try {
        await pair()
        const before = await urlJobs()
        const site = context.pages()[0] ?? (await context.newPage())
        await site.goto(`http://127.0.0.1:${port}/watch`)
        await site.evaluate(() => document.querySelector('video')!.play())
        const popup = await openPopupFor(site)
        await popup.getByTestId('captions-toggle').click()
        await expect(popup.getByTestId('captions-status')).toHaveAttribute('data-phase', 'done', {
          timeout: 60_000,
        })
        await popup.close()
        // The feed moves on: a new URL and a new video element, as a SPA does.
        await site.bringToFront()
        await site.evaluate(() => {
          history.pushState(null, '', '/next')
          const old = document.querySelector('video')!
          const next = document.createElement('video')
          next.src = '/clip.mp4?next'
          next.style.cssText = old.style.cssText
          old.replaceWith(next)
          void next.play()
        })
        // A second url job, for the new video, started by the page's own report.
        await expect.poll(urlJobs, { timeout: 60_000 }).toBe(before + 2)
        await site.evaluate(() => {
          const v = document.querySelector('video')!
          v.pause()
          v.currentTime = 6.5
        })
        await expect
          .poll(
            () =>
              site.evaluate(
                () =>
                  document
                    .querySelector('[data-sublight-frame] [data-sublight-host]')
                    ?.shadowRoot?.querySelector('.sl-cue')?.textContent ?? '',
              ),
            { timeout: 60_000 },
          )
          .toMatch(/country/i)
        // YouTube-style: the same element gets a new URL and source. Exactly one
        // more job: the URL check must not undo the follow and start a second.
        await site.evaluate(() => {
          history.pushState(null, '', '/third')
          const v = document.querySelector('video')!
          v.src = '/clip.mp4?third'
          void v.play()
        })
        await expect.poll(urlJobs, { timeout: 60_000 }).toBe(before + 3)
        await site.waitForTimeout(5000) // past the 2 s URL check
        expect(await urlJobs()).toBe(before + 3)
      } finally {
        server.close()
      }
    })

    test('live captions from the element audio, refined on stop (M05, real ASR)', async () => {
      test.skip(
        !process.env.E2E_REAL_ASR,
        'set E2E_REAL_ASR=1 with whisper-small installed locally',
      )
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

      // The refined captions translate from the quick controls (M05.6); needs the LLM.
      const { models } = (await (
        await fetch(`${E2E_ENGINE_URL}/v1/models`, {
          headers: { authorization: `Bearer ${E2E_TOKEN}` },
        })
      ).json()) as { models: { id: string; installed: boolean }[] }
      if (!models.some((m) => m.id === 'qwen3-4b-instruct' && m.installed)) return
      test.setTimeout(240_000)
      await site.getByTestId('qc-open').click()
      await site.getByTestId('qc-target').selectOption('fr')
      await site.evaluate(() => (document.querySelector('video')!.currentTime = 6.5))
      await expect
        .poll(
          () =>
            site.evaluate(
              () =>
                document
                  .querySelector('[data-sublight-frame] [data-sublight-host]')
                  ?.shadowRoot?.querySelector('.sl-cue')?.textContent ?? '',
            ),
          { timeout: 120_000 },
        )
        .toMatch(/pays/i)
      // "Download SRT" saves what the page shows: the translation.
      await popup.bringToFront()
      await expect(popup.getByTestId('live-download')).toHaveAttribute('data-lang', 'fr')
    })

    test('captions ahead of playback from a direct media URL, and the SRT (ADR-0020, real ASR)', async () => {
      test.skip(
        !process.env.E2E_REAL_ASR,
        'set E2E_REAL_ASR=1 with whisper-small installed locally',
      )
      test.setTimeout(120_000)
      const { port, server } = await speechSite()
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
              globalThis as unknown as {
                chrome: { downloads: { search(q: object): Promise<Dl[]> } }
              }
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

    /**
     * Hand the page's video to the Player and caption it there (M05b.7): the
     * engine fetches the audio from the page, T₀ = 0, exact timing.
     */
    async function captionInPlayer(site: Page): Promise<Page> {
      const popup = await openPopupFor(site)
      await expect(popup.getByTestId('video-status')).not.toHaveAttribute('data-videos', '0')
      const [player] = await Promise.all([
        context.waitForEvent('page'),
        popup.getByTestId('open-in-player').click(),
      ])
      await player.waitForLoadState()
      await player.getByTestId('handoff-open').click({ timeout: 15_000 })
      await expect
        .poll(
          () =>
            player.evaluate(() => {
              const v = document.querySelector('[data-testid=video]') as HTMLVideoElement | null
              return !!v && v.readyState >= 2 && v.duration > 5
            }),
          { timeout: 60_000 },
        )
        .toBe(true)
      await player.getByTestId('panel-caption').click()
      await player.getByTestId('caption-model').selectOption('whisper-small')
      await player.getByTestId('caption-start').click()
      await expect(player.getByTestId('caption-done')).toBeVisible({ timeout: 90_000 })
      await player.evaluate(() => {
        const v = document.querySelector('[data-testid=video]') as HTMLVideoElement
        v.pause()
        v.currentTime = 6.5
      })
      await expect
        .poll(() =>
          player.evaluate(
            () =>
              document.querySelector('[data-sublight-host]')?.shadowRoot?.querySelector('.sl-cue')
                ?.textContent ?? '',
          ),
        )
        .toMatch(/country/i)
      return player
    }

    for (const [page, what] of [
      ['watch', 'a direct file (M05b AC1)'],
      ['watch-hls', 'an HLS stream (M05b AC2)'],
    ] as const) {
      test(`a page video from ${what} plays and captions in the Player (real ASR)`, async () => {
        test.skip(
          !process.env.E2E_REAL_ASR,
          'set E2E_REAL_ASR=1 with whisper-small installed locally',
        )
        test.setTimeout(180_000)
        const { port, server } = await speechSite()
        try {
          await usePlayer()
          const site = context.pages()[0] ?? (await context.newPage())
          await site.goto(`http://127.0.0.1:${port}/${page}`)
          const player = await captionInPlayer(site)
          const src = await player
            .getByTestId('video')
            .evaluate((v) => (v as HTMLVideoElement).currentSrc)
          // The page's own file plays directly; the stream through the browser or hls.js.
          if (page === 'watch') expect(src).toBe(`http://127.0.0.1:${port}/clip.mp4`)
          else expect(src).not.toContain('/v1/relay/')
        } finally {
          server.close()
        }
      })
    }

    test('a page video with no file of its own is relayed by the engine and captions in the Player (M05b AC3, real ASR)', async () => {
      test.skip(
        !process.env.E2E_REAL_ASR,
        'set E2E_REAL_ASR=1 with whisper-small and yt-dlp installed locally',
      )
      test.setTimeout(180_000)
      const { port, server } = await speechSite()
      try {
        await usePlayer()
        const site = context.pages()[0] ?? (await context.newPage())
        await site.goto(`http://127.0.0.1:${port}/watch-blob`)
        await site.waitForFunction(() => document.querySelector('video')!.src.startsWith('blob:'))
        const player = await captionInPlayer(site)
        // Played from the engine's relay ("Preparing media…" first: the site has no single file yt-dlp can pass through).
        await expect(player.getByTestId('video')).toHaveAttribute(
          'src',
          /\/v1\/relay\/[0-9a-f]{32}$/,
        )
        // Seeking works on the relayed file.
        await player.evaluate(() => {
          ;(document.querySelector('[data-testid=video]') as HTMLVideoElement).currentTime = 9
        })
        await expect
          .poll(() =>
            player.evaluate(
              () => (document.querySelector('[data-testid=video]') as HTMLVideoElement).readyState,
            ),
          )
          .toBeGreaterThanOrEqual(2)
      } finally {
        server.close()
      }
    })
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
    // A hand-over only opens once the viewer confirms it (security baseline F6).
    await player.getByTestId('handoff-open').click({ timeout: 15_000 })
    // The page's own file plays in the Player, from where the page was.
    // The Player is Vite's dev server: its first load can be slow under a full run.
    await expect(player.getByTestId('video')).toHaveAttribute('src', `${SITE}/clip.mp4`, {
      timeout: 15_000,
    })
    await expect
      .poll(
        () =>
          player.evaluate(
            () => (document.querySelector('[data-testid=video]') as HTMLVideoElement).currentTime,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(1.5)
    // …and no longer on its page.
    expect(await site.evaluate(() => document.querySelector('video')!.paused)).toBe(true)
  })

  /**
   * Fail with the engine's own output if it's gone: CI logs aren't public,
   * but a test failure's message is (as an annotation).
   */
  async function assertEngineAlive(): Promise<void> {
    const ok = await fetch(E2E_ENGINE_HEALTH_URL, {
      headers: { authorization: `Bearer ${E2E_TOKEN}` },
    }).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return
    let tail = '(no output file)'
    try {
      tail = readFileSync(join(process.env.E2E_ENGINE_HOME ?? '', 'engine-output.txt'), 'utf8')
        .split('\n')
        .slice(-25)
        .join('\n')
    } catch {
      // keep the placeholder
    }
    throw new Error(`the e2e engine is unreachable. Its last output:\n${tail}`)
  }

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

  async function openStreamPage(kind: 'hls' | 'dash' = 'hls'): Promise<Page> {
    streamDirs[kind] ??= makeStream(kind)
    await usePlayer()
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch-${kind}`)
    const popup = await openPopupFor(site)
    await expect(popup.getByTestId('video-status')).not.toHaveAttribute('data-videos', '0')
    const [player] = await Promise.all([
      context.waitForEvent('page'),
      popup.getByTestId('open-in-player').click(),
    ])
    await player.waitForLoadState()
    await player.getByTestId('handoff-open').click({ timeout: 15_000 })
    return player
  }

  test('an HLS page plays in the Player (M05b.4)', async () => {
    hlsMode = 'ok'
    const player = await openStreamPage()
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

  test('a DASH page plays in the Player with dash.js (M05b.4)', async () => {
    hlsMode = 'ok'
    const player = await openStreamPage('dash')
    await expect(player.getByTestId('video')).toBeVisible()
    // Chromium has no native DASH: dash.js feeds the element through MediaSource.
    await expect
      .poll(() =>
        player.evaluate(() => {
          const v = document.querySelector('[data-testid=video]') as HTMLVideoElement
          return v.currentSrc.startsWith('blob:') && v.readyState >= 2 && v.duration > 5
        }),
      )
      .toBe(true)
  })

  test('a page video that can’t be reached explains itself (M05b.6)', async () => {
    // The stream is gone, and the engine can't reach this made-up host
    // either: an honest message and a way forward, never a hang.
    hlsMode = 'missing'
    await assertEngineAlive()
    const player = await openStreamPage()
    const error = player.getByTestId('page-video-error')
    await expect(error).toBeVisible({ timeout: 30_000 })
    await assertEngineAlive()
    await expect(error).toHaveAttribute('data-code', 'MEDIA_UNREACHABLE')
    await expect(player.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('pairs in one click: approve on the engine’s page (ADR-0022)', async () => {
    await assertEngineAlive()
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

  test('the caption style from Options restyles open pages, with a preview (M05.7)', async () => {
    const site = context.pages()[0] ?? (await context.newPage())
    await site.goto(`${SITE}/watch`)
    const popup = await openPopupFor(site)
    await popup.getByTestId('demo-toggle').click()
    const options = await context.newPage()
    await options.goto(`${EXT}/options.html`)
    await options.getByTestId('style-color').fill('#ffee00')
    await options.getByTestId('style-casing').selectOption('uppercase')
    // The preview is drawn by the same overlay as the pages.
    await expect(options.getByTestId('style-preview').locator('.sl-cue')).toHaveCSS(
      'color',
      'rgb(255, 238, 0)',
    )
    const cueColor = () =>
      site.evaluate(() => {
        const cue = document
          .querySelector('[data-sublight-frame] [data-sublight-host]')
          ?.shadowRoot?.querySelector('.sl-cue') as HTMLElement | null
        return cue ? getComputedStyle(cue).color : null
      })
    await expect.poll(cueColor).toBe('rgb(255, 238, 0)')
    await options.getByTestId('style-reset').click()
    await expect.poll(cueColor).toBe('rgb(255, 255, 255)')
    await options.close()
  })

  test('Unpair every app asks first, then forgets the token (M06.3)', async () => {
    await assertEngineAlive()
    const options = await context.newPage()
    // The engine's side is unit-tested; a real rotation would unpair the tests running beside this one.
    let rotated = 0
    await options.route('**/v1/token/rotate', (route) => {
      rotated++
      return route.fulfill({ json: { ok: true } })
    })
    await options.goto(`${EXT}/options.html`)
    await options.getByTestId('token-input').fill(E2E_TOKEN)
    await options.getByTestId('token-save').click()
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
    await options.getByTestId('unpair-all').click()
    expect(rotated).toBe(0)
    await options.getByTestId('unpair-all-yes').click()
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'no-token')
    expect(rotated).toBe(1)
    await expect(options.getByTestId('token-input')).toHaveValue('')
    // Paired again for the tests that follow in this worker's browser.
    await options.getByTestId('token-input').fill(E2E_TOKEN)
    await options.getByTestId('token-save').click()
    await expect(options.getByTestId('engine-status')).toHaveAttribute('data-state', 'online')
    await options.close()
  })
})
