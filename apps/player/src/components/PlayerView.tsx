import { useCallback, useEffect, useRef, useState } from 'react'
import { SubtitleOverlay } from '@sublight/overlay'
import { cuesForMode, type CaptionMode } from '@sublight/core'
import { activeTrackOf, usePlayerStore } from '../store/player'
import { hasFileSystemAccess } from '../lib/fileOpen'
import { attachStream } from '../lib/streaming'
import { ModelsPanel } from './ModelsPanel'
import { TracksPanel } from './TracksPanel'
import { StylePanel } from './StylePanel'
import { CaptionPanel } from './CaptionPanel'
import { useCaptionStore } from '../store/caption'
import { VideoStage, type CaptionControls } from './VideoStage'

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
  const preparing = usePlayerStore((s) => s.preparing)
  const playbackFailed = usePlayerStore((s) => s.playbackFailed)
  const stream = usePlayerStore((s) => s.stream)
  const pageError = usePlayerStore((s) => s.pageError)
  const retryPageVideo = usePlayerStore((s) => s.retryPageVideo)
  const setActiveTrack = usePlayerStore((s) => s.setActiveTrack)
  const setBilingual = usePlayerStore((s) => s.setBilingual)
  const queueMove = usePlayerStore((s) => s.queueMove)

  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // HLS/DASH from a page (M05b.4): hls.js / dash.js drive the <video>; if the
  // stream can't be played here, the engine fetches it instead.
  useEffect(() => {
    const video = videoRef.current
    if (!stream || !video) return
    const ctl = new AbortController()
    let detach: (() => void) | null = null
    void attachStream(
      video,
      stream.url,
      stream.kind,
      () => {
        if (!ctl.signal.aborted) void playbackFailed()
      },
      ctl.signal,
    ).then((d) => {
      if (ctl.signal.aborted) d()
      else detach = d
    })
    return () => {
      ctl.abort()
      detach?.()
    }
  }, [stream, playbackFailed])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [captionsVisible, setCaptionsVisible] = useState(true)
  // Word by word (default): each caption fills in as its words are spoken;
  // sentences: one full sentence per caption.
  const [captionMode, setCaptionMode] = useState<CaptionMode>(() => {
    try {
      return localStorage.getItem('sublight.captionMode') === 'sentences' ? 'sentences' : 'words'
    } catch {
      return 'words'
    }
  })
  const toggleCaptionMode = useCallback(() => {
    setCaptionMode((mode) => {
      const next = mode === 'words' ? 'sentences' : 'words'
      try {
        localStorage.setItem('sublight.captionMode', next)
      } catch {
        // storage blocked: session-only
      }
      return next
    })
  }, [])
  const [panel, setPanel] = useState<'tracks' | 'caption' | 'style' | 'models'>('tracks')
  // The side drawer (M06b.10): video first, panels when wanted; remembered.
  const [drawer, setDrawer] = useState(() => {
    try {
      return localStorage.getItem('sublight.drawer') !== 'closed'
    } catch {
      return true
    }
  })
  const toggleDrawer = useCallback(() => {
    setDrawer((open) => {
      try {
        localStorage.setItem('sublight.drawer', open ? 'closed' : 'open')
      } catch {
        // storage blocked: this session only
      }
      return !open
    })
  }, [])
  const draft = useCaptionStore((s) => s.draft)
  const resetCaption = useCaptionStore((s) => s.reset)
  const projectId = project?.id

  // A caption run belongs to the project it started in.
  useEffect(() => () => resetCaption(), [projectId, resetCaption])

  const activeTrack = project ? activeTrackOf(project) : null
  // While captioning, the progressive draft is what's worth watching.
  const shownTrack = draft ?? activeTrack
  // Bilingual (Spec 05 §7): the source track dimmed above the translation.
  const pair = project?.settings.bilingual
  const secondaryTrack =
    !draft && pair && pair.translationTrackId === shownTrack?.id
      ? project?.tracks.find((t) => t.id === pair.sourceTrackId)
      : undefined

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

  // Position persistence: save on pause/seek and every 5 s while playing.
  useEffect(() => {
    const timer = setInterval(() => {
      const v = videoRef.current
      if (v && !v.paused) void savePosition(v.currentTime * 1000)
    }, 5000)
    return () => clearInterval(timer)
  }, [savePosition])

  const onFilePicked = useCallback(
    (file: File | null) => {
      if (file) void attachFile(file)
    },
    [attachFile],
  )

  if (!project) return null

  const offsetMs = activeTrack?.syncOffsetMs ?? 0
  const shownOffsetMs = shownTrack?.syncOffsetMs ?? 0

  // What the video's controls may do with the captions (M06b.11).
  const sourceId = activeTrack?.derivedFrom?.trackId
  const hasSource = !!sourceId && project.tracks.some((t) => t.id === sourceId)
  const captionControls: CaptionControls = {
    visible: captionsVisible,
    toggle: () => setCaptionsVisible((v) => !v),
    tracks: project.tracks,
    activeTrackId: activeTrack?.id ?? null,
    setActive: (id) => void setActiveTrack(id),
    nextTrack: () => {
      const tracks = project.tracks
      if (tracks.length === 0) return
      const i = tracks.findIndex((t) => t.id === activeTrack?.id)
      void setActiveTrack(tracks[(i + 1) % tracks.length]!.id)
    },
    bilingual: hasSource ? !!pair && pair.translationTrackId === activeTrack?.id : null,
    toggleBilingual: () => {
      if (!activeTrack || !sourceId) return
      const on = !!pair && pair.translationTrackId === activeTrack.id
      void setBilingual(on ? null : { sourceTrackId: sourceId, translationTrackId: activeTrack.id })
    },
    delayMs: offsetMs,
    nudge: (ms) => void nudgeActiveTrack(ms),
    mode: captionMode,
    toggleMode: toggleCaptionMode,
    jumpCue,
    markers: (activeTrack?.cues ?? []).map((c) => c.startMs / 1000),
  }

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
          <button
            type="button"
            data-testid="toggle-drawer"
            aria-expanded={drawer}
            className={`${ICON_BTN} ${drawer ? 'border-zinc-400 text-zinc-100' : ''}`}
            title="Show or hide the tracks, captioning, style and models panels"
            onClick={toggleDrawer}
          >
            Panels
          </button>
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
            data-testid="toggle-caption-mode"
            data-mode={captionMode}
            className={`${ICON_BTN} border-zinc-400 text-zinc-100`}
            title="Switch between captions that fill in word by word and whole sentences"
            onClick={toggleCaptionMode}
          >
            {captionMode === 'words' ? 'Word by word' : 'Sentences'}
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
          // The picture and its controls stay dark in the light theme too.
          data-theme="dark"
          className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-black"
        >
          {videoObjectUrl || stream ? (
            <VideoStage
              key={project.id}
              videoRef={videoRef}
              containerRef={containerRef}
              previewSrc={stream ? null : videoObjectUrl}
              title={project.title}
              captions={captionControls}
              resumedAtMs={project.media.resumeAtMs ?? null}
              queue={queueMove}
            >
              <video
                ref={videoRef}
                data-testid="video"
                src={videoObjectUrl ?? undefined}
                className="h-full w-full object-contain"
                playsInline
                onLoadedMetadata={(e) => {
                  const resume = project.media.resumeAtMs
                  if (resume && resume > 0 && resume < e.currentTarget.duration * 1000) {
                    e.currentTarget.currentTime = resume / 1000
                  }
                }}
                // A page's own URL can refuse to play here (hotlink checks): use the engine.
                onError={() => void playbackFailed()}
                onPause={() => {
                  const v = videoRef.current
                  if (v) void savePosition(v.currentTime * 1000)
                }}
                onEnded={() => {
                  const v = videoRef.current
                  if (v) void savePosition(v.currentTime * 1000)
                  // The queue plays the next video (M06b.11).
                  queueMove(1)
                }}
              />
              {captionsVisible && shownTrack && shownTrack.cues.length > 0 && (
                <SubtitleOverlay
                  video={videoRef}
                  cues={cuesForMode(shownTrack.cues, captionMode)}
                  syncOffsetMs={shownOffsetMs}
                  secondaryCues={secondaryTrack?.cues}
                  secondarySyncOffsetMs={secondaryTrack?.syncOffsetMs ?? 0}
                  style={project.settings.style}
                  draft={shownTrack.draft}
                  className="subtitle-overlay"
                />
              )}
            </VideoStage>
          ) : project.media.kind === 'page-video' ? (
            <div
              data-testid="page-video-status"
              className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
            >
              {preparing ? (
                <>
                  <p className="text-sm text-zinc-300">
                    {preparing.progress > 0
                      ? `Preparing media… ${Math.round(preparing.progress * 100)} %`
                      : 'Getting the video from its page…'}
                  </p>
                  <div className="h-1.5 w-64 overflow-hidden rounded bg-zinc-800">
                    <div
                      className="h-full bg-indigo-500 transition-all"
                      style={{ width: `${Math.round(preparing.progress * 100)}%` }}
                    />
                  </div>
                </>
              ) : pageError ? (
                <>
                  <p
                    data-testid="page-video-error"
                    data-code={pageError.code}
                    className="max-w-md text-sm text-zinc-300"
                  >
                    {pageError.message}
                  </p>
                  {pageError.captionOnPage && (
                    <p className="max-w-md text-xs text-zinc-500">
                      On its page: sublight’s popup → Caption this video.
                    </p>
                  )}
                  {pageError.code !== 'MEDIA_PROTECTED' && (
                    <button
                      type="button"
                      className={ICON_BTN}
                      onClick={() => void retryPageVideo()}
                    >
                      Try again
                    </button>
                  )}
                </>
              ) : (
                <p className="text-sm text-zinc-400">Opening the video…</p>
              )}
              {project.media.pageUrl && (
                <a
                  className="text-xs text-indigo-300 underline"
                  href={project.media.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open its page
                </a>
              )}
            </div>
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
        {drawer && (
          <aside
            data-testid="drawer"
            className="flex w-72 shrink-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"
          >
            <div className="mb-3 flex gap-1">
              {(['tracks', 'caption', 'style', 'models'] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  data-testid={`panel-${name}`}
                  className={`flex-1 rounded-md px-2 py-1 text-xs capitalize transition ${
                    panel === name
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  onClick={() => setPanel(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panel === 'tracks' ? (
                <TracksPanel />
              ) : panel === 'caption' ? (
                <CaptionPanel />
              ) : panel === 'models' ? (
                <ModelsPanel />
              ) : (
                <StylePanel />
              )}
            </div>
          </aside>
        )}
      </div>
    </main>
  )
}
