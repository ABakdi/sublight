import { spawn, type ChildProcess } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { JobError } from '../jobs/queue'
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
  /** How long a model may take to load (large models on CPU are slow). */
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
 * Supervises one `whisper-server` process (Spec 06 §6) on 127.0.0.1:17422.
 * Spawned lazily for the model a job needs; a different model means a
 * restart, since the model is fixed at context creation. The subprocess is
 * loopback-only and never exposed (trust boundary D, Spec 01 §4).
 */
export class WhisperWorker {
  private child: ChildProcess | null = null
  private loaded: { model: string; id: string } | null = null
  private starting: Promise<void> | null = null
  private readonly base: string

  constructor(private readonly opts: WhisperWorkerOptions) {
    this.base = `http://${opts.host ?? '127.0.0.1'}:${opts.port}`
    mkdirSync(opts.logDir, { recursive: true })
    if (opts.runDir) mkdirSync(opts.runDir, { recursive: true })
  }

  private get pidFile(): string | null {
    return this.opts.runDir ? join(this.opts.runDir, 'whisper-server.pid') : null
  }

  /**
   * A hard-killed engine (SIGKILL, crash) leaves its whisper-server running on
   * the port. Kill it — only if the recorded pid is still a whisper-server.
   */
  private reapOrphan(): void {
    const file = this.pidFile
    if (!file || !existsSync(file)) return
    const pid = Number(readFileSync(file, 'utf8'))
    rmSync(file, { force: true })
    if (!Number.isInteger(pid) || pid <= 1) return
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!cmdline.includes('whisper-server')) return
    } catch {
      return // not running (or no /proc: nothing we can verify, so leave it)
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }

  /** Id of the model currently loaded, for /v1/health. */
  get residentModel(): string | null {
    return this.loaded?.id ?? null
  }

  /** Make sure the server runs with this model; restarts on a model change or after a crash. */
  async ensure(modelId: string, modelPath: string): Promise<void> {
    if (this.starting) await this.starting.catch(() => {})
    if (this.child && this.loaded?.model === modelPath) return
    await this.stop()
    this.starting = this.spawn(modelId, modelPath)
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async spawn(modelId: string, modelPath: string): Promise<void> {
    const args = [
      '--host',
      this.opts.host ?? '127.0.0.1',
      '--port',
      String(this.opts.port),
      '-m',
      modelPath,
      '-t',
      String(this.opts.threads ?? 4),
    ]
    if (!this.opts.useGpu) args.push('--no-gpu')

    this.reapOrphan()
    const log = createWriteStream(join(this.opts.logDir, 'whisper-server.log'), { flags: 'a' })
    log.write(`\n--- ${new Date().toISOString()} start ${args.join(' ')}\n`)
    let child: ChildProcess
    try {
      child = spawn(this.opts.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      throw new JobError(
        'WORKER_UNAVAILABLE',
        `cannot start whisper-server: ${String(err)}`,
        false,
        503,
      )
    }
    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })
    this.child = child
    if (this.pidFile && child.pid) writeFileSync(this.pidFile, String(child.pid))
    let exited = false
    let spawnError: Error | null = null
    child.on('error', (err) => {
      spawnError = err
    })
    child.on('exit', (code, signal) => {
      exited = true
      log.write(`--- exit code=${code} signal=${signal}\n`)
      if (this.child === child) {
        this.child = null
        this.loaded = null
        if (this.pidFile) rmSync(this.pidFile, { force: true })
      }
    })

    const deadline = Date.now() + (this.opts.loadTimeoutMs ?? 180_000)
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new JobError(
          'WORKER_UNAVAILABLE',
          `cannot start whisper-server: ${String(spawnError)}`,
          false,
          503,
        )
      }
      if (exited) {
        throw new JobError(
          'WORKER_UNAVAILABLE',
          `whisper-server exited while loading (see ${this.logFile})`,
          true,
          503,
        )
      }
      try {
        const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) {
          this.loaded = { model: modelPath, id: modelId }
          return
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    await this.stop()
    throw new JobError(
      'WORKER_UNAVAILABLE',
      'whisper-server did not become healthy in time',
      true,
      503,
    )
  }

  get logFile(): string {
    return join(this.opts.logDir, 'whisper-server.log')
  }

  /** Transcribe (or translate → English) one 16 kHz mono WAV. */
  async infer(wavPath: string, params: InferenceParams): Promise<VerboseJson> {
    if (!this.child || !this.loaded) {
      throw new JobError('WORKER_UNAVAILABLE', 'whisper-server is not running', true, 503)
    }
    const form = new FormData()
    form.set('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), 'audio.wav')
    form.set('response_format', 'verbose_json')
    form.set('language', params.language ?? 'auto')
    form.set('translate', params.translate ? 'true' : 'false')
    form.set('temperature', '0.0')
    form.set('token_timestamps', 'true')
    if (params.prompt) form.set('prompt', params.prompt)
    let res: Response
    try {
      res = await fetch(`${this.base}/inference`, {
        method: 'POST',
        body: form,
        signal: params.signal,
      })
    } catch (err) {
      if (params.signal?.aborted) throw err
      // Connection refused/reset: the process died mid-request.
      await this.stop()
      throw new JobError(
        'WORKER_UNAVAILABLE',
        `whisper-server request failed: ${String(err)}`,
        true,
        503,
      )
    }
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

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.loaded = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
