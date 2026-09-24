import type { HealthResponse, VersionResponse } from '@sublight/protocol'
import { PROTOCOL_VERSION } from '@sublight/protocol'

export const ENGINE_VERSION = '0.0.0'

export interface EngineState {
  bootedAt: number
  activeJobs: number
  jobsTotal: number
  jobsDone: number
  jobsFailed: number
}

export function createEngineState(): EngineState {
  return { bootedAt: Date.now(), activeJobs: 0, jobsTotal: 0, jobsDone: 0, jobsFailed: 0 }
}

/**
 * Health payload (Protocol §2). GPU probing arrives with the model manager
 * (M02); until then we report the available flag honestly.
 */
export function buildHealth(state: EngineState): HealthResponse {
  return {
    status: 'online',
    version: ENGINE_VERSION,
    engineUptimeMs: Date.now() - state.bootedAt,
    gpu: { available: false, name: null, vramTotal: null, vramFree: null },
    activeJobs: state.activeJobs,
    metrics: {
      jobsTotal: state.jobsTotal,
      jobsDone: state.jobsDone,
      jobsFailed: state.jobsFailed,
      avgAsrRealtimeFactor: null,
      avgTranslationTokPerSec: null,
    },
  }
}

export function buildVersion(): VersionResponse {
  return { engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION }
}
