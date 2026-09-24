import { useCallback, useEffect, useRef, useState } from 'react'
import type { SubtitleProject } from '@sublight/core'
import { listProjects } from '../lib/idb'
import { hasFileSystemAccess } from '../lib/fileOpen'
import { usePlayerStore } from '../store/player'
import { isVideoFile } from '../lib/fileOpen'

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function Library() {
  const openWithFile = usePlayerStore((s) => s.openWithFile)
  const pickVideo = usePlayerStore((s) => s.pickVideo)
  const loadProjectFromLibrary = usePlayerStore((s) => s.loadProjectFromLibrary)
  const error = usePlayerStore((s) => s.error)
  const setError = usePlayerStore((s) => s.setError)
  const inputRef = useRef<HTMLInputElement>(null)
  const [recent, setRecent] = useState<SubtitleProject[] | null>(null)

  const refresh = useCallback(() => {
    listProjects()
      .then(setRecent)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [setError])

  useEffect(() => {
    refresh()
  }, [refresh])

  const onFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0]
      if (file && isVideoFile(file)) void openWithFile(file)
      // ignore non-video drops silently; nothing is lost
    },
    [openWithFile],
  )

  const handleOpen = useCallback(() => {
    // Prefer FSA (persistent handle); cancel just stops. Fallback: picker input.
    if (hasFileSystemAccess()) {
      void pickVideo()
    } else {
      inputRef.current?.click()
    }
  }, [pickVideo])

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-6 py-8">
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          <span>{error}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            className="text-red-300 hover:text-red-100"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}

      <section
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          onFiles(e.dataTransfer.files)
        }}
        className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/50 p-10 text-center"
      >
        <h2 className="text-lg font-medium text-zinc-100">Open a video</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Local file only — playback, styling and captioning all stay on this machine.
        </p>
        <div className="mt-6 flex items-center justify-center gap-4">
          <button
            type="button"
            data-testid="open-video"
            className="rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-900 transition hover:bg-white"
            onClick={handleOpen}
          >
            Choose a video…
          </button>
          <button
            type="button"
            data-testid="attach-file"
            className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 transition hover:border-zinc-500"
            onClick={() => inputRef.current?.click()}
          >
            or pick a file
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          data-testid="file-input"
          accept="video/*,.mp4,.m4v,.webm,.mov,.mkv,.ogv,.ogm"
          className="hidden"
          onChange={(e) => {
            onFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Recent projects
        </h2>
        {recent === null ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">
            No projects yet. Open a video and the rest of the magic is local too.
          </p>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {recent.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => void loadProjectFromLibrary(project.id)}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-left transition hover:border-zinc-600"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-medium text-zinc-100">{project.title}</span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {timeAgo(project.updatedAt)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3 text-sm text-zinc-400">
                    <span className="truncate">{project.media.source ?? 'page video'}</span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {project.tracks.length} track{project.tracks.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
