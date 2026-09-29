import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { copyFileSync, readFileSync } from 'node:fs'

const VIDEO_FIXTURE = resolve(process.cwd(), 'fixtures', 'video-4s.mp4')
const SRT_FIXTURE = resolve(process.cwd(), 'fixtures', 'captions.en.srt')

/** Currently rendered cue text from inside the overlay's shadow root. */
function readOverlayText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-sublight-host]')
    return host?.shadowRoot?.querySelector('.sl-cue')?.textContent ?? ''
  })
}

/** Move focus off the hidden file inputs so keyboard shortcuts reach the app. */
async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

async function openFixture(page: Page): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('input[data-testid="file-input"]', VIDEO_FIXTURE)
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && Number.isFinite(v.duration) && v.duration > 3
  })
}

test.describe('player (M01)', () => {
  test('plays like VLC and YouTube: keys, taps, the shortcut sheet (M06b.11)', async ({ page }) => {
    await openFixture(page)
    await blurActiveElement(page)
    const time = () => page.evaluate(() => document.querySelector('video')!.currentTime)
    const paused = () => page.evaluate(() => document.querySelector('video')!.paused)

    // K plays and pauses; 0-9 jump; L and J move 10 s (clamped to this 4 s clip).
    await page.keyboard.press('k')
    await expect.poll(paused).toBe(false)
    await page.keyboard.press('k')
    await expect.poll(paused).toBe(true)
    await page.keyboard.press('5')
    await expect.poll(time).toBeCloseTo(2, 0)
    await page.keyboard.press('j')
    await expect.poll(time).toBe(0)
    await page.keyboard.press('ArrowRight')
    await expect.poll(time).toBeGreaterThan(3.9)

    // Speed: ] faster, = normal; M mutes.
    await page.keyboard.press(']')
    await expect(page.getByTestId('rate')).toHaveValue('1.25')
    await page.keyboard.press('=')
    await expect(page.getByTestId('rate')).toHaveValue('1')
    await page.keyboard.press('m')
    await expect.poll(() => page.evaluate(() => document.querySelector('video')!.muted)).toBe(true)

    // Double-click the left third: back 10 s, with its ripple.
    await page.keyboard.press('Home')
    await page.keyboard.press('3')
    const stage = (await page.getByTestId('gesture-layer').boundingBox())!
    await page.mouse.dblclick(stage.x + stage.width * 0.15, stage.y + stage.height / 2)
    await expect(page.getByTestId('flash-left')).toHaveText('−10 s')
    await expect.poll(time).toBe(0)

    // A single click plays (once no second click follows).
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2)
    await expect.poll(paused).toBe(false)
    await page.keyboard.press('k')

    // ? lists the live bindings; Escape closes it.
    await page.keyboard.press('?')
    await expect(page.getByTestId('shortcut-sheet')).toContainText('Captions 50 ms later')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('shortcut-sheet')).toHaveCount(0)

    // Shortcuts don't fire while typing.
    await page.getByTestId('panel-tracks').click()
    await page.getByRole('textbox').first().focus()
    await page.keyboard.press('k')
    await expect.poll(paused).toBe(true)
  })

  test('plays several videos one after another: N, P, and the end of each (M06b.11)', async ({
    page,
  }, info) => {
    const second = info.outputPath('second-clip.mp4')
    copyFileSync(VIDEO_FIXTURE, second)
    await page.goto('/')
    await page.setInputFiles('input[data-testid="file-input"]', [VIDEO_FIXTURE, second])
    const title = page.locator('main h1')
    await expect(title).toHaveText('video-4s')
    await blurActiveElement(page)
    await page.keyboard.press('n')
    await expect(title).toHaveText('second-clip')
    await page.keyboard.press('n') // nothing after it
    await expect(page.getByTestId('flash-top')).toHaveText('No next video in the queue')
    await page.keyboard.press('p')
    await expect(title).toHaveText('video-4s')
    // The end of a video plays the next one.
    await page.waitForFunction(() => Number.isFinite(document.querySelector('video')?.duration))
    await page.evaluate(() => {
      const v = document.querySelector('video')!
      v.currentTime = v.duration - 0.2
      void v.play()
    })
    await expect(title).toHaveText('second-clip', { timeout: 10_000 })
  })

  test('the library shows a frame of each video and how far it was watched (M06b.10)', async ({
    page,
  }) => {
    await openFixture(page)
    await page.evaluate(async () => {
      const v = document.querySelector('video')!
      v.currentTime = 2
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
      v.dispatchEvent(new Event('pause')) // saves the position, as pausing does
    })
    await page.getByTestId('back-to-library').click()
    const card = page.getByTestId('library-project').first()
    await expect(card.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
    await expect(card.getByTestId('library-progress')).toBeVisible()
  })

  test('switches between the system, light and dark themes, remembered (M06b.10)', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
    await expect.poll(theme).toBe('light') // follows the system
    await page.getByTestId('theme-toggle').click() // light
    await page.getByTestId('theme-toggle').click() // dark
    await expect.poll(theme).toBe('dark')
    await page.reload()
    await expect.poll(theme).toBe('dark')
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await page.getByTestId('theme-toggle').click() // system → light here
    await expect.poll(theme).toBe('light')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bg)
  })

  test('boots to the library', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'sublight player' })).toBeVisible()
    await expect(page.getByTestId('engine-status')).toBeVisible()
    await expect(page.getByTestId('open-video')).toBeVisible()
  })

  test('opens a local file, imports SRT, and renders cues synced to playback', async ({ page }) => {
    await openFixture(page)
    await page.setInputFiles('input[data-testid="track-import-input"]', SRT_FIXTURE)
    await expect(page.getByText('en', { exact: true })).toBeVisible()
    await expect(page.getByText('3 cues')).toBeVisible()

    // Seek into cue 1 (600-1600 ms) and wait for the rAF loop to pick it up.
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 0.75
    })
    await expect.poll(async () => readOverlayText(page)).toContain('First line of captions')

    // Geometry: the cue box sits inside the play region (bottom anchor).
    const cueBox = await page.evaluate(() => {
      const host = document.querySelector('[data-sublight-host]')
      const hostRect = host?.getBoundingClientRect()
      const cue = host?.shadowRoot?.querySelector('.sl-cue') as HTMLElement | null
      const cueRect = cue?.getBoundingClientRect()
      if (!hostRect || !cueRect) return null
      return {
        inside:
          cueRect.left >= hostRect.left - 1 &&
          cueRect.right <= hostRect.right + 1 &&
          cueRect.top >= hostRect.top - 1 &&
          cueRect.bottom <= hostRect.bottom + 1,
        nearBottom: cueRect.bottom > hostRect.bottom - hostRect.height * 0.2,
      }
    })
    expect(cueBox?.inside).toBe(true)
    expect(cueBox?.nearBottom).toBe(true)

    // Outside every cue: nothing renders.
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 1.8
    })
    await expect.poll(async () => readOverlayText(page)).toBe('')

    // H delays the captions 50 ms (VLC's key), G brings them back.
    await blurActiveElement(page)
    await page.keyboard.press('h')
    await expect(page.getByTestId('track-offset')).toHaveText('+50 ms')
    await page.keyboard.press('g')
    await expect(page.getByTestId('track-offset')).toHaveText('0 ms')
  })

  test('sync nudge shifts cues live and persists the offset', async ({ page }) => {
    await openFixture(page)
    await page.setInputFiles('input[data-testid="track-import-input"]', SRT_FIXTURE)
    await expect(page.getByTestId('track-offset')).toHaveText('0 ms')

    // +50 ms shifts cue 1 to 650-1650; 615 ms is inside cue 1 only without the offset.
    await page.getByTestId('nudge-plus').click()
    await expect(page.getByTestId('track-offset')).toHaveText('+50 ms')

    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 0.615
    })
    await expect.poll(async () => readOverlayText(page)).toBe('')

    // Back to 0 offset -> the cue is active at 615 ms again.
    await page.getByTestId('nudge-minus').click()
    await expect(page.getByTestId('track-offset')).toHaveText('0 ms')
    await expect.poll(async () => readOverlayText(page)).toContain('First line of captions')
  })

  test('SRT export round-trips byte-for-byte and projects survive reload', async ({ page }) => {
    await openFixture(page)
    await page.setInputFiles('input[data-testid="track-import-input"]', SRT_FIXTURE)
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 0.75
    })
    await expect.poll(async () => readOverlayText(page)).toContain('First line of captions')

    // Export: filename is {project-title}.{lang}.srt — title comes from the video name.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-srt').click(),
    ])
    expect(download.suggestedFilename()).toBe('video-4s.en.srt')
    const path = await download.path()
    expect(path).not.toBeNull()
    const exported = readFileSync(path!, 'utf8').replace(/\r/g, '')
    const fixture = readFileSync(SRT_FIXTURE, 'utf8').replace(/\r/g, '')
    expect(exported).toBe(fixture)

    // Reload: the project persists in IndexedDB and shows in the library.
    await page.reload()
    await expect(page.getByTestId('open-video')).toBeVisible()
    await expect(page.getByText('video-4s', { exact: true })).toBeVisible()
    await expect(page.getByText('1 track')).toBeVisible()

    // Re-opening without a stored handle surfaces the re-attach prompt.
    await page.getByText('video-4s', { exact: true }).click()
    await expect(page.getByText(/original file isn't available/i)).toBeVisible()
  })

  test('style changes apply live to the overlay (Spec 05 §5)', async ({ page }) => {
    await openFixture(page)
    await page.setInputFiles('input[data-testid="track-import-input"]', SRT_FIXTURE)
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 0.75
    })
    await expect.poll(async () => readOverlayText(page)).toContain('First line of captions')

    // Switch to the style panel; gold text anchored top-right.
    await page.getByRole('button', { name: /style/i }).click()
    await page.getByTestId('style-color').fill('#ffd700')
    await page.getByTestId('style-anchor').selectOption('top-right')

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const host = document.querySelector('[data-sublight-host]')
          const cue = host?.shadowRoot?.querySelector('.sl-cue') as HTMLElement | null
          const hostRect = host?.getBoundingClientRect()
          if (!cue || !hostRect) return null
          const rect = cue.getBoundingClientRect()
          return {
            color: getComputedStyle(cue).color,
            nearTop: rect.bottom < hostRect.top + hostRect.height * 0.5,
          }
        }),
      )
      .toMatchObject({ color: 'rgb(255, 215, 0)', nearTop: true })
  })
})
