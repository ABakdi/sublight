import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TranscribeJob, WsEvent } from '@sublight/protocol'
import { EventBus } from '../src/events'
import { JobError, JobQueue, type JobRunner, type RunContext } from '../src/jobs/queue'
import { JobStore } from '../src/jobs/store'

const tmp = () => mkdtempSync(join(tmpdir(), 'sublight-jobs-'))

function request(mediaHash: string, extra: Partial<TranscribeJob> = {}): TranscribeJob {
  return {
    type: 'transcribe',
    mediaHash,
    model: 'whisper-small',
    params: { language: null, maxCueDurationMs: 7000 },
    ...extra,
  }
}

/** Controllable fake runner: each run waits until released (or aborted). */
function fakeRunner(opts: { fail?: (req: TranscribeJob, attempt: number) => Error | null } = {}) {
  const started: string[] = []
  const releases = new Map<string, () => void>()
  let concurrent = 0
  let maxConcurrent = 0
  const attempts = new Map<string, number>()
  const runner: JobRunner<TranscribeJob> = {
    type: 'transcribe',
    gpu: true,
    validate(req) {
      if (req.mediaHash === 'bad') throw new JobError('JOB_INVALID', 'bad media', false, 404)
    },
    cacheKey: (req) => `k|${req.mediaHash}|${req.model}`,
    async run(req, ctx: RunContext) {
      const n = (attempts.get(req.mediaHash) ?? 0) + 1
      attempts.set(req.mediaHash, n)
      started.push(req.mediaHash)
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      try {
        const err = opts.fail?.(req, n)
        if (err) throw err
        ctx.progress(0.5, 'working')
        await new Promise<void>((resolve, reject) => {
          releases.set(req.mediaHash, resolve)
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })
        return { tracks: [], language: 'en', realtimeFactor: 0.25 }
      } finally {
        concurrent--
      }
    },
  }
  return {
    runner,
    started,
    release: (hash: string) => releases.get(hash)?.(),
    get maxConcurrent() {
      return maxConcurrent
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10))
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await tick()
  }
}

function setup(dir = tmp(), autoRetry = true, runnerOpts = {}) {
  const bus = new EventBus()
  const events: WsEvent[] = []
  bus.on((e) => events.push(e))
  const fake = fakeRunner(runnerOpts)
  const queue = new JobQueue(new JobStore(dir), bus, { autoRetry })
  queue.register(fake.runner)
  queue.start()
  return { dir, bus, events, fake, queue }
}

