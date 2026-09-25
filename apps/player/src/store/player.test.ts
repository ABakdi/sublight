// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE } from '@sublight/core'
import { DB_NAME, loadProject, openDb, PROJECTS_STORE, __resetDbForTests } from '../lib/idb'
import { activeTrackOf, usePlayerStore } from './player'

const SRT = `1
00:00:00,500 --> 00:00:01,500
Hello world

2
00:00:02,000 --> 00:00:03,000
Bye bye
`

async function wipeDb(): Promise<void> {
  __resetDbForTests()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

describe('player store (M01.3–M01.5)', () => {
  const videoFile = () => new File(['video'], 'my-movie.mp4', { type: 'video/mp4' })

  beforeEach(async () => {
    await wipeDb()
    usePlayerStore.setState({
      view: { name: 'library' },
      project: null,
      videoObjectUrl: null,
      error: null,
    })
    URL.createObjectURL = vi.fn(() => 'blob:fixture') as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
  })

  it('creates and persists a project from a local file', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    const state = usePlayerStore.getState()
    expect(state.view.name).toBe('player')
    expect(state.project?.title).toBe('my-movie')
    expect(state.project?.media.source).toBe('my-movie.mp4')
    const persisted = await loadProject(state.project!.id)
    expect(persisted?.media.kind).toBe('local-file')
  })

  it('imports SRT into a new active track and persists cues', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    const result = await usePlayerStore.getState().importTracks('captions.en.srt', SRT, 'en')
    expect(result).toEqual({ added: 2, errors: [] })
    const state = usePlayerStore.getState()
    const track = activeTrackOf(state.project!)
    expect(track?.language).toBe('en')
    expect(track?.kind).toBe('import')
    const persisted = await loadProject(state.project!.id)
    expect(persisted?.tracks).toHaveLength(1)
    expect(persisted?.tracks[0]!.cues[0]!.text).toBe('Hello world')
  })

  it('infers a language hint from the filename when none is given', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore
      .getState()
      .importTracks('subtitles_pt-BR.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOlá', '')
    const state = usePlayerStore.getState()
    expect(activeTrackOf(state.project!)?.language).toBe('pt-BR')
  })

  it('nudges the active track offset and persists it (M01.5)', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore.getState().importTracks('captions.en.srt', SRT, 'en')
    await usePlayerStore.getState().nudgeActiveTrack(50)
    await usePlayerStore.getState().nudgeActiveTrack(50)
    expect(activeTrackOf(usePlayerStore.getState().project!)?.syncOffsetMs).toBe(100)
    const persisted = await loadProject(usePlayerStore.getState().project!.id)
    expect(persisted?.tracks[0]!.syncOffsetMs).toBe(100)
  })

  it('merges style partials including position without losing other fields', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore.getState().updateStyle({ fontSize: 48 })
    await usePlayerStore.getState().updateStyle({ position: { anchor: 'top-right' } })
    const style = usePlayerStore.getState().project!.settings.style
    expect(style.fontSize).toBe(48)
    expect(style.position.anchor).toBe('top-right')
    expect(style.position.marginPx).toBe(DEFAULT_SUBTITLE_STYLE.position.marginPx)
  })

  it('reports import errors instead of crashing on malformed input (AC#4)', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    const result = await usePlayerStore
      .getState()
      .importTracks('broken.srt', 'not subtitles at all', '')
    expect(result.added).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(usePlayerStore.getState().project!.tracks).toHaveLength(0)
  })

  it('switches the active track via setActiveTrack', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore.getState().importTracks('a.en.srt', SRT, 'en')
    await usePlayerStore
      .getState()
      .importTracks('b.fr.srt', '1\n00:00:01,000 --> 00:00:02,000\nBonjour\n', 'fr')
    const { project } = usePlayerStore.getState()
    const fr = project!.tracks.find((t) => t.language === 'fr')!
    await usePlayerStore.getState().setActiveTrack(fr.id)
    expect(activeTrackOf(usePlayerStore.getState().project!)?.language).toBe('fr')
  })

  it('removes a track and clears a dangling activeTrackId', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore.getState().importTracks('a.en.srt', SRT, 'en')
    const { project } = usePlayerStore.getState()
    const en = project!.tracks[0]!
    await usePlayerStore.getState().removeTrack(en.id)
    expect(usePlayerStore.getState().project!.tracks).toHaveLength(0)
    expect(activeTrackOf(usePlayerStore.getState().project!)).toBeNull()
  })

  it('remembers the playhead position per project', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore.getState().savePosition(42_500)
    const persisted = await loadProject(usePlayerStore.getState().project!.id)
    expect(persisted?.media.resumeAtMs).toBe(42_500)
  })

  it('saves the position without bumping updatedAt or cloning tracks', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore.getState().importTracks('captions.en.srt', SRT, 'en')
    const before = usePlayerStore.getState().project!
    await usePlayerStore.getState().savePosition(1_000)
    const after = usePlayerStore.getState().project!
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.tracks).toBe(before.tracks)
    const persisted = await loadProject(after.id)
    expect(persisted?.tracks).toHaveLength(1)
  })

  it('stores tracks only in the tracks store, not inside the project row', async () => {
    await usePlayerStore.getState().openWithFile(videoFile())
    await usePlayerStore.getState().importTracks('captions.en.srt', SRT, 'en')
    const id = usePlayerStore.getState().project!.id
    const db = await openDb()
    const row = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).get(id)
      req.onsuccess = () => resolve(req.result as Record<string, unknown>)
      req.onerror = () => reject(req.error)
    })
    expect(row).not.toHaveProperty('tracks')
  })
})
