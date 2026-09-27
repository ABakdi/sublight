import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { JobCreation, JobFailure, JobPriority, JobResult, JobState } from '@sublight/protocol'

/** Everything the engine remembers about a job (Protocol §5). */
export interface JobRecord {
  id: string
  type: JobCreation['type']
  request: JobCreation
  priority: JobPriority
  idempotencyKey?: string
  /** Same key ⇒ same output (media hash + model + params); used for cache hits. */
  cacheKey?: string
  state: JobState
  progress: number
  detail?: string
  error?: JobFailure
  cached?: boolean
  /** Job whose result file this job reuses (cache hit). */
  resultOf?: string
  attempts: number
  createdAt: number
  updatedAt: number
}

type LogLine =
  { op: 'put'; job: JobRecord } | { op: 'patch'; id: string; patch: Partial<JobRecord> }

/** Rewrite the log as one line per job once it grows past this many lines. */
const COMPACT_AFTER = 5000

/**
 * Finished jobs (and their transcripts) are kept this long, then forgotten at
 * the next start: they record what you watched (security baseline C2).
 */
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Persistence for jobs (Spec 06 §5): `jobs.jsonl` is append-only — one `put`
 * per job, one `patch` per transition — and replays into memory on start.
 * Results are separate files (`<id>.result.json`); per-chunk checkpoints live
 * in `<id>.chunks/` so long jobs resume where they stopped.
 */
export class JobStore {
  private readonly log: string
  private jobs = new Map<string, JobRecord>()
  private lines = 0

  constructor(
    readonly dir: string,
    private readonly retentionMs = JOB_RETENTION_MS,
  ) {
    mkdirSync(dir, { recursive: true })
    this.log = join(dir, 'jobs.jsonl')
    this.replay()
  }

  /** Drop jobs that ended longer than `retentionMs` ago, with their files (and jobs reusing them). */
  private prune(now: number): void {
    const old = new Set(
      [...this.jobs.values()]
        .filter((j) => j.state !== 'queued' && j.state !== 'running')
        .filter((j) => now - j.updatedAt > this.retentionMs)
        .map((j) => j.id),
    )
    for (const j of this.jobs.values()) if (j.resultOf && old.has(j.resultOf)) old.add(j.id)
    for (const id of old) {
      this.jobs.delete(id)
      rmSync(this.resultFile(id), { force: true })
      rmSync(join(this.dir, `${id}.chunks`), { recursive: true, force: true })
    }
  }

  private replay(): void {
    if (!existsSync(this.log)) return
    for (const raw of readFileSync(this.log, 'utf8').split('\n')) {
      if (!raw.trim()) continue
      let line: LogLine
      try {
        line = JSON.parse(raw) as LogLine
      } catch {
        continue // torn final line from a crash mid-write
      }
      if (line.op === 'put') this.jobs.set(line.job.id, line.job)
      else {
        const job = this.jobs.get(line.id)
        if (job) Object.assign(job, line.patch)
      }
    }
    this.prune(Date.now())
    this.compact()
  }

  private append(line: LogLine): void {
    appendFileSync(this.log, JSON.stringify(line) + '\n')
    if (++this.lines > COMPACT_AFTER) this.compact()
  }

  /** Atomically rewrite the log as one `put` per job. */
  compact(): void {
    const tmp = `${this.log}.tmp`
    const body = [...this.jobs.values()].map((job) => JSON.stringify({ op: 'put', job })).join('\n')
    writeFileSync(tmp, body ? body + '\n' : '')
    renameSync(tmp, this.log)
    this.lines = this.jobs.size
  }

  put(job: JobRecord): void {
    this.jobs.set(job.id, job)
    this.append({ op: 'put', job })
  }

  patch(id: string, patch: Partial<JobRecord>): JobRecord {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown job ${id}`)
    const full = { ...patch, updatedAt: Date.now() }
    Object.assign(job, full)
    this.append({ op: 'patch', id, patch: full })
    return job
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  all(): JobRecord[] {
    return [...this.jobs.values()]
  }

  resultFile(id: string): string {
    return join(this.dir, `${id}.result.json`)
  }

  writeResult(result: JobResult): void {
    const file = this.resultFile(result.id)
    writeFileSync(`${file}.tmp`, JSON.stringify(result))
    renameSync(`${file}.tmp`, file)
  }

  readResult(id: string): JobResult | null {
    const job = this.jobs.get(id)
    const source = job?.resultOf ?? id
    const file = this.resultFile(source)
    if (!existsSync(file)) return null
    const result = JSON.parse(readFileSync(file, 'utf8')) as JobResult
    return { ...result, id }
  }

  chunkDir(id: string): string {
    const dir = join(this.dir, `${id}.chunks`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  clearChunks(id: string): void {
    rmSync(join(this.dir, `${id}.chunks`), { recursive: true, force: true })
  }
}
