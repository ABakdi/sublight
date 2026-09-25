import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { E2E_TOKEN } from '../constants'

/**
 * M03: the player talks to the engine. The e2e engine (global-setup) runs
 * with E2E_TOKEN and no models, so the default run covers pairing, the
 * offline card and the model picker. With E2E_REAL_ASR=1 (local, whisper
 * built and whisper-small installed) the full caption journey runs too.
 */
const SILENT_VIDEO = resolve(process.cwd(), 'fixtures', 'video-4s.mp4')

async function openVideo(page: Page, file: string): Promise<void> {
  await page.setInputFiles('input[data-testid="file-input"]', file)
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && Number.isFinite(v.duration) && v.duration > 1
  })
  await page.getByTestId('panel-caption').click()
}

async function pair(page: Page): Promise<void> {
  await page.getByTestId('pairing-token').fill(E2E_TOKEN)
  await page.getByRole('button', { name: 'Pair' }).click()
  await expect(page.getByTestId('caption-panel')).toBeVisible()
  await expect(page.getByTestId('engine-status')).toContainText('engine online')
}

test.describe('captioning (M03)', () => {
  test('pairs with the engine from the caption panel and lists models', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('engine-status')).toHaveText('engine not paired')
    await openVideo(page, SILENT_VIDEO)
    await pair(page)
    const options = await page.getByTestId('caption-model').locator('option').allTextContents()
    expect(options.some((o) => o.startsWith('Whisper small'))).toBe(true)
    // A model that isn't installed offers an install and can't caption yet.
    await page.getByTestId('caption-model').selectOption('whisper-large-v3-q5')
    await expect(page.getByTestId('install-model')).toContainText('Install (1031 MB)')
    await expect(page.getByTestId('caption-start')).toBeDisabled()
    // large-v3-turbo can't translate (ADR-0018): the English option is disabled.
    await page.getByTestId('caption-model').selectOption('whisper-large-v3-turbo-q5')
    await expect(page.getByTestId('caption-translate')).toBeDisabled()
  })

  test('shows an actionable card when the engine is not running (AC5)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sublight.engineUrl', 'http://127.0.0.1:1'))
    await page.goto('/')
    await expect(page.getByTestId('engine-status')).toHaveText('engine offline')
    await openVideo(page, SILENT_VIDEO)
    await expect(page.getByTestId('engine-offline')).toContainText('pnpm dev:engine')
  })

  test.describe('with real speech recognition', () => {
    test.skip(!process.env.E2E_REAL_ASR, 'set E2E_REAL_ASR=1 with whisper-small installed locally')
    test.setTimeout(180_000)

    test('captions a local video end to end and exports the result', async ({ page }) => {
      const dir = mkdtempSync(join(tmpdir(), 'sublight-e2e-speech-'))
      const video = join(dir, 'jfk.mp4')
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=10',
        '-i',
        resolve(process.cwd(), '..', 'apps', 'engine', 'tests', 'fixtures', 'jfk.wav'),
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        video,
      ])
      await page.goto('/')
      await openVideo(page, video)
      await pair(page)
      await page.getByTestId('caption-model').selectOption('whisper-small')
      await page.getByTestId('caption-start').click()
      await expect(page.getByTestId('caption-done')).toBeVisible({ timeout: 120_000 })
      await expect(page.getByTestId('caption-done')).toContainText('· en')

      // "ask not what your country can do for you" is spoken at ~3.5-8 s.
      await page.evaluate(() => (document.querySelector('video')!.currentTime = 6.5))
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.querySelector('[data-sublight-host]')?.shadowRoot?.querySelector('.sl-cue')
                ?.textContent ?? '',
          ),
        )
        .toMatch(/country/i)

      await page.getByTestId('panel-tracks').click()
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export SRT' }).click()
      const srt = readFileSync(await (await download).path(), 'utf8')
      expect(srt).toMatch(/^1\n00:00:0\d,\d{3} --> /)
      expect(srt).toMatch(/fellow Americans/i)
    })
  })
})
