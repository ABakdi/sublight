// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobCreation, OpenInPlayerPayload } from '@sublight/protocol'
import { engine, EngineError } from '../lib/engine'
import { DB_NAME, __resetDbForTests } from '../lib/idb'
import { useCaptionStore } from './caption'
import { pageVideoError, usePlayerStore } from './player'

const payload = (sources: OpenInPlayerPayload['media']['sources']): OpenInPlayerPayload => ({
  version: 1,
  source: { pageUrl: 'https://site.test/watch?v=1', pageTitle: 'A talk' },
  media: { title: 'A talk', durationMs: 60_000, isLive: false, sources },
  resumeAtMs: 12_000,
  requestedBy: 'popup',
  engine: { userAgent: 'UA', cookiesFromBrowser: 'brave' },
})

describe('open in Sublight Player (M05b)', () => {
  beforeEach(async () => {
    __resetDbForTests()
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = req.onerror = req.onblocked = () => r()
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('plays a page’s own file directly, resuming where the page was', async () => {
    const resolve = vi.spyOn(engine, 'resolveMedia').mockRejectedValue(new Error('offline'))
    await usePlayerStore
      .getState()
      .openFromPage(payload([{ kind: 'https-direct', url: 'https://cdn.test/a.mp4' }]))
    const s = usePlayerStore.getState()
    expect(s.view.name).toBe('player')
    expect(s.videoObjectUrl).toBe('https://cdn.test/a.mp4')
    expect(s.project!.media).toMatchObject({
      kind: 'page-video',
      pageUrl: 'https://site.test/watch?v=1',
      transport: 'direct',
      resumeAtMs: 12_000,
    })
    expect(s.project!.title).toBe('A talk')
    // Only in the background: the engine saves a copy in case the link stops working.
    expect(resolve).toHaveBeenCalledWith({
      pageUrl: 'https://site.test/watch?v=1',
      mediaUrl: 'https://cdn.test/a.mp4',
      userAgent: 'UA',
      cookiesFromBrowser: 'brave',
    })
  })

  // The store polls the copy every 1.5 s while the engine saves it.
  it(
    'plays and captions the engine’s copy once the page’s link stops working (B8)',
    { timeout: 15_000 },
    async () => {
      const relayId = 'a'.repeat(32)
      vi.spyOn(engine, 'resolveMedia').mockResolvedValue({
        mediaId: relayId,
        relayPath: `/v1/relay/${relayId}`,
        durationMs: 60_000,
        title: null,
        via: 'direct',
        state: 'ready',
      })
      await usePlayerStore
        .getState()
        .openFromPage(payload([{ kind: 'https-direct', url: 'https://cdn.test/stream/token' }]))
      await vi.waitFor(() => expect(usePlayerStore.getState().project!.media.relayId).toBe(relayId))
      vi.spyOn(engine, 'relayStatus')
        .mockResolvedValueOnce({
          state: 'ready',
          progress: 1,
          copy: { state: 'downloading', progress: 0.5 },
        })
        .mockResolvedValue({ state: 'ready', progress: 1, copy: { state: 'ready', progress: 1 } })
      // The site's link now answers 403: the <video> errors.
      await usePlayerStore.getState().playbackFailed()
      const s = usePlayerStore.getState()
      expect(s.videoObjectUrl).toBe(engine.relayUrl(`/v1/relay/${relayId}`))
      expect(s.preparing).toBeNull()
      expect(s.project!.media.transport).toBe('engine-relay')

      const create = vi.spyOn(engine, 'createJob').mockRejectedValue(new Error('stop here'))
      await useCaptionStore
        .getState()
        .start({ model: 'whisper-small', language: null, task: 'transcribe' })
      expect(create.mock.calls[0]![0]).toMatchObject({
        type: 'url',
        mediaUrl: 'https://cdn.test/stream/token',
        relayId,
      })
    },
  )

  // The store polls the relay every 1.5 s while the engine downloads.
  it(
    'plays a blob/MSE video through the engine relay after "Preparing media…"',
    { timeout: 15_000 },
    async () => {
      const resolve = vi.spyOn(engine, 'resolveMedia').mockResolvedValue({
        mediaId: 'r1',
        relayPath: '/v1/relay/r1',
        durationMs: 60_000,
        title: 'A talk',
        via: 'yt-dlp',
        state: 'downloading',
      })
      vi.spyOn(engine, 'relayStatus').mockResolvedValue({ state: 'ready', progress: 1 })
      await usePlayerStore
        .getState()
        .openFromPage(payload([{ kind: 'engine-fetchable', url: 'https://site.test/watch?v=1' }]))
      expect(resolve).toHaveBeenCalledWith({
        pageUrl: 'https://site.test/watch?v=1',
        userAgent: 'UA',
        cookiesFromBrowser: 'brave',
      })
      const s = usePlayerStore.getState()
      expect(s.videoObjectUrl).toBe(engine.relayUrl('/v1/relay/r1'))
      expect(s.preparing).toBeNull()
      expect(s.project!.media.transport).toBe('engine-relay')
    },
  )

  it('re-opens from the library with the same fetch hints, after a reload (M05b.8)', async () => {
    const ready = {
      mediaId: 'r2',
      relayPath: '/v1/relay/r2',
      durationMs: 60_000,
      title: 'A talk',
      via: 'yt-dlp' as const,
      state: 'ready' as const,
    }
    const resolve = vi.spyOn(engine, 'resolveMedia').mockResolvedValue(ready)
    await usePlayerStore
      .getState()
      .openFromPage(payload([{ kind: 'engine-fetchable', url: 'https://site.test/watch?v=1' }]))
    const id = usePlayerStore.getState().project!.id
    await usePlayerStore.getState().backToLibrary()
    resolve.mockClear()
    // A fresh page load: only IndexedDB remembers the project.
    __resetDbForTests()
    await usePlayerStore.getState().loadProjectFromLibrary(id)
    expect(resolve).toHaveBeenCalledWith({
      pageUrl: 'https://site.test/watch?v=1',
      userAgent: 'UA',
      cookiesFromBrowser: 'brave',
    })
    expect(usePlayerStore.getState().project!.media.resumeAtMs).toBe(12_000)
  })

  it('captions a page video with a url job (no file to upload)', async () => {
    vi.spyOn(engine, 'resolveMedia').mockRejectedValue(new Error('offline'))
    await usePlayerStore
      .getState()
      .openFromPage(payload([{ kind: 'https-direct', url: 'https://cdn.test/a.mp4' }]))
    const create = vi.spyOn(engine, 'createJob').mockResolvedValue({
      id: 'j',
      type: 'url',
      state: 'done',
      progress: 1,
      priority: 'batch',
      createdAt: 1,
      updatedAt: 1,
    })
    vi.spyOn(engine, 'result').mockResolvedValue({
      id: 'j',
      state: 'done',
      tracks: [
        {
          id: 't',
          projectId: '',
          language: 'en',
          kind: 'transcript',
          cues: [{ id: 'c', startMs: 0, endMs: 900, text: 'hi' }],
          createdAt: 1,
        },
      ],
    })
    await useCaptionStore
      .getState()
      .start({ model: 'whisper-small', language: null, task: 'transcribe' })
    const body = create.mock.calls[0]![0] as JobCreation
    expect(body).toMatchObject({
      type: 'url',
      pageUrl: 'https://site.test/watch?v=1',
      mediaUrl: 'https://cdn.test/a.mp4',
      model: 'whisper-small',
    })
    expect(usePlayerStore.getState().project!.tracks).toHaveLength(1)
  })

  it('plays an HLS page as a stream, and falls back to the engine if it can’t', async () => {
    const resolve = vi.spyOn(engine, 'resolveMedia').mockResolvedValue({
      mediaId: 'r2',
      relayPath: '/v1/relay/r2',
      durationMs: 60_000,
      title: null,
      via: 'direct',
      state: 'ready',
    })
    await usePlayerStore
      .getState()
      .openFromPage(payload([{ kind: 'hls', url: 'https://cdn.test/master.m3u8' }]))
    let s = usePlayerStore.getState()
    expect(s.stream).toEqual({ kind: 'hls', url: 'https://cdn.test/master.m3u8' })
    expect(s.project!.media.transport).toBe('hls')
    // The background copy only; playback doesn't wait for the engine.
    expect(resolve).toHaveBeenCalledTimes(1)
    // hls.js gave up (no CORS on the CDN): the engine fetches the manifest.
    await s.playbackFailed()
    s = usePlayerStore.getState()
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: 'https://cdn.test/master.m3u8' }),
    )
    expect(s.stream).toBeNull()
    expect(s.videoObjectUrl).toBe(engine.relayUrl('/v1/relay/r2'))
  })

  it('explains why a page video can’t play, and what to do', async () => {
    vi.spyOn(engine, 'resolveMedia').mockRejectedValue(
      new EngineError('MEDIA_UNREACHABLE', 'yt-dlp is not installed', 422),
    )
    await usePlayerStore
      .getState()
      .openFromPage(payload([{ kind: 'engine-fetchable', url: 'https://site.test/watch?v=1' }]))
    const err = usePlayerStore.getState().pageError!
    expect(err.code).toBe('MEDIA_UNREACHABLE')
    expect(err.captionOnPage).toBe(true)
    expect(pageVideoError(new EngineError('OFFLINE', 'x')).message).toMatch(/engine isn’t running/)
    expect(pageVideoError(new EngineError('MEDIA_PROTECTED', 'x', 422)).captionOnPage).toBe(false)
  })
})