describe('job queue (Spec 06 §5, Protocol §5)', () => {
  it('runs one GPU job at a time and finishes with a stored result', async () => {
    const { queue, fake } = setup()
    const a = queue.create(request('a'))
    const b = queue.create(request('b'))
    await tick()
    expect(queue.get(a.id)!.state).toBe('running')
    expect(queue.get(b.id)!.state).toBe('queued')
    fake.release('a')
    await until(() => queue.get(b.id)!.state === 'running')
    fake.release('b')
    await until(() => queue.get(b.id)!.state === 'done')
    expect(fake.maxConcurrent).toBe(1)
    expect(queue.result(a.id)).toMatchObject({ id: a.id, state: 'done', language: 'en' })
  })

  it('runs interactive jobs before older batch jobs', async () => {
    const { queue, fake } = setup()
    queue.create(request('first'))
    queue.create(request('batch'))
    queue.create(request('live', { priority: 'interactive' }))
    await tick()
    fake.release('first')
    await until(() => fake.started.length === 2)
    expect(fake.started).toEqual(['first', 'live'])
  })

  it('honours idempotency keys', () => {
    const { queue } = setup()
    const one = queue.create(request('a'), 'key-1')
    const two = queue.create(request('a'), 'key-1')
    expect(two.id).toBe(one.id)
    expect(queue.list()).toHaveLength(1)
  })

  it('answers the same media + model from the cache without running again', async () => {
    const { queue, fake } = setup()
    const first = queue.create(request('a'))
    await tick()
    fake.release('a')
    await until(() => queue.get(first.id)!.state === 'done')
    const again = queue.create(request('a'))
    expect(again).toMatchObject({ state: 'done', cached: true })
    expect(queue.result(again.id)).toMatchObject({ id: again.id, language: 'en' })
    expect(fake.started).toEqual(['a'])
  })

  it('refuses invalid requests up front', () => {
    const { queue } = setup()
    expect(() => queue.create(request('bad'))).toThrow(JobError)
    expect(queue.list()).toHaveLength(0)
  })

  it('cancels queued and running jobs', async () => {
    const { queue } = setup()
    const a = queue.create(request('a'))
    const b = queue.create(request('b'))
    await tick()
    queue.cancel(b.id)
    expect(queue.get(b.id)!.state).toBe('cancelled')
    queue.cancel(a.id)
    await until(() => queue.get(a.id)!.state === 'cancelled')
  })

  it('retries a retryable failure once, then fails with the error envelope', async () => {
    const { queue, fake } = setup(tmp(), true, {
      fail: (req: TranscribeJob) =>
        req.mediaHash === 'flaky' ? new JobError('WORKER_UNAVAILABLE', 'crashed', true) : null,
    })
    const job = queue.create(request('flaky'))
    await until(() => queue.get(job.id)!.state === 'failed')
    expect(fake.started).toEqual(['flaky', 'flaky'])
    expect(queue.get(job.id)!.error).toEqual({
      code: 'WORKER_UNAVAILABLE',
      message: 'crashed',
      retryable: true,
    })
  })

  it('emits state and progress events', async () => {
    const { queue, fake, events } = setup()
    const job = queue.create(request('a'))
    await tick()
    fake.release('a')
    await until(() => queue.get(job.id)!.state === 'done')
    const states = events.filter((e) => e.type === 'job.state').map((e) => 'state' in e && e.state)
    expect(states).toEqual(['queued', 'running', 'done'])
    expect(events.some((e) => e.type === 'job.progress' && e.progress === 0.5)).toBe(true)
  })

  it('re-queues a job interrupted by a crash when autoRetry is on', async () => {
    const first = setup()
    const job = first.queue.create(request('a'))
    await tick()
    expect(first.queue.get(job.id)!.state).toBe('running')
    // "Crash": a new engine over the same directory, the old one never finished.
    const second = setup(first.dir, true)
    await tick()
    expect(second.queue.get(job.id)!.state).toBe('running')
    second.fake.release('a')
    await until(() => second.queue.get(job.id)!.state === 'done')
    expect(second.queue.list()).toHaveLength(1) // no double-processing
  })

  it('exclusive jobs: a new one cancels queued ones and supersedes the running one', async () => {
    const { queue, fake } = setup()
    const superseded: string[] = []
    fake.runner.exclusive = { supersede: (id) => superseded.push(id) }
    const a = queue.create(request('a'))
    await tick()
    const b = queue.create(request('b'))
    expect(superseded).toEqual([a.id])
    const c = queue.create(request('c'))
    expect(queue.get(b.id)!.state).toBe('cancelled') // never ran: nobody waits for it
    expect(superseded).toEqual([a.id, a.id])
    fake.release('a')
    await until(() => queue.get(c.id)!.state === 'running')
  })

  it('exclusive jobs are cancelled, not resumed, after a restart', async () => {
    const first = setup()
    const job = first.queue.create(request('a'))
    await tick()
    const bus = new EventBus()
    const fake = fakeRunner()
    fake.runner.exclusive = { supersede: () => {} }
    const queue = new JobQueue(new JobStore(first.dir), bus, { autoRetry: true })
    queue.register(fake.runner)
    queue.start()
    await tick()
    expect(queue.get(job.id)!.state).toBe('cancelled')
    expect(fake.started).toEqual([])
  })

  it('cancels a leased job nobody keeps alive, and never resumes one', async () => {
    const bus = new EventBus()
    const fake = fakeRunner()
    const dir = tmp()
    const queue = new JobQueue(new JobStore(dir), bus, { autoRetry: true, leaseMs: 60 })
    queue.register(fake.runner)
    queue.start()
    const kept = queue.create(request('a', { lease: true } as Partial<TranscribeJob>))
    const left = queue.create(request('b', { lease: true } as Partial<TranscribeJob>))
    const timer = setInterval(() => queue.keepalive(kept.id), 20)
    await until(() => queue.get(left.id)!.state === 'cancelled')
    expect(queue.get(kept.id)!.state).toBe('running')
    clearInterval(timer)
    expect(queue.keepalive(left.id)).toBe(false)
    // A restart cancels it instead of resuming it.
    const again = new JobQueue(new JobStore(dir), new EventBus(), { autoRetry: true })
    again.register(fakeRunner().runner)
    again.start()
    expect(again.get(kept.id)!.state).toBe('cancelled')
    await queue.shutdown()
    await again.shutdown()
  })

  it('leaves interrupted jobs alone without autoRetry until the key is replayed', async () => {
    const first = setup()
    const job = first.queue.create(request('a'), 'key-1')
    await tick()
    const second = setup(first.dir, false)
    expect(second.queue.get(job.id)!.state).toBe('interrupted')
    const replay = second.queue.create(request('a'), 'key-1')
    expect(replay.id).toBe(job.id)
    await until(() => second.queue.get(job.id)!.state === 'running')
  })
})
