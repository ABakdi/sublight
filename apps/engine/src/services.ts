import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aheadRunner, type AheadRunner } from './asr/ahead'
import { WhisperWorker } from './asr/whisper'
import { transcribeRunner } from './asr/transcribe'
import { LlamaWorker } from './llm/llama'
import { translateRunner } from './translate/runner'
import { LiveHub } from './live/hub'
import { liveRunner } from './live/runner'
import { GpuResidency } from './workers/gpu'
import type { EngineConfig } from './config'
import { EventBus } from './events'
import { JobQueue } from './jobs/queue'
import { JobStore } from './jobs/store'
import { findYtDlp } from './media/remote'
import { MediaStore } from './media/store'
import { ModelManager } from './models/manager'
import type { EnginePaths } from './paths'

export interface EngineServices {
  bus: EventBus
  models: ModelManager
  media: MediaStore
  jobs: JobQueue
  whisper: WhisperWorker
  llama: LlamaWorker
  gpu: GpuResidency
  live: LiveHub
  /** `url` jobs: captions made ahead of playback (ADR-0020). */
  ahead: AheadRunner
  paths: EnginePaths
}

interface BuildInfo {
  path: string
  backend: 'cuda' | 'cpu'
}

/**
 * A model server built by `pnpm engine:setup-<name>` (~/.sublight/bin/<name>.json),
 * unless config names a binary. GPU only for CUDA builds, and never with `gpu: "off"`.
 */
export function runtimeBinary(
  name: 'whisper' | 'llama',
  config: EngineConfig,
  paths: EnginePaths,
): { binary: string; gpu: boolean } {
  const conf = config[name]
  const infoFile = join(paths.bin, `${name}.json`)
  const info = existsSync(infoFile)
    ? (JSON.parse(readFileSync(infoFile, 'utf8')) as BuildInfo)
    : null
  const binary = conf.binary ?? info?.path ?? join(paths.bin, `${name}-server`)
  const gpu = conf.gpu !== 'off' && (conf.binary ? true : info?.backend === 'cuda')
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
  const asr = runtimeBinary('whisper', config, paths)
  const whisper = new WhisperWorker({
    binary: asr.binary,
    port: config.whisper.port,
    useGpu: asr.gpu,
    threads: config.whisper.threads,
    logDir: paths.logs,
    runDir: paths.run,
  })
  const llm = runtimeBinary('llama', config, paths)
  const llama = new LlamaWorker({
    binary: llm.binary,
    port: config.llama.port,
    useGpu: llm.gpu,
    threads: config.llama.threads,
    contextTokens: config.llama.contextTokens,
    logDir: paths.logs,
    runDir: paths.run,
  })
  const gpu = new GpuResidency({ asr: whisper, llm: llama })
  const jobs = new JobQueue(new JobStore(paths.jobs), bus, { autoRetry: config.autoRetry })
  jobs.register(transcribeRunner({ media, models, whisper, gpu, ffmpeg: config.ffmpeg }))
  jobs.register(translateRunner({ models, llama, gpu }))
  const live = new LiveHub(join(paths.jobs, 'live'))
  jobs.register(liveRunner({ models, whisper, gpu, hub: live }))
  const ahead = aheadRunner({
    models,
    whisper,
    gpu,
    ffmpeg: config.ffmpeg,
    ytDlp: findYtDlp(paths.bin),
  })
  jobs.register(ahead)
  return { bus, models, media, jobs, whisper, llama, gpu, live, ahead, paths }
}
