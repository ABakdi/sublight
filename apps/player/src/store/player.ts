import { create } from 'zustand'
import {
  DEFAULT_SUBTITLE_STYLE,
  detectSubtitleFormat,
  newId,
  normalizeCues,
  parseSrt,
  parseVtt,
  serializeSrt,
  shiftCues,
  type SubtitleCue,
  type SubtitleProject,
  type SubtitleStyle,
  type SubtitleTrack,
} from '@sublight/core'
import type { OpenInPlayerPayload } from '@sublight/protocol'
import { engine, EngineError } from '../lib/engine'
import type { StreamKind } from '../lib/streaming'
import { getSetting, loadProject, saveProject, saveProjectRow, setSetting } from '../lib/idb'
import {
  mediaHandleKey,
  pickVideoFile,
  reopenLocalMedia,
  type FileSystemFileHandleLike,
} from '../lib/fileOpen'

export type View = { name: 'library' } | { name: 'player' }

export interface ImportResult {
  added: number
  errors: string[]
}

/** A style patch where nested `position` (and other objects) may be partial. */
export type StylePatch = Partial<Omit<SubtitleStyle, 'position'>> & {
  position?: Partial<SubtitleStyle['position']>
}

export interface PlayerState {
  view: View
  project: SubtitleProject | null
  /** What the `<video>` plays: a blob: URL (local file), the page's own URL, or an engine relay. */
  videoObjectUrl: string | null
  /** A page video the engine is fetching ("Preparing media…", 0..1), else null. */
  preparing: { progress: number } | null
  /** A page video's HLS/DASH manifest, played with hls.js / dash.js (M05b.4). */
  stream: { kind: StreamKind; url: string } | null
  /** Why a page video can't play here, with what to do instead (M05b.6). */
  pageError: PageVideoError | null
  /** The opened file itself, needed to upload it for captioning (null after a reload until re-attached). */
  videoFile: File | null
  error: string | null
  /** Create a project from a local video file. */
  openWithFile: (file: File, handle?: FileSystemFileHandleLike) => Promise<void>
  /** FSA picker; returns false when the user cancels or FSA is unavailable. */
  pickVideo: () => Promise<boolean>
  /** Re-attach a file to the current project (no persisted handle). */
  attachFile: (file: File, handle?: FileSystemFileHandleLike) => Promise<void>
  /** Open a saved project, re-resolving its media where possible. */
  loadProjectFromLibrary: (id: string) => Promise<void>
  /** "Open in Sublight Player": a page's video, handed over by the extension (M05b). */
  openFromPage: (payload: OpenInPlayerPayload) => Promise<void>
  /** The page's own URL wouldn't play here: fetch it through the engine instead. */
  playbackFailed: () => Promise<void>
  /** Try a page video again (after starting the engine, say). */
  retryPageVideo: () => Promise<void>
  backToLibrary: () => Promise<void>
  setError: (message: string | null) => void
  setActiveTrack: (trackId: string) => Promise<void>
  updateStyle: (patch: StylePatch) => Promise<void>
  nudgeActiveTrack: (deltaMs: number) => Promise<void>
  importTracks: (name: string, text: string, language: string) => Promise<ImportResult>
  removeTrack: (trackId: string) => Promise<void>
  exportActiveSrt: () => Promise<void>
  savePosition: (ms: number) => Promise<void>
  /** Remember the engine's normalized-audio hash so re-captioning skips the upload (Spec 04 §4). */
  setMediaHash: (mediaHash: string) => Promise<void>
  /** Add an engine-produced track to the project and make it active. */
  addGeneratedTrack: (track: SubtitleTrack) => Promise<void>
  /** Show a translation with its source above it (Spec 05 §7), or turn that off. */
  setBilingual: (
    pair: { sourceTrackId: string; translationTrackId: string } | null,
  ) => Promise<void>
  setGlossary: (glossary: { source: string; target: string }[]) => Promise<void>
}

/** The payload is page-supplied: a user agent must be one plain header value. */
function safeHints(
  hints: OpenInPlayerPayload['engine'],
): NonNullable<OpenInPlayerPayload['engine']> {
  const out = { ...(hints ?? {}) }
  if (
    out.userAgent !== undefined &&
    (typeof out.userAgent !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(out.userAgent))
  )
    delete out.userAgent
  return out
}

