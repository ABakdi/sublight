import { execFileSync } from 'node:child_process'
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
import { E2E_TOKEN } from '../constants'

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
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>site</title><style>body{margin:0}video{width:640px;height:360px}</style>
          <video src="/clip.mp4" muted playsinline></video>`,
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
    await popup.getByTestId('live-toggle').click()
    await expect(popup.getByTestId('live-status')).toHaveAttribute('data-phase', 'done', {
      timeout: 60_000,
    })
    // The finished track can be saved as SRT from the popup.
    await expect(popup.getByTestId('live-download')).toContainText('Download SRT (')
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
