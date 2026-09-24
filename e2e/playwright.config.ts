import { defineConfig } from '@playwright/test'
import { E2E_PLAYER_URL, findBravePath } from './constants'

const bravePath = findBravePath()

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }]] : 'list',
  testIgnore: process.env.EXTENSION_TESTS
    ? ['**/player.spec.ts', '**/engine.spec.ts']
    : ['**/extension.spec.ts'],
  globalSetup: './global-setup.ts',
  use: { baseURL: E2E_PLAYER_URL, trace: 'on-first-retry' },
  webServer: {
    command: 'pnpm --filter @sublight/player dev',
    url: E2E_PLAYER_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium' as const,
        launchOptions: { executablePath: bravePath ?? undefined },
      },
    },
  ],
})
