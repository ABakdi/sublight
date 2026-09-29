import { defineConfig } from 'vitest/config'

// Coverage floor from the code quality plan: overlay ≥ 80 % (`pnpm coverage`, CI).
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { statements: 80, lines: 80 },
    },
  },
})
