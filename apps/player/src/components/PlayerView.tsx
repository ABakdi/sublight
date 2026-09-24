import { useCallback, useEffect, useRef, useState } from 'react'
import { SubtitleOverlay } from '@sublight/overlay'
import { activeTrackOf, usePlayerStore } from '../store/player'
import { hasFileSystemAccess } from '../lib/fileOpen'
import { TracksPanel } from './TracksPanel'
import { StylePanel } from './StylePanel'

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

const ICON_BTN =
  'rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700'

export function PlayerView() {
  const project = usePlayerStore((s) => s.project)
  const videoObjectUrl = usePlayerStore((s) => s.videoObjectUrl)
  const error = usePlayerStore((s) => s.error)
  const setError = usePlayerStore((s) => s.setError)
  const backToLibrary = usePlayerStore((s) => s.backToLibrary)
  const nudgeActiveTrack = usePlayerStore((s) => s.nudgeActiveTrack)
  const savePosition = usePlayerStore((s) => s.savePosition)
  const pickVideo = usePlayerStore((s) => s.pickVideo)
  const attachFile = usePlayerStore((s) => s.attachFile)

  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [muted, setMuted] = useState(false)
  const [captionsVisible, setCaptionsVisible] = useState(true)
  const [panel, setPanel] = useState<'tracks' | 'style'>('tracks')

  const activeTrack = project ? activeTrackOf(project) : null

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      void v.play()
    } else {
      v.pause()
    }
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const v = videoRef.current
    if (!v || !Number.isFinite(seconds)) return
    const max = Number.isFinite(v.duration) ? v.duration : seconds
    v.currentTime = Math.min(Math.max(0, seconds), max)
  }, [])

  const jumpCue = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current
      if (!v || !activeTrack || activeTrack.cues.length === 0) return
      const t = v.currentTime * 1000
      const idx = activeTrack.cues.findIndex((c) => c.startMs <= t && t < c.endMs)
      const target =
        dir === 1
          ? activeTrack.cues[idx + 1]
          : idx >= 0
            ? activeTrack.cues[idx - 1]
            : activeTrack.cues[activeTrack.cues.length - 1]
      if (target) v.currentTime = target.startMs / 1000
    },
    [activeTrack],
  )

  // Keyboard map (Spec 04 §3 / 05 §8). Avoid hijacking space on focused buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const editable = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
      if (e.key === ' ' && tag === 'BUTTON') return
      if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault()
        if (!editable) jumpCue(e.key === 'ArrowRight' ? 1 : -1)
        return
      }
      if (editable) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowRight':
          e.preventDefault()
          seekTo((videoRef.current?.currentTime ?? 0) + (e.shiftKey ? 10 : 5))
          break
        case 'ArrowLeft':
          e.preventDefault()
          seekTo((videoRef.current?.currentTime ?? 0) - (e.shiftKey ? 10 : 5))
          break
        case '[':
          void nudgeActiveTrack(-50)
          break
        case ']':
          void nudgeActiveTrack(50)
          break
        case 'c':
        case 'C':
          setCaptionsVisible((v) => !v)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekTo, jumpCue, nudgeActiveTrack])

  // Position persistence: save on pause/seek and every 5 s while playing.
  useEffect(() => {
    const timer = setInterval(() => {
      const v = videoRef.current
      if (v && !v.paused) void savePosition(v.currentTime * 1000)
    }, 5000)
    return () => clearInterval(timer)
  }, [savePosition])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen()
  }, [])

  const togglePiP = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture()
    else void v.requestPictureInPicture()
  }, [])

  const onFilePicked = useCallback(
    (file: File | null) => {
      if (file) void attachFile(file)
    },
    [attachFile],
  )

  if (!project) return null

  const offsetMs = activeTrack?.syncOffsetMs ?? 0

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3">
      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-2.5 text-sm text-red-200"
        >
          <span>{error}</span>
          <button type="button" className="text-red-300" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <button
          type="button"
          data-testid="back-to-library"
          className={ICON_BTN}
          onClick={() => void backToLibrary()}
        >
          ← Library
        </button>
        <h1 className="min-w-0 truncate text-sm font-medium text-zinc-200">{project.title}</h1>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-zinc-500">Sync</span>
          <button
            type="button"
            data-testid="nudge-minus"
            className={ICON_BTN}
            disabled={!activeTrack}
            onClick={() => void nudgeActiveTrack(-50)}
          >
            −50 ms
          </button>
          <span
            data-testid="track-offset"
            className="w-16 text-center text-xs tabular-nums text-zinc-300"
          >
            {offsetMs === 0 ? '0 ms' : `${offsetMs > 0 ? '+' : ''}${offsetMs} ms`}
          </span>
          <button
            type="button"
            data-testid="nudge-plus"
            className={ICON_BTN}
            disabled={!activeTrack}
            onClick={() => void nudgeActiveTrack(50)}
          >
            +50 ms
          </button>
          <button
            type="button"
            data-testid="toggle-captions"
            className={`${ICON_BTN} ${captionsVisible ? 'border-zinc-400 text-zinc-100' : ''}`}
            disabled={!activeTrack || activeTrack.cues.length === 0}
            onClick={() => setCaptionsVisible((v) => !v)}
          >
            Captions {captionsVisible ? 'on' : 'off'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Play region */}
        <div
          ref={containerRef}
          className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-black"
        >
          {videoObjectUrl ? (
            <>
              <video
                ref={videoRef}
                data-testid="video"
                src={videoObjectUrl}
                className="h-full w-full object-contain"
                playsInline
                onClick={togglePlay}
                muted={muted}
                onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration)
                  const resume = project.media.resumeAtMs
                  if (resume && resume > 0 && resume < e.currentTarget.duration * 1000) {
                    e.currentTarget.currentTime = resume / 1000
                  }
                }}
                onPlay={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
                onPause={() => {
                  const v = videoRef.current
                  if (v) void savePosition(v.currentTime * 1000)
                }}
                onEnded={() => {
                  const v = videoRef.current
                  if (v) void savePosition(v.currentTime * 1000)
                }}
              />
              {captionsVisible && activeTrack && activeTrack.cues.length > 0 && (
                <SubtitleOverlay
                  video={videoRef}
                  cues={activeTrack.cues}
                  syncOffsetMs={offsetMs}
                  style={project.settings.style}
                  draft={activeTrack.draft}
                  className="subtitle-overlay"
                />
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <p className="text-sm text-zinc-400">
                The original file isn&apos;t available in this browser session.
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className={ICON_BTN}
                  onClick={() => {
                    if (hasFileSystemAccess()) void pickVideo()
                    else fileInputRef.current?.click()
                  }}
                >
                  Choose the file…
                </button>
                <button
                  type="button"
                  className={ICON_BTN}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Browse
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,.mp4,.m4v,.webm,.mov,.mkv,.ogv,.ogm"
                  className="hidden"
                  onChange={(e) => {
                    onFilePicked(e.target.files?.[0] ?? null)
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Side panel */}
        <aside className="flex w-72 shrink-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="mb-3 flex gap-1">
            {(['tracks', 'style'] as const).map((name) => (
              <button
                key={name}
                type="button"
                className={`flex-1 rounded-md px-2 py-1 text-xs capitalize transition ${
                  panel === name ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
                onClick={() => setPanel(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === 'tracks' ? <TracksPanel /> : <StylePanel />}
          </div>
        </aside>
      </div>

      {/* Transport */}
      <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2">
        <button
          type="button"
          data-testid="transport-play"
          className={ICON_BTN}
          onClick={togglePlay}
        >
          {videoRef.current && !videoRef.current.paused ? '❚❚' : '▶'}
        </button>
        <input
          type="range"
          aria-label="Seek"
          data-testid="seek"
          className="min-w-0 flex-1 accent-zinc-300"
          min={0}
          max={duration || 0}
          step={0.01}
          value={currentTime}
          onChange={(e) => seekTo(Number(e.target.value))}
        />
        <span className="w-20 text-right text-xs tabular-nums text-zinc-400">
          {fmtTime(currentTime)} / {fmtTime(duration)}
        </span>
        <select
          aria-label="Playback speed"
          data-testid="rate"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200"
          value={rate}
          onChange={(e) => {
            const r = Number(e.target.value)
            setRate(r)
            if (videoRef.current) videoRef.current.playbackRate = r
          }}
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Mute"
          data-testid="mute"
          className={ICON_BTN}
          onClick={() => setMuted((m) => !m)}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button
          type="button"
          aria-label="Picture in picture"
          className={ICON_BTN}
          onClick={togglePiP}
        >
          ⧉
        </button>
        <button
          type="button"
          aria-label="Fullscreen"
          data-testid="fullscreen"
          className={ICON_BTN}
          onClick={toggleFullscreen}
        >
          ⛶
        </button>
      </div>
    </main>
  )
}
