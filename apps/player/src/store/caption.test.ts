// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleTrack } from '@sublight/core'
import type { JobSummary } from '@sublight/protocol'
import { engine, EngineError } from '../lib/engine'
import { DB_NAME, __resetDbForTests } from '../lib/idb'
import { useCaptionStore } from './caption'
import { socket } from './engine'
import { activeTrackOf, usePlayerStore } from './player'

const HASH = `sha256:${'a'.repeat(64)}`

function summary(state: JobSummary['state'], extra: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'job-1',
    type: 'transcribe',
    state,
    progress: 0,
    priority: 'batch',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

const track = (cues: number, draft = false): SubtitleTrack => ({
  id: `t-${cues}-${draft}`,
  projectId: '',
  language: 'de',
  title: 'de (Whisper)',
  kind: 'transcript',
  ...(draft ? { draft: true } : {}),
  cues: Array.from({ length: cues }, (_, i) => ({
    id: `c${i}`,
    startMs: i * 1000,
    endMs: i * 1000 + 800,
    text: `cue ${i}`,
  })),
  createdAt: 1,
})

async function openProject() {
  await usePlayerStore
    .getState()
    .openWithFile(new File(['video'], 'talk.mp4', { type: 'video/mp4' }))
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('caption flow (Spec 04 §5, M03.2-M03.3)', () => {
  beforeEach(async () => {
    __resetDbForTests()
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = req.onerror = req.onblocked = () => r()
    })
    URL.createObjectURL = vi.fn(() => 'blob:x') as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
    usePlayerStore.setState({
      view: { name: 'library' },
      project: null,
      videoObjectUrl: null,
      videoFile: null,
      error: null,
    })
    useCaptionStore.getState().reset()
    vi.spyOn(socket, 'subscribe').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('uploads the file, keeps the media hash and adds the finished track', async () => {
    await openProject()
    vi.spyOn(engine, 'mediaInfo').mockResolvedValue(null)
    const upload = vi.spyOn(engine, 'uploadMedia').mockImplementation(async (_f, _id, opts) => {
      opts?.onProgress?.(5, 5)
      return { mediaHash: HASH, durationMs: 60_000, normalizedBytes: 10 }
    })
    const create = vi
      .spyOn(engine, 'createJob')
      .mockResolvedValue(summary('done', { cached: true }))
    vi.spyOn(engine, 'result').mockResolvedValue({
      id: 'job-1',
      state: 'done',
      tracks: [track(3)],
      language: 'de',
    })

    await useCaptionStore
      .getState()
      .start({ model: 'whisper-small', language: null, task: 'transcribe' })

    expect(upload).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]![0]).toMatchObject({
      type: 'transcribe',
      mediaHash: HASH,
      model: 'whisper-small',
    })
    const project = usePlayerStore.getState().project!
    expect(project.media.mediaHash).toBe(HASH)
    expect(activeTrackOf(project)).toMatchObject({
      language: 'de',
      projectId: project.id,
      draft: false,
    })
    expect(useCaptionStore.getState()).toMatchObject({
      phase: 'done',
      resultNote: '3 cues · de · from cache',
    })
  })

  it('skips the upload when the engine still has the audio (AC4)', async () => {
    await openProject()
    await usePlayerStore.getState().setMediaHash(HASH)
    vi.spyOn(engine, 'mediaInfo').mockResolvedValue({ mediaHash: HASH, durationMs: 1 })
    const upload = vi.spyOn(engine, 'uploadMedia')
    vi.spyOn(engine, 'createJob').mockResolvedValue(summary('done'))
    vi.spyOn(engine, 'result').mockResolvedValue({ id: 'job-1', state: 'done', tracks: [track(1)] })
    await useCaptionStore
      .getState()
      .start({ model: 'whisper-base', language: 'de', task: 'transcribe' })
    expect(upload).not.toHaveBeenCalled()
    expect(useCaptionStore.getState().phase).toBe('done')
  })

  it('shows drafts from job.partial, then replaces them with the final track', async () => {
    await openProject()
    await usePlayerStore.getState().setMediaHash(HASH)
    vi.spyOn(engine, 'mediaInfo').mockResolvedValue({ mediaHash: HASH, durationMs: 1 })
    vi.spyOn(engine, 'createJob').mockResolvedValue(summary('running'))
    const job = vi.spyOn(engine, 'job').mockResolvedValue(summary('running'))
    vi.spyOn(engine, 'result').mockResolvedValue({ id: 'job-1', state: 'done', tracks: [track(5)] })

    const run = useCaptionStore
      .getState()
      .start({ model: 'whisper-small', language: null, task: 'transcribe' })
    await until(() => useCaptionStore.getState().jobId === 'job-1')
    socket.dispatch({
      type: 'job.progress',
      jobId: 'job-1',
      progress: 0.5,
      detail: 'transcribing part 2 of 4',
    })
    socket.dispatch({ type: 'job.partial', jobId: 'job-1', draft: track(2, true) })
    expect(useCaptionStore.getState()).toMatchObject({ phase: 'transcribing', progress: 0.5 })
    expect(useCaptionStore.getState().draft?.cues).toHaveLength(2)

    job.mockResolvedValue(summary('done'))
    socket.dispatch({ type: 'job.state', jobId: 'job-1', state: 'done' })
    await run
    expect(useCaptionStore.getState()).toMatchObject({ phase: 'done', draft: null })
    expect(activeTrackOf(usePlayerStore.getState().project!)!.cues).toHaveLength(5)
  })

  it('cancels a running job', async () => {
    await openProject()
    await usePlayerStore.getState().setMediaHash(HASH)
    vi.spyOn(engine, 'mediaInfo').mockResolvedValue({ mediaHash: HASH, durationMs: 1 })
    vi.spyOn(engine, 'createJob').mockResolvedValue(summary('running'))
    const job = vi.spyOn(engine, 'job').mockResolvedValue(summary('running'))
    const cancel = vi.spyOn(engine, 'cancelJob').mockImplementation(async () => {
      job.mockResolvedValue(summary('cancelled'))
      return summary('cancelled')
    })
    const run = useCaptionStore
      .getState()
      .start({ model: 'whisper-small', language: null, task: 'transcribe' })
    await until(() => useCaptionStore.getState().jobId === 'job-1')
    socket.dispatch({ type: 'job.progress', jobId: 'job-1', progress: 0.2 })
    await useCaptionStore.getState().cancel()
    socket.dispatch({ type: 'job.state', jobId: 'job-1', state: 'cancelled' })
    await run
    expect(cancel).toHaveBeenCalledWith('job-1')
    expect(useCaptionStore.getState().phase).toBe('cancelled')
    expect(usePlayerStore.getState().project!.tracks).toHaveLength(0)
  })

  it('explains engine errors in plain language', async () => {
    await openProject()
    vi.spyOn(engine, 'mediaInfo').mockResolvedValue(null)
    vi.spyOn(engine, 'uploadMedia').mockRejectedValue(
      new EngineError('AUDIO_EMPTY', 'the audio is silent', 422),
    )
    await useCaptionStore
      .getState()
      .start({ model: 'whisper-small', language: null, task: 'transcribe' })
    expect(useCaptionStore.getState().error).toMatchObject({
      code: 'AUDIO_EMPTY',
      message: expect.stringMatching(/silent/),
    })

    vi.spyOn(engine, 'uploadMedia').mockRejectedValue(new EngineError('OFFLINE', 'unreachable'))
    await useCaptionStore
      .getState()
      .start({ model: 'whisper-small', language: null, task: 'transcribe' })
    expect(useCaptionStore.getState().error!.message).toMatch(/pnpm dev:engine/)
  })

  it('asks for the file again when the project was reopened without it', async () => {
    await openProject()
    usePlayerStore.setState({ videoFile: null })
    vi.spyOn(engine, 'mediaInfo').mockResolvedValue(null)
    await useCaptionStore
      .getState()
      .start({ model: 'whisper-small', language: null, task: 'transcribe' })
    expect(useCaptionStore.getState().error).toMatchObject({ code: 'NO_FILE' })
  })
})
