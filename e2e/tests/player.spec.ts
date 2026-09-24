import { test, expect } from '@playwright/test'

test.describe('player placeholder (M00.2)', () => {
  test('boots against the dev server and shows the engine status bar', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'sublight player' })).toBeVisible()
    await expect(page.getByTestId('engine-status')).toBeVisible()
    await expect(page.getByText('Local AI subtitles for any video')).toBeVisible()
  })

  test('lists the placeholder actions pinned to later milestones', async ({ page }) => {
    await page.goto('/')
    for (const action of ['Load a video', 'Projects', 'Editor', 'Settings']) {
      await expect(page.getByText(action, { exact: true }).first()).toBeVisible()
    }
  })
})
