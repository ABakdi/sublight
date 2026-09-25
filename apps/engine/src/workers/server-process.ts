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

export interface ServerProcessOptions {
  /** Process name, used for the log/pid files and orphan checks, e.g. "whisper-server". */
  name: string
  binary: string
  host?: string
  port: number
  logDir: string
  /** Where the pid file lives, so a restarted engine can reap an orphaned server. */
  runDir?: string
  /** How long a model may take to load (large models on CPU are slow). */
  loadTimeoutMs?: number
}

/**
 * Supervises one loopback-only model server (whisper-server, llama-server):
 * spawn with a model, wait for `GET /health`, restart on model change or
 * after a crash, stop on demand, and reap a copy orphaned by a hard-killed
 * engine via its pid file (only if /proc confirms it is that server).
 * Trust boundary D (Spec 01 §4): never exposed beyond 127.0.0.1.
 */
export class ServerProcess {
  private child: ChildProcess | null = null
  private loaded: { key: string; id: string } | null = null
  private starting: Promise<void> | null = null
  readonly base: string

  constructor(private readonly opts: ServerProcessOptions) {
    this.base = `http://${opts.host ?? '127.0.0.1'}:${opts.port}`
    mkdirSync(opts.logDir, { recursive: true })
    if (opts.runDir) mkdirSync(opts.runDir, { recursive: true })
  }

  get host(): string {
    return this.opts.host ?? '127.0.0.1'
  }

  get logFile(): string {
    return join(this.opts.logDir, `${this.opts.name}.log`)
  }

  private get pidFile(): string | null {
    return this.opts.runDir ? join(this.opts.runDir, `${this.opts.name}.pid`) : null
  }

  /** Id of the model currently loaded (for /v1/health), or null. */
  get resident(): string | null {
    return this.loaded?.id ?? null
  }

  get running(): boolean {
    return this.child !== null && this.loaded !== null
  }

  private reapOrphan(): void {
    const file = this.pidFile
    if (!file || !existsSync(file)) return
    const pid = Number(readFileSync(file, 'utf8'))
    rmSync(file, { force: true })
    if (!Number.isInteger(pid) || pid <= 1) return
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(this.opts.name)) return
    } catch {
      return // not running (or no /proc: nothing we can verify, so leave it)
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }

  /**
   * Run the server for `id` with these args; `key` identifies the loaded
   * configuration (e.g. the model path) so an identical request is a no-op.
   */
  async ensure(id: string, key: string, args: string[]): Promise<void> {
    if (this.starting) await this.starting.catch(() => {})
    if (this.child && this.loaded?.key === key) return
    await this.stop()
    this.starting = this.spawn(id, key, args)
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private unavailable(message: string, retryable: boolean): JobError {
    return new JobError('WORKER_UNAVAILABLE', message, retryable, 503)
  }

  private async spawn(id: string, key: string, extra: string[]): Promise<void> {
    const args = ['--host', this.host, '--port', String(this.opts.port), ...extra]
    this.reapOrphan()
    const log = createWriteStream(this.logFile, { flags: 'a' })
    log.write(`\n--- ${new Date().toISOString()} start ${args.join(' ')}\n`)
    let child: ChildProcess
    try {
      child = spawn(this.opts.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      throw this.unavailable(`cannot start ${this.opts.name}: ${String(err)}`, false)
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
      if (spawnError)
        throw this.unavailable(`cannot start ${this.opts.name}: ${String(spawnError)}`, false)
      if (exited)
        throw this.unavailable(`${this.opts.name} exited while loading (see ${this.logFile})`, true)
      try {
        const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) {
          this.loaded = { key, id }
          return
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    await this.stop()
    throw this.unavailable(`${this.opts.name} did not become healthy in time`, true)
  }

  /** fetch against the server; a refused/reset connection means it died → retryable. */
  async request(path: string, init: RequestInit): Promise<Response> {
    if (!this.running) throw this.unavailable(`${this.opts.name} is not running`, true)
    try {
      return await fetch(`${this.base}${path}`, init)
    } catch (err) {
      if (init.signal?.aborted) throw err
      await this.stop()
      throw this.unavailable(`${this.opts.name} request failed: ${String(err)}`, true)
    }
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
