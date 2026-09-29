import { defineConfig } from 'vitest/config'

// Coverage floor from the code quality plan: core ≥ 90 % (`pnpm coverage`, CI).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { statements: 90, lines: 90 },
    },
  },
})
