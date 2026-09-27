import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JobStore, type JobRecord } from '../src/jobs/store'

const job = (
  id: string,
  state: JobRecord['state'],
  ageDays: number,
  extra: Partial<JobRecord> = {},
) =>
  ({
    id,
    type: 'transcribe',
    request: { type: 'transcribe', mediaHash: 'sha256:x', model: 'whisper-small' },
    priority: 'normal',
    state,
    progress: 1,
    attempts: 1,
    createdAt: Date.now() - ageDays * 86_400_000,
    updatedAt: Date.now() - ageDays * 86_400_000,
    ...extra,
  }) as unknown as JobRecord

describe('job retention (baseline C2)', () => {
  it('forgets finished jobs after the retention period, with their results', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sublight-ret-'))
    const store = new JobStore(dir)
    store.put(job('old', 'done', 40))
    store.writeResult({ id: 'old' } as never)
    store.put(job('reuse', 'done', 1, { resultOf: 'old' }))
    store.put(job('recent', 'done', 2))
    store.put(job('waiting', 'queued', 60))
    const reopened = new JobStore(dir)
    expect(
      reopened
        .all()
        .map((j) => j.id)
        .sort(),
    ).toEqual(['recent', 'waiting'])
    expect(existsSync(store.resultFile('old'))).toBe(false)
  })
})
