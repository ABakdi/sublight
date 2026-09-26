import { randomUUID } from 'node:crypto'
import type { SubtitleTrack } from '@sublight/core'
import type { JobCreation, JobFailure, JobResult, JobSummary } from '@sublight/protocol'
import type { EventBus } from '../events'
import type { JobRecord, JobStore } from './store'

/** A failure with a protocol error code (Protocol §5-§6). */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status = 400,
  ) {
    super(message)
  }
}

export interface RunContext {
  jobId: string
  signal: AbortSignal
  /** 0..1 plus an optional phase label. */
  progress(progress: number, detail?: string): void
  /** Stream a partial track (chunk commits, live drafts). */
  partial(track: SubtitleTrack): void
  /** Per-job scratch dir for resumable checkpoints. */
  chunkDir(): string
}

export type RunOutput = Omit<JobResult, 'id' | 'state'>

export interface JobRunner<T extends JobCreation = JobCreation> {
  type: T['type']
  /** Needs the single GPU slot (Spec 06 §2). */
  gpu: boolean
  /** Throw JobError to refuse the request up front (400/404/409). */
  validate(request: T): void
  /** Identical output key for cache hits, or null to never cache. */
  cacheKey(request: T): string | null
  run(request: T, ctx: RunContext): Promise<RunOutput>
  /**
   * One at a time (live capture, captioning a page): a new job of this type
   * replaces older ones. Queued ones are cancelled; a running one gets
   * `supersede(jobId)` to wrap up quickly, or is cancelled without it. Such
   * jobs are cancelled rather than resumed after an engine restart (their
   * input was streamed, or belongs to a page that is gone).
   */
  exclusive?: { supersede?(jobId: string): void }
}

export interface QueueOptions {
  /** Re-queue jobs interrupted by an engine restart (config.autoRetry). */
  autoRetry: boolean
  /** Attempts for retryable failures (worker crash, transient OOM). */
  maxAttempts?: number
  /** Concurrent non-GPU jobs (Protocol §7). */
  cpuConcurrency?: number
}

const PRIORITY_RANK = { interactive: 0, batch: 1 } as const

/**
 * Job queue (Spec 06 §5): priority classes (interactive > batch, then FIFO),
 * one GPU slot shared by ASR and translation, idempotency keys, result cache
 * by `cacheKey`, cooperative cancellation, crash recovery from the log.
 */
export class JobQueue {
  private runners = new Map<string, JobRunner>()
  private running = new Map<string, AbortController>()
  private gpuBusy = false
  private cpuRunning = 0
  private stopped = false
  private readonly maxAttempts: number
  private readonly cpuConcurrency: number
  private metrics = { asrSeconds: 0, audioSeconds: 0 }

  constructor(
    private readonly store: JobStore,
    private readonly bus: EventBus,
    private readonly opts: QueueOptions,
  ) {
    this.maxAttempts = opts.maxAttempts ?? 2
    this.cpuConcurrency = opts.cpuConcurrency ?? 4
  }

  register(runner: JobRunner): void {
    this.runners.set(runner.type, runner)
  }

  /** After registering runners: recover interrupted work and start pumping. */
  start(): void {
    for (const job of this.store.all()) {
      const open = job.state === 'queued' || job.state === 'running' || job.state === 'interrupted'
      if (open && this.runners.get(job.type)?.exclusive) {
        this.store.patch(job.id, { state: 'cancelled', detail: 'engine restarted' })
        continue
      }
      if (job.state === 'running') {
        this.store.patch(job.id, { state: 'interrupted', detail: 'engine restarted' })
      }
      if (job.state === 'interrupted' && this.opts.autoRetry) {
        this.store.patch(job.id, { state: 'queued', detail: 'resuming after restart' })
      }
    }
    this.pump()
  }

  private runnerFor(type: string): JobRunner {
    const runner = this.runners.get(type)
    if (!runner) throw new JobError('JOB_INVALID', `unsupported job type '${type}'`)
    return runner
  }

  create(request: JobCreation, idempotencyKey?: string): JobSummary {
    if (idempotencyKey) {
      const existing = this.store.all().find((j) => j.idempotencyKey === idempotencyKey)
      if (existing) {
        // Replaying a key re-queues a job that was interrupted and not auto-retried.
        if (existing.state === 'interrupted') {
          this.store.patch(existing.id, { state: 'queued', detail: 'resumed by client' })
          this.emitState(existing)
          this.pump()
        }
        return this.summary(existing)
      }
    }
    const runner = this.runnerFor(request.type)
    runner.validate(request)
    if (runner.exclusive) {
      for (const old of this.store.all()) {
        if (old.type !== request.type) continue
        if (old.state === 'queued' || old.state === 'interrupted') {
          this.store.patch(old.id, { state: 'cancelled', detail: 'replaced by a newer job' })
          this.emitState(old)
        } else if (old.state === 'running') {
          if (runner.exclusive.supersede) runner.exclusive.supersede(old.id)
          else this.cancel(old.id)
        }
      }
    }
    const cacheKey = runner.cacheKey(request) ?? undefined
    const now = Date.now()
    const job: JobRecord = {
      id: randomUUID(),
      type: request.type,
      request,
      priority: request.priority ?? 'batch',
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(cacheKey ? { cacheKey } : {}),
      state: 'queued',
      progress: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }

    const hit = cacheKey ? this.cacheHit(cacheKey) : undefined
    if (hit) {
      Object.assign(job, {
        state: 'done',
        progress: 1,
        cached: true,
        resultOf: hit.resultOf ?? hit.id,
      })
      this.store.put(job)
      this.emitState(job)
      return this.summary(job)
    }
    this.store.put(job)
    this.emitState(job)
    this.pump()
    return this.summary(job)
  }

