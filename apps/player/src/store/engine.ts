import { create } from 'zustand'
import { fetchEngineHealth, type HealthResult } from '../lib/engine'

interface EngineState {
  status: 'checking' | 'online' | 'offline'
  health?: HealthResult['health']
  lastError?: string
  /** Poll /v1/health once (used on load + visibilitychange). */
  check: () => Promise<void>
}

export const useEngineStore = create<EngineState>((set) => ({
  status: 'checking',
  check: async () => {
    const result = await fetchEngineHealth()
    set(
      result.state === 'online'
        ? { status: 'online', health: result.health, lastError: undefined }
        : { status: 'offline', lastError: result.error },
    )
  },
}))