/** Why a page video can't play in the Player, and the way forward (M05b.6, Spec 10). */
export interface PageVideoError {
  code: string
  message: string
  /** Captioning it on its own page (the extension) is still possible. */
  captionOnPage: boolean
}

export function pageVideoError(err: unknown): PageVideoError {
  const code = err instanceof EngineError ? err.code : 'INTERNAL'
  const detail = err instanceof Error ? err.message : String(err)
  switch (code) {
    case 'OFFLINE':
      return {
        code,
        message:
          'This video can only play here through the engine, and the engine isn’t running. Start it (sublight-engine start), then try again.',
        captionOnPage: true,
      }
    case 'UNAUTHORIZED':
      return {
        code,
        message: 'The engine rejected the Player’s token. Pair the Player again, then try again.',
        captionOnPage: true,
      }
    case 'MEDIA_PROTECTED':
      return {
        code,
        message:
          'This video is DRM-protected: it can’t be played or captioned outside its own player.',
        captionOnPage: false,
      }
    default:
      return {
        code,
        message: `The engine couldn’t get this video (${detail}). Captioning it on its own page still works.`,
        captionOnPage: true,
      }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Track picked as active: explicit activeTrackId, else the first track. */
export function activeTrackOf(project: SubtitleProject): SubtitleTrack | null {
  return (
    project.tracks.find((t) => t.id === project.settings.activeTrackId) ?? project.tracks[0] ?? null
  )
}

/** Rough language hint from filenames like `captions.en.srt` / `subtitles_pt-BR.vtt`. */
function languageHint(name: string): string | null {
  const m = /(?:[._-])([a-z]{2,3}(?:-[A-Za-z]{2,4})?)(?:[._]|$)/i.exec(name)
  return m?.[1] ?? null
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'subtitles'
  )
}

function downloadTextFile(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  /** Clone + mutate + bump updatedAt + persist; never mutates in place. */
  const commit = async (mutate: (p: SubtitleProject) => void): Promise<void> => {
    const project = get().project
    if (!project) return
    let next: SubtitleProject
    try {
      next = structuredClone(project)
    } catch {
      next = JSON.parse(JSON.stringify(project)) as SubtitleProject
    }
    mutate(next)
    next.updatedAt = Date.now()
    set({ project: next })
    try {
      await saveProject(next)
    } catch (err) {
      set({ error: `Could not save project: ${msg(err)}` })
    }
  }

  const swapObjectUrl = async (file: File | null): Promise<string | null> => {
    const old = get().videoObjectUrl
    if (old?.startsWith('blob:')) URL.revokeObjectURL(old)
    return file ? URL.createObjectURL(file) : null
  }

  /** Engine hints for fetching the current page video (from the extension). */

  /**
   * Play a page video (Spec 04 §9): its own file URL when it has one (no
   * engine needed), else a relay from the engine: straight through when the
   * site serves one file, or downloaded and merged first ("Preparing media…").
   */
  const resolvePlayback = async (project: SubtitleProject, skipDirect = false): Promise<void> => {
    const media = project.media
    const own = media.sources?.find(
      (x) => x.kind === 'https-direct' || x.kind === 'hls' || x.kind === 'dash',
    )
    if (own && !skipDirect) {
      const transport = own.kind === 'https-direct' ? 'direct' : own.kind
      set({
        videoObjectUrl: own.kind === 'https-direct' ? own.url : null,
        stream: own.kind === 'hls' || own.kind === 'dash' ? { kind: own.kind, url: own.url } : null,
        preparing: null,
        pageError: null,
      })
      await commit((p) => {
        p.media.transport = transport as 'direct' | 'hls' | 'dash'
        p.media.directUrl = own.url
      })
      return
    }
    set({ videoObjectUrl: null, stream: null, preparing: { progress: 0 }, pageError: null })
    try {
      const resolved = await engine.resolveMedia({
        pageUrl: media.pageUrl!,
        ...(own ? { mediaUrl: own.url } : {}),
        ...safeHints(media.fetchHints as OpenInPlayerPayload['engine']),
      })
      let state = resolved.state
      while (state === 'downloading') {
        await new Promise((r) => setTimeout(r, 1500))
        if (get().project?.id !== project.id) return // the viewer left
        const status = await engine.relayStatus(resolved.mediaId)
        state = status.state
        set({ preparing: { progress: status.progress } })
        if (status.state === 'failed')
          throw new EngineError('MEDIA_UNREACHABLE', status.error ?? 'the download failed')
      }
      const url = engine.relayUrl(resolved.relayPath)
      if (get().project?.id !== project.id) return
      set({ videoObjectUrl: url, preparing: null })
      await commit((p) => {
        p.media.transport = 'engine-relay'
        p.media.relayId = resolved.mediaId
        p.media.directUrl = url
        if (resolved.durationMs) p.media.durationMs = resolved.durationMs
      })
    } catch (err) {
      set({ preparing: null, pageError: pageVideoError(err) })
    }
  }

  return {
    view: { name: 'library' },
    project: null,
    videoObjectUrl: null,
    preparing: null,
    stream: null,
    pageError: null,
    videoFile: null,
    error: null,

    openWithFile: async (file, handle) => {
      const url = await swapObjectUrl(file)
      const project: SubtitleProject = {
        id: newId(),
        title: baseName(file.name) || 'Untitled video',
        media: { kind: 'local-file', source: file.name },
        tracks: [],
        settings: { style: structuredClone(DEFAULT_SUBTITLE_STYLE) },
        updatedAt: Date.now(),
      }
      if (handle) await setSetting(mediaHandleKey(project.id), handle)
      await saveProject(project)
      set({ view: { name: 'player' }, project, videoObjectUrl: url, videoFile: file, error: null })
    },

    openFromPage: async (payload) => {
      await swapObjectUrl(null)
      const hints = safeHints(payload.engine)
      const title = payload.media.title || payload.source.pageTitle || 'Page video'
      const project: SubtitleProject = {
        id: newId(),
        title,
        media: {
          kind: 'page-video',
          source: payload.source.pageUrl,
          pageUrl: payload.source.pageUrl,
          ...(payload.source.pageTitle ? { pageTitle: payload.source.pageTitle } : {}),
          sources: payload.media.sources,
          ...(payload.media.durationMs ? { durationMs: payload.media.durationMs } : {}),
          ...(payload.resumeAtMs ? { resumeAtMs: payload.resumeAtMs } : {}),
          ...(Object.keys(hints).length ? { fetchHints: hints } : {}),
        },
        tracks: [],
        settings: { style: structuredClone(DEFAULT_SUBTITLE_STYLE) },
        updatedAt: Date.now(),
      }
      await saveProject(project)
      set({
        view: { name: 'player' },
        project,
        videoObjectUrl: null,
        videoFile: null,
        error: null,
      })
      await resolvePlayback(project)
    },

    playbackFailed: async () => {
      const project = get().project
      const t = project?.media.transport
      if (project?.media.kind !== 'page-video' || (t !== 'direct' && t !== 'hls' && t !== 'dash'))
        return
      await resolvePlayback(project, true)
    },

    retryPageVideo: async () => {
      const project = get().project
      if (project?.media.kind === 'page-video') await resolvePlayback(project)
    },

    pickVideo: async () => {
      try {
        const picked = await pickVideoFile()
        if (!picked) return false
        await get().openWithFile(picked.file, picked.handle)
        return true
      } catch (err) {
        set({ error: `Could not open the file: ${msg(err)}` })
        return false
      }
    },

    attachFile: async (file, handle) => {
      const project = get().project
      if (!project) return
      const url = await swapObjectUrl(file)
      if (handle) await setSetting(mediaHandleKey(project.id), handle)
      await commit((p) => {
        p.media.source = file.name
      })
      set({ videoObjectUrl: url, videoFile: file, error: null })
    },

    loadProjectFromLibrary: async (id) => {
      try {
        const project = await loadProject(id)
        if (!project) {
          set({ error: 'Project not found — it may have been removed.' })
          return
        }
        let url: string | null = null
        let file: File | null = null
        if (project.media.kind === 'local-file') {
          const handle = await getSetting<FileSystemFileHandleLike>(mediaHandleKey(id))
          if (handle) {
            const media = await reopenLocalMedia(handle)
            if (media) {
              file = media.file
              url = await swapObjectUrl(media.file)
            } else set({ error: 'Reading the video file was denied — choose the file again.' })
          }
        }
        set({ project, videoObjectUrl: url, videoFile: file, view: { name: 'player' } })
        // A page video's relay died with the engine run: find the stream again.
        if (project.media.kind === 'page-video' && project.media.pageUrl)
          await resolvePlayback(project)
      } catch (err) {
        set({ error: `Could not open the project: ${msg(err)}` })
      }
    },

    backToLibrary: async () => {
      await swapObjectUrl(null)
      set({
        view: { name: 'library' },
        project: null,
        videoObjectUrl: null,
        preparing: null,
        stream: null,
        pageError: null,
        videoFile: null,
        error: null,
      })
    },

    setError: (message) => set({ error: message }),

    setActiveTrack: async (trackId) => {
      await commit((p) => {
        if (p.tracks.some((t) => t.id === trackId)) p.settings.activeTrackId = trackId
      })
    },

    updateStyle: async (patch) => {
      await commit((p) => {
        p.settings.style = {
          ...p.settings.style,
          ...patch,
          position: { ...p.settings.style.position, ...(patch.position ?? {}) },
        }
      })
    },

    nudgeActiveTrack: async (deltaMs) => {
      await commit((p) => {
        const track = activeTrackOf(p)
        if (!track) return
        const current = track.syncOffsetMs ?? 0
        track.syncOffsetMs = Math.max(-60_000, Math.min(60_000, current + deltaMs))
      })
    },

    importTracks: async (name, text, language) => {
      const project = get().project
      if (!project) {
        return { added: 0, errors: ['No project is loaded.'] }
      }
      const format = detectSubtitleFormat(text)
      let cues: SubtitleCue[]
      try {
        const parsed = format === 'vtt' ? parseVtt(text) : format === 'srt' ? parseSrt(text) : []
        // Files can list cues out of order; the overlay's lookup needs them sorted.
        cues = normalizeCues(parsed)
      } catch (err) {
        return { added: 0, errors: [`Could not parse file: ${msg(err)}`] }
      }
      if (cues.length === 0) {
        return {
          added: 0,
          errors: [
            format === 'unknown'
              ? 'Unrecognized subtitle format (expected SRT or VTT).'
              : 'The file parsed but contained no cues.',
          ],
        }
      }
      const lang = language.trim() || languageHint(name) || 'en'
      const track: SubtitleTrack = {
        id: newId(),
        projectId: project.id,
        language: lang,
        title: `${lang} · imported`,
        kind: 'import',
        cues,
        createdAt: Date.now(),
      }
      await commit((p) => {
        p.tracks.push(track)
        p.settings.activeTrackId = track.id
      })
      return { added: cues.length, errors: [] }
    },

    removeTrack: async (trackId) => {
      await commit((p) => {
        p.tracks = p.tracks.filter((t) => t.id !== trackId)
        if (p.settings.activeTrackId === trackId) p.settings.activeTrackId = undefined
        const pair = p.settings.bilingual
        if (pair && (pair.sourceTrackId === trackId || pair.translationTrackId === trackId)) {
          p.settings.bilingual = null
        }
      })
    },

    exportActiveSrt: async () => {
      const project = get().project
      if (!project) return
      const track = activeTrackOf(project)
      if (!track) return
      // Bake the nudge in so the file plays in sync outside sublight too.
      const offset = track.syncOffsetMs ?? 0
      const text = serializeSrt(offset === 0 ? track.cues : shiftCues(track.cues, offset))
      downloadTextFile(
        text,
        `${slug(project.title)}.${track.language}.srt`,
        'text/plain;charset=utf-8',
      )
    },

    // Runs every few seconds during playback: shallow update (tracks keep their
    // identity, so the overlay doesn't recompute) and only the project row is
    // written. updatedAt is left alone so watching doesn't reorder the library.
    savePosition: async (ms) => {
      const project = get().project
      if (!project) return
      const next = {
        ...project,
        media: { ...project.media, resumeAtMs: Math.max(0, Math.round(ms)) },
      }
      set({ project: next })
      try {
        await saveProjectRow(next)
      } catch (err) {
        set({ error: `Could not save playback position: ${msg(err)}` })
      }
    },

    setMediaHash: async (mediaHash) => {
      if (get().project?.media.mediaHash === mediaHash) return
      await commit((p) => {
        p.media.mediaHash = mediaHash
      })
    },

    addGeneratedTrack: async (track) => {
      await commit((p) => {
        p.tracks.push({ ...track, projectId: p.id, draft: false })
        p.settings.activeTrackId = track.id
      })
    },

    setBilingual: async (pair) => {
      await commit((p) => {
        p.settings.bilingual = pair
        if (pair) p.settings.activeTrackId = pair.translationTrackId
      })
    },

    setGlossary: async (glossary) => {
      await commit((p) => {
        p.settings.glossary = glossary
      })
    },
  }
})
