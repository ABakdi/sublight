import { readFileSync } from 'node:fs'
import { JobError } from '../jobs/queue'
import { ServerProcess } from '../workers/server-process'
import type { VerboseJson } from './words'

export interface WhisperWorkerOptions {
  binary: string
  host?: string
  port: number
  /** false = CPU-only (`--no-gpu`). */
  useGpu: boolean
  threads?: number
  logDir: string
  /** Where the pid file lives, so a restarted engine can reap an orphaned server. */
  runDir?: string
  loadTimeoutMs?: number
}

export interface InferenceParams {
  /** null = auto-detect. */
  language: string | null
  translate: boolean
  /** Text preceding this audio (previous chunk), for continuity of names and style. */
  prompt?: string
  signal?: AbortSignal
}

/**
 * The ASR worker (Spec 06 §6): one `whisper-server` on 127.0.0.1:17422,
 * spawned lazily for the model a job needs; a different model means a restart,
 * since the model is fixed at context creation.
 */
export class WhisperWorker {
  private readonly server: ServerProcess

  constructor(private readonly opts: WhisperWorkerOptions) {
    this.server = new ServerProcess({ name: 'whisper-server', ...opts })
  }

  /** Id of the model currently loaded, for /v1/health. */
  get residentModel(): string | null {
    return this.server.resident
  }

  get logFile(): string {
    return this.server.logFile
  }

  /** Make sure the server runs with this model; restarts on a model change or after a crash. */
  ensure(modelId: string, modelPath: string): Promise<void> {
    const args = ['-m', modelPath, '-t', String(this.opts.threads ?? 4)]
    if (!this.opts.useGpu) args.push('--no-gpu')
    return this.server.ensure(modelId, modelPath, args)
  }

  /** Transcribe (or translate → English) one 16 kHz mono WAV (a path, or the bytes). */
  async infer(wav: string | Buffer, params: InferenceParams): Promise<VerboseJson> {
    const form = new FormData()
    const bytes = typeof wav === 'string' ? readFileSync(wav) : wav
    form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'audio.wav')
    form.set('response_format', 'verbose_json')
    form.set('language', params.language ?? 'auto')
    form.set('translate', params.translate ? 'true' : 'false')
    form.set('temperature', '0.0')
    form.set('token_timestamps', 'true')
    if (params.prompt) form.set('prompt', params.prompt)
    const res = await this.server.request('/inference', {
      method: 'POST',
      body: form,
      signal: params.signal,
    })
    const body = await res.text()
    if (!res.ok)
      throw new JobError(
        'JOB_FAILED',
        `whisper-server HTTP ${res.status}: ${body.slice(0, 200)}`,
        true,
      )
    const json = JSON.parse(body) as VerboseJson | { error: string }
    if ('error' in json) throw new JobError('JOB_FAILED', `whisper-server: ${json.error}`, true)
    return json
  }

  stop(): Promise<void> {
    return this.server.stop()
  }
}