  private cacheHit(cacheKey: string): JobRecord | undefined {
    return this.store
      .all()
      .find(
        (j) =>
          j.cacheKey === cacheKey && j.state === 'done' && this.store.readResult(j.id) !== null,
      )
  }

  get(id: string): JobSummary | null {
    const job = this.store.get(id)
    return job ? this.summary(job) : null
  }

  list(state?: string): JobSummary[] {
    return this.store
      .all()
      .filter((j) => !state || j.state === state)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this.summary(j))
  }

  result(id: string): JobResult | null {
    const job = this.store.get(id)
    if (!job || job.state !== 'done') return null
    return this.store.readResult(id)
  }

  cancel(id: string): JobSummary | null {
    const job = this.store.get(id)
    if (!job) return null
    if (job.state === 'queued' || job.state === 'interrupted') {
      this.store.patch(id, { state: 'cancelled', detail: 'cancelled' })
      this.emitState(job)
    } else if (job.state === 'running') {
      this.running.get(id)?.abort()
    }
    return this.summary(job)
  }

  /** Queue depth + counters for /v1/health (Spec 06 §8). */
  stats() {
    const jobs = this.store.all()
    const count = (s: string) => jobs.filter((j) => j.state === s).length
    return {
      activeJobs: count('running'),
      queued: count('queued'),
      jobsTotal: jobs.length,
      jobsDone: count('done'),
      jobsFailed: count('failed'),
      avgAsrRealtimeFactor:
        this.metrics.audioSeconds > 0 ? this.metrics.asrSeconds / this.metrics.audioSeconds : null,
    }
  }

  /** SIGTERM: stop starting work, abort running jobs and mark them interrupted. */
  async shutdown(): Promise<void> {
    this.stopped = true
    for (const [id, ctl] of this.running) {
      this.store.patch(id, { state: 'interrupted', detail: 'engine stopped' })
      ctl.abort()
    }
    this.store.compact()
  }

  private summary(job: JobRecord): JobSummary {
    return {
      id: job.id,
      type: job.type,
      state: job.state,
      progress: job.progress,
      priority: job.priority,
      ...(job.detail ? { detail: job.detail } : {}),
      ...(job.cached ? { cached: true } : {}),
      ...(job.error ? { error: job.error } : {}),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }
  }

  private emitState(job: JobRecord): void {
    this.bus.emit({ type: 'job.state', jobId: job.id, state: job.state })
  }

  private next(gpuFree: boolean, cpuFree: boolean): JobRecord | undefined {
    return this.store
      .all()
      .filter((j) => j.state === 'queued')
      .filter((j) => (this.runners.get(j.type)?.gpu ? gpuFree : cpuFree))
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt,
      )[0]
  }

  private pump(): void {
    if (this.stopped) return
    for (;;) {
      const job = this.next(!this.gpuBusy, this.cpuRunning < this.cpuConcurrency)
      if (!job) return
      void this.execute(job)
    }
  }

  private async execute(job: JobRecord): Promise<void> {
    const runner = this.runnerFor(job.type)
    if (runner.gpu) this.gpuBusy = true
    else this.cpuRunning++
    const ctl = new AbortController()
    this.running.set(job.id, ctl)
    this.store.patch(job.id, {
      state: 'running',
      attempts: job.attempts + 1,
      detail: 'starting',
      progress: job.progress,
    })
    this.emitState(job)

    let lastEmit = 0
    const ctx: RunContext = {
      jobId: job.id,
      signal: ctl.signal,
      progress: (progress, detail) => {
        const p = Math.max(0, Math.min(1, progress))
        const now = Date.now()
        // Persist + emit at most ~5/s; phase changes always go out.
        if (detail === job.detail && now - lastEmit < 200 && p < 1) return
        lastEmit = now
        this.store.patch(job.id, { progress: p, ...(detail ? { detail } : {}) })
        this.bus.emit({
          type: 'job.progress',
          jobId: job.id,
          progress: p,
          ...(detail ? { detail } : {}),
        })
      },
      partial: (track) => this.bus.emit({ type: 'job.partial', jobId: job.id, draft: track }),
      chunkDir: () => this.store.chunkDir(job.id),
    }

    try {
      const started = Date.now()
      const output = await runner.run(job.request, ctx)
      if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError')
      this.store.writeResult({ id: job.id, state: 'done', ...output })
      if (output.realtimeFactor !== undefined && output.realtimeFactor > 0) {
        const wall = (Date.now() - started) / 1000
        this.metrics.asrSeconds += wall
        this.metrics.audioSeconds += wall / output.realtimeFactor
      }
      this.store.clearChunks(job.id)
      this.store.patch(job.id, { state: 'done', progress: 1, detail: 'done' })
    } catch (err) {
      this.settleFailure(job, err, ctl.signal.aborted)
    } finally {
      this.running.delete(job.id)
      if (runner.gpu) this.gpuBusy = false
      else this.cpuRunning--
      this.emitState(job)
      this.pump()
    }
  }

  private settleFailure(job: JobRecord, err: unknown, aborted: boolean): void {
    if (this.stopped && job.state === 'interrupted') return // shutdown already recorded it
    if (aborted) {
      this.store.patch(job.id, { state: 'cancelled', detail: 'cancelled' })
      return
    }
    const failure: JobFailure =
      err instanceof JobError
        ? { code: err.code, message: err.message, retryable: err.retryable }
        : {
            code: 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          }
    if (failure.retryable && job.attempts < this.maxAttempts) {
      this.store.patch(job.id, { state: 'queued', detail: `retrying: ${failure.message}` })
      return
    }
    this.bus.emit({ type: 'job.log', jobId: job.id, level: 'error', message: failure.message })
    this.store.patch(job.id, { state: 'failed', error: failure, detail: 'failed' })
  }
}
