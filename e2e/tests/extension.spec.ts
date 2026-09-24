import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, chromium } from '@playwright/test'

/**
 * M00.3 acceptance: the unpacked MV3 extension loads and the content script
 * logs on a test page. Extensions need a persistent context; use Playwright's
 * `chromium` channel so they also work in headless mode (no X server needed —
 * CI and headless runners alike). Opt in with EXTENSION_TESTS=1
 * (see `pnpm e2e:extension`).
 */
test.describe('extension unpacked load (M00.3)', () => {
  test.skip(!process.env.EXTENSION_TESTS, 'set EXTENSION_TESTS=1 to run the extension spec')

  test('content script logs on the player origin', async () => {
    const extensionPath = resolve(process.cwd(), '..', 'apps', 'extension', '.output', 'chrome-mv3')
    const userDataDir = mkdtempSync(join(tmpdir(), 'sublight-ext-'))
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    })
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      const logs: string[] = []
      page.on('console', (m) => logs.push(m.text()))
      await page.goto('http://127.0.0.1:5173/')
      await page.waitForTimeout(1200) // content script at document_idle
      expect(logs.some((l) => l.includes('[sublight] content script loaded'))).toBe(true)
    } finally {
      await context.close()
    }
  })
})
