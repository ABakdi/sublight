import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WhisperWorker } from './asr/whisper'
import { transcribeRunner } from './asr/transcribe'
import type { EngineConfig } from './config'
import { EventBus } from './events'
import { JobQueue } from './jobs/queue'
import { JobStore } from './jobs/store'
import { MediaStore } from './media/store'
import { ModelManager } from './models/manager'
import type { EnginePaths } from './paths'

export interface EngineServices {
  bus: EventBus
  models: ModelManager
  media: MediaStore
  jobs: JobQueue
  whisper: WhisperWorker
  paths: EnginePaths
}

interface WhisperBuildInfo {
  path: string
  backend: 'cuda' | 'cpu'
}

/** The whisper-server built by `pnpm engine:setup-whisper`, unless config names one. */
export function whisperBinary(
  config: EngineConfig,
  paths: EnginePaths,
): { binary: string; gpu: boolean } {
  const infoFile = join(paths.bin, 'whisper.json')
  const info = existsSync(infoFile)
    ? (JSON.parse(readFileSync(infoFile, 'utf8')) as WhisperBuildInfo)
    : null
  const binary = config.whisper.binary ?? info?.path ?? join(paths.bin, 'whisper-server')
  const gpu =
    config.whisper.gpu !== 'off' && (config.whisper.binary ? true : info?.backend === 'cuda')
  return { binary, gpu }
}

/** Build the engine's long-lived services; the caller starts the queue after wiring. */
export function createServices(config: EngineConfig, paths: EnginePaths): EngineServices {
  const bus = new EventBus()
  const models = new ModelManager(paths.models, bus)
  const media = new MediaStore(paths.mediaCache, {
    ffmpeg: config.ffmpeg,
    maxUploadBytes: config.cacheLimits.uploadBytes,
    cacheLimitBytes: config.cacheLimits.mediaBytes,
  })
  const { binary, gpu } = whisperBinary(config, paths)
  const whisper = new WhisperWorker({
    binary,
    port: config.whisper.port,
    useGpu: gpu,
    threads: config.whisper.threads,
    logDir: paths.logs,
    runDir: paths.run,
  })
  const jobs = new JobQueue(new JobStore(paths.jobs), bus, { autoRetry: config.autoRetry })
  jobs.register(transcribeRunner({ media, models, whisper, ffmpeg: config.ffmpeg }))
  return { bus, models, media, jobs, whisper, paths }
}
