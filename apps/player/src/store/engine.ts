import { create } from 'zustand'
import type { HealthResponse, ModelInfo, WsEvent } from '@sublight/protocol'
import {
  engine,
  engineToken,
  EngineError,
  EngineSocket,
  fetchEngineHealth,
  setEngineToken,
} from '../lib/engine'

export type EngineStatus = 'checking' | 'online' | 'offline' | 'unauthorized'

interface EngineState {
  status: EngineStatus
  health?: HealthResponse
  lastError?: string
  hasToken: boolean
  models: ModelInfo[]
  /** Poll /v1/health once (used on load, visibilitychange and after pairing). */
  check: () => Promise<void>
  /** Save a pasted token and re-check. */
  pair: (token: string) => Promise<void>
  refreshModels: () => Promise<void>
  installModel: (id: string) => Promise<void>
}

/** One shared socket for the app; the caption flow subscribes to its job. */
export const socket = new EngineSocket()

export const useEngineStore = create<EngineState>((set, get) => {
  const onEvent = (e: WsEvent) => {
    if (e.type === 'model.install.progress' || e.type === 'model.state') {
      set({
        models: get().models.map((m) =>
          m.id !== e.modelId
            ? m
            : e.type === 'model.state'
              ? { ...m, state: e.state, installed: e.state === 'installed', progress: null }
              : { ...m, state: 'downloading', progress: e.progress },
        ),
      })
      if (e.type === 'model.state') void get().refreshModels()
    }
  }
  socket.on(onEvent)

  return {
    status: 'checking',
    hasToken: engineToken() !== null,
    models: [],

    check: async () => {
      const result = await fetchEngineHealth()
      set({
        status: result.state,
        health: result.health,
        lastError: result.error,
        hasToken: engineToken() !== null,
      })
      if (result.state === 'online') {
        socket.connect()
        await get().refreshModels()
      }
    },

    pair: async (token) => {
      setEngineToken(token)
      socket.close()
      await get().check()
    },

    refreshModels: async () => {
      try {
        set({ models: (await engine.models()).models })
      } catch (err) {
        if (err instanceof EngineError && err.code === 'OFFLINE') set({ status: 'offline' })
      }
    },

    installModel: async (id) => {
      set({
        models: get().models.map((m) =>
          m.id === id ? { ...m, state: 'downloading', progress: 0 } : m,
        ),
      })
      try {
        await engine.installModel(id)
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
        await get().refreshModels()
      }
    },
  }
})
