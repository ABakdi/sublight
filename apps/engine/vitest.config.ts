import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Several engine tests run real timers (live passes, leases, sockets). A
    // shared CI runner can stall long enough to miss one; retry there, stay
    // strict locally so a real regression still fails.
    retry: process.env.CI ? 2 : 0,
  },
})
