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
  videoObjectUrl: string | null
  error: string | null
  /** Create a project from a local video file. */
  openWithFile: (file: File, handle?: FileSystemFileHandleLike) => Promise<void>
  /** FSA picker; returns false when the user cancels or FSA is unavailable. */
  pickVideo: () => Promise<boolean>
  /** Re-attach a file to the current project (no persisted handle). */
  attachFile: (file: File, handle?: FileSystemFileHandleLike) => Promise<void>
  /** Open a saved project, re-resolving its media where possible. */
  loadProjectFromLibrary: (id: string) => Promise<void>
  backToLibrary: () => Promise<void>
  setError: (message: string | null) => void
  setActiveTrack: (trackId: string) => Promise<void>
  updateStyle: (patch: StylePatch) => Promise<void>
  nudgeActiveTrack: (deltaMs: number) => Promise<void>
  importTracks: (name: string, text: string, language: string) => Promise<ImportResult>
  removeTrack: (trackId: string) => Promise<void>
  exportActiveSrt: () => Promise<void>
  savePosition: (ms: number) => Promise<void>
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
    if (old) URL.revokeObjectURL(old)
    return file ? URL.createObjectURL(file) : null
  }

  return {
    view: { name: 'library' },
    project: null,
    videoObjectUrl: null,
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
      set({ view: { name: 'player' }, project, videoObjectUrl: url, error: null })
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
      set({ videoObjectUrl: url, error: null })
    },

    loadProjectFromLibrary: async (id) => {
      try {
        const project = await loadProject(id)
        if (!project) {
          set({ error: 'Project not found — it may have been removed.' })
          return
        }
        let url: string | null = null
        if (project.media.kind === 'local-file') {
          const handle = await getSetting<FileSystemFileHandleLike>(mediaHandleKey(id))
          if (handle) {
            const media = await reopenLocalMedia(handle)
            if (media) url = await swapObjectUrl(media.file)
            else set({ error: 'Reading the video file was denied — choose the file again.' })
          }
        }
        set({ project, videoObjectUrl: url, view: { name: 'player' } })
      } catch (err) {
        set({ error: `Could not open the project: ${msg(err)}` })
      }
    },

    backToLibrary: async () => {
      await swapObjectUrl(null)
      set({ view: { name: 'library' }, project: null, videoObjectUrl: null, error: null })
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
  }
})
