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
  /** Disk used by models and free on their disk, bytes (M06.8). */
  disk: { usedBytes: number; freeBytes: number | null } | null
  /** Why the last model action failed (DISK_FULL, MODEL_IN_USE…), cleared by the next one. */
  modelError: string | null
  /** Poll /v1/health once (used on load, visibilitychange and after pairing). */
  check: () => Promise<void>
  /** Save a pasted token and re-check. */
  pair: (token: string) => Promise<void>
  refreshModels: () => Promise<void>
  installModel: (id: string) => Promise<void>
  removeModel: (id: string) => Promise<void>
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
    disk: null,
    modelError: null,

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
        const r = await engine.models()
        set({ models: r.models, disk: { usedBytes: r.diskUsedBytes, freeBytes: r.diskFreeBytes } })
      } catch (err) {
        if (err instanceof EngineError && err.code === 'OFFLINE') set({ status: 'offline' })
      }
    },

    installModel: async (id) => {
      set({
        modelError: null,
        models: get().models.map((m) =>
          m.id === id ? { ...m, state: 'downloading', progress: 0 } : m,
        ),
      })
      try {
        await engine.installModel(id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({ lastError: message, modelError: message })
        await get().refreshModels()
      }
    },

    removeModel: async (id) => {
      set({ modelError: null })
      try {
        await engine.removeModel(id)
      } catch (err) {
        set({ modelError: err instanceof Error ? err.message : String(err) })
      }
      await get().refreshModels()
    },
  }
})
