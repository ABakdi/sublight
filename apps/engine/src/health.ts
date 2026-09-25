import type { GpuInfo, HealthResponse, VersionResponse } from '@sublight/protocol'
import { PROTOCOL_VERSION } from '@sublight/protocol'
import type { EngineServices } from './services'

export const ENGINE_VERSION = '0.1.0'

const NO_GPU: GpuInfo = { available: false, name: null, vramTotal: null, vramFree: null }

/** Health payload (Protocol §2, Spec 06 §8): GPU, queue, resident model, cache, counters. */
export function buildHealth(
  bootedAt: number,
  services?: EngineServices,
  gpu: GpuInfo = NO_GPU,
): HealthResponse {
  const stats = services?.jobs.stats()
  return {
    status: 'online',
    version: ENGINE_VERSION,
    engineUptimeMs: Date.now() - bootedAt,
    gpu,
    activeJobs: stats?.activeJobs ?? 0,
    ...(services
      ? {
          queuedJobs: stats!.queued,
          residentModel: services.gpu.resident,
          mediaCacheBytes: services.media.all().reduce((n, m) => n + m.normalizedBytes, 0),
        }
      : {}),
    metrics: {
      jobsTotal: stats?.jobsTotal ?? 0,
      jobsDone: stats?.jobsDone ?? 0,
      jobsFailed: stats?.jobsFailed ?? 0,
      avgAsrRealtimeFactor: stats?.avgAsrRealtimeFactor ?? null,
      avgTranslationTokPerSec: null,
    },
  }
}

export function buildVersion(): VersionResponse {
  return { engine: ENGINE_VERSION, protocol: PROTOCOL_VERSION }
}
