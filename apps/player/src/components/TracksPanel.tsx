import { useRef, useState } from 'react'
import type { SubtitleTrack } from '@sublight/core'
import { usePlayerStore } from '../store/player'
import { TranslateForm } from './TranslateForm'

const KIND_LABEL: Record<SubtitleTrack['kind'], string> = {
  transcript: 'AI',
  translation: 'TL',
  import: 'SRT',
}

export function TracksPanel() {
  const project = usePlayerStore((s) => s.project)
  const setActiveTrack = usePlayerStore((s) => s.setActiveTrack)
  const removeTrack = usePlayerStore((s) => s.removeTrack)
  const importTracks = usePlayerStore((s) => s.importTracks)
  const exportActiveSrt = usePlayerStore((s) => s.exportActiveSrt)
  const setError = usePlayerStore((s) => s.setError)
  const setBilingual = usePlayerStore((s) => s.setBilingual)
  const [translatingId, setTranslatingId] = useState<string | null>(null)
  const [language, setLanguage] = useState('en')
  const importInputRef = useRef<HTMLInputElement>(null)
  if (!project) return null

  const activeTrackId = project.settings.activeTrackId

  const onImportFile = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    const text = await file.text()
    const result = await importTracks(file.name, text, language)
    if (result.errors.length > 0) {
      setError(result.errors.join(' '))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400">Lang</label>
        <input
          data-testid="track-language"
          className="w-24 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          placeholder="en / pt-BR"
        />
      </div>

      {project.tracks.length === 0 && (
        <p className="text-sm text-zinc-500">No tracks yet — import an SRT or VTT file to start.</p>
      )}

      <ul className="flex flex-col gap-2">
        {project.tracks.map((track) => (
          <li
            key={track.id}
            className={`rounded-lg border p-3 transition ${
              track.id === activeTrackId
                ? 'border-zinc-500 bg-zinc-800/70'
                : 'border-zinc-800 bg-zinc-900/50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="flex flex-1 items-baseline gap-2 text-left"
                onClick={() => void setActiveTrack(track.id)}
                aria-pressed={track.id === activeTrackId}
              >
                <span className="font-medium text-zinc-100">{track.language}</span>
                <span className="rounded bg-zinc-700/70 px-1 py-0.5 text-[10px] text-zinc-300">
                  {KIND_LABEL[track.kind]}
                </span>
                {track.draft && (
                  <span className="rounded bg-amber-400/10 px-1 py-0.5 text-[10px] text-amber-300">
                    draft
                  </span>
                )}
                <span className="text-xs text-zinc-500">{track.cues.length} cues</span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${track.language} track`}
                className="text-xs text-zinc-500 transition hover:text-red-300"
                onClick={() => void removeTrack(track.id)}
              >
                ✕
              </button>
            </div>
            {track.title && <p className="mt-0.5 text-xs text-zinc-500">{track.title}</p>}
            <TrackActions
              track={track}
              hasSource={project.tracks.some((t) => t.id === track.derivedFrom?.trackId)}
              bilingual={project.settings.bilingual?.translationTrackId === track.id}
              translating={translatingId === track.id}
              onTranslate={() => setTranslatingId((id) => (id === track.id ? null : track.id))}
              onBilingual={(on) =>
                void setBilingual(
                  on && track.derivedFrom?.trackId
                    ? { sourceTrackId: track.derivedFrom.trackId, translationTrackId: track.id }
                    : null,
                )
              }
            />
            {translatingId === track.id && <TranslateForm track={track} />}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
        <button
          type="button"
          data-testid="import-track"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500"
          onClick={() => importInputRef.current?.click()}
        >
          Import SRT / VTT
        </button>
        <button
          type="button"
          data-testid="export-srt"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500"
          onClick={() => void exportActiveSrt()}
          disabled={project.tracks.length === 0}
        >
          Export SRT
        </button>
        <input
          ref={importInputRef}
          type="file"
          data-testid="track-import-input"
          accept=".srt,.vtt,text/plain,application/x-subrip,text/vtt"
          className="hidden"
          onChange={(e) => {
            void onImportFile(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

function TrackActions({
  track,
  hasSource,
  bilingual,
  translating,
  onTranslate,
  onBilingual,
}: {
  track: SubtitleTrack
  hasSource: boolean
  bilingual: boolean
  translating: boolean
  onTranslate: () => void
  onBilingual: (on: boolean) => void
}) {
  const low = track.cues.filter((c) => c.lowConfidence).length
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
      <button
        type="button"
        data-testid={`translate-${track.id}`}
        className={`transition ${translating ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
        onClick={onTranslate}
      >
        Translate…
      </button>
      {track.kind === 'translation' && hasSource && (
        <label className="flex items-center gap-1.5 text-zinc-400">
          <input
            type="checkbox"
            data-testid={`bilingual-${track.id}`}
            checked={bilingual}
            onChange={(e) => onBilingual(e.target.checked)}
          />
          With original
        </label>
      )}
      {low > 0 && (
        <span
          className="text-amber-300"
          title="Lines the model didn't return one-to-one; re-split by timing"
        >
          {low} to review
        </span>
      )}
    </div>
  )
}
