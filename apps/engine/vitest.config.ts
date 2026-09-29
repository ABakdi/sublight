import { configDefaults, defineConfig } from 'vitest/config'

const INTEGRATION = 'tests/*.integration.test.ts'

export default defineConfig({
  test: {
    // Several engine tests run real timers (live passes, leases, sockets). A
    // shared CI runner can stall long enough to miss one; retry there, stay
    // strict locally so a real regression still fails.
    retry: process.env.CI ? 2 : 0,
    // Coverage floor from the code quality plan: the job queue ≥ 85 % (`pnpm coverage`, CI).
    coverage: {
      provider: 'v8',
      include: ['src/jobs/**'],
      thresholds: { statements: 85, lines: 85 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, INTEGRATION],
          sequence: { groupOrder: 0 },
        },
      },
      {
        // The real models (skipped where they aren't installed): one file at a
        // time after the unit tests. Together they don't fit a 4 GB GPU, and
        // they starve the ffmpeg tests of CPU.
        extends: true,
        test: {
          name: 'integration',
          include: [INTEGRATION],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
