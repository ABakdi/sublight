import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type { SubtitleTrack } from '@sublight/core'
import {
  actionFor,
  isTyping,
  nextSpeed,
  SHORTCUTS,
  SPEEDS,
  TAP_MS,
  tapStreak,
  type PlayerAction,
} from '../lib/shortcuts'
import {
  BackIcon,
  ForwardIcon,
  FullscreenIcon,
  HelpIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  VolumeIcon,
} from './icons'

/**
 * Everything on the video (M06b.11): YouTube's gestures (click to play,
 * double-click a side to seek 10 s and keep tapping for more, hold the right
 * half for 2×, double-click the middle for fullscreen, wheel for volume), a
 * control bar that hides itself while playing, VLC's keyboard, and the
 * shortcut sheet. Lives inside the fullscreen container, so all of it works
 * in fullscreen too.
 */

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(Math.floor(s % 60)).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const read = (key: string, fallback: number) => {
  try {
    const v = Number(localStorage.getItem(key))
    return localStorage.getItem(key) !== null && Number.isFinite(v) ? v : fallback
  } catch {
    return fallback
  }
}
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage blocked: this session only
  }
}

/** What the captions part of the Player lets the stage do (PlayerView owns the project). */
export interface CaptionControls {
  visible: boolean
  toggle(): void
  tracks: SubtitleTrack[]
  activeTrackId: string | null
  setActive(id: string): void
  nextTrack(): void
  /** null when the active track has no source to show with it. */
  bilingual: boolean | null
  toggleBilingual(): void
  delayMs: number
  nudge(ms: number): void
  mode: 'words' | 'sentences'
  toggleMode(): void
  jumpCue(dir: 1 | -1): void
  /** Cue starts, seconds, for the seek bar's markers. */
  markers: number[]
}

interface Flash {
  id: number
  text: string
  where: 'center' | 'left' | 'right' | 'top'
}

const BAR_BTN =
  'flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-sm text-white/90 transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70'

export function VideoStage(props: {
  videoRef: RefObject<HTMLVideoElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  /** Same-origin or media URL for the seek bar's frame preview (not for HLS/DASH). */
  previewSrc: string | null
  title: string
  captions: CaptionControls
  /** Resume position the video opened at, ms (a "Start over" offer). */
  resumedAtMs: number | null
  /** The queue of videos (M06b.11): false when there is nothing to move to. */
  queue: (dir: 1 | -1) => boolean
  children: ReactNode
}) {
  const { videoRef, containerRef, captions, title, queue } = props
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState<[number, number][]>([])
  const [volume, setVolume] = useState(() => Math.min(1, Math.max(0, read('sublight.volume', 1))))
  const [muted, setMuted] = useState(() => read('sublight.muted', 0) === 1)
  const [rate, setRate] = useState(() => read('sublight.rate', 1))
  const [remaining, setRemaining] = useState(false)
  const [controls, setControls] = useState(true)
  const [flashes, setFlashes] = useState<Flash[]>([])
  const [help, setHelp] = useState(false)
  const [menu, setMenu] = useState<'captions' | null>(null)
  const [loop, setLoop] = useState<{ a: number; b: number | null } | null>(null)
  const [held, setHeld] = useState(false)
  const [resumeOffer, setResumeOffer] = useState<number | null>(props.resumedAtMs)

  // --- the video element ------------------------------------------------------

  // Remembered volume and speed apply to every video.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = muted
  }, [videoRef, volume, muted])
  useEffect(() => {
    const v = videoRef.current
    if (v && !held) v.playbackRate = rate
  }, [videoRef, rate, held])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const sync = () => {
      setPlaying(!v.paused && !v.ended)
      setTime(v.currentTime)
      setDuration(Number.isFinite(v.duration) ? v.duration : 0)
      const ranges: [number, number][] = []
      for (let i = 0; i < v.buffered.length; i++)
        ranges.push([v.buffered.start(i), v.buffered.end(i)])
      setBuffered(ranges)
    }
    const events = [
      'play',
      'pause',
      'ended',
      'timeupdate',
      'durationchange',
      'loadedmetadata',
      'progress',
      'seeked',
    ]
    for (const e of events) v.addEventListener(e, sync)
    sync()
    return () => {
      for (const e of events) v.removeEventListener(e, sync)
    }
  }, [videoRef, props.previewSrc])

  // A–B loop.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !loop || loop.b === null) return
    const check = () => {
      if (v.currentTime >= loop.b!) v.currentTime = loop.a
    }
    v.addEventListener('timeupdate', check)
    return () => v.removeEventListener('timeupdate', check)
  }, [videoRef, loop])

  // --- flashes ----------------------------------------------------------------

  const flashId = useRef(0)
  const flash = useCallback((text: string, where: Flash['where'] = 'top', ms = 800) => {
    const id = ++flashId.current
    setFlashes((f) => [...f.filter((x) => x.where !== where), { id, text, where }])
    setTimeout(() => setFlashes((f) => f.filter((x) => x.id !== id)), ms)
  }, [])

  // --- actions (keyboard, gestures, buttons) ------------------------------------

  const seekTo = useCallback(
    (s: number) => {
      const v = videoRef.current
      if (!v || !Number.isFinite(s)) return
      const max = Number.isFinite(v.duration) ? v.duration : s
      v.currentTime = Math.min(Math.max(0, s), max)
    },
    [videoRef],
  )
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
    flash(v.paused ? '❚❚' : '▶', 'center', 500)
  }, [videoRef, flash])
  const setVol = useCallback(
    (value: number) => {
      const next = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
      setVolume(next)
      setMuted(next === 0)
      write('sublight.volume', String(next))
      write('sublight.muted', next === 0 ? '1' : '0')
      flash(`Volume ${Math.round(next * 100)} %`)
    },
    [flash],
  )
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      write('sublight.muted', m ? '0' : '1')
      flash(m ? `Volume ${Math.round(volume * 100)} %` : 'Muted')
      return !m
    })
  }, [flash, volume])
  const setSpeed = useCallback(
    (r: number) => {
      setRate(r)
      write('sublight.rate', String(r))
      flash(`${r}×`)
    },
    [flash],
  )
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }, [containerRef])
  const togglePiP = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture()
    else void v.requestPictureInPicture?.().catch(() => flash('Picture in picture isn’t available'))
  }, [videoRef, flash])

  const screenshot = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      canvas.getContext('2d')!.drawImage(v, 0, 0)
      canvas.toBlob((blob) => {
        if (!blob) return
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${title || 'sublight'} ${fmtTime(v.currentTime).replace(/:/g, '-')}.png`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
        flash('Screenshot saved')
      }, 'image/png')
    } catch {
      // Another site's video without CORS: the browser won't let a page read its pixels.
      flash('This video’s site doesn’t allow screenshots')
    }
  }, [videoRef, title, flash])

  const perform = useCallback(
    (a: PlayerAction) => {
      const v = videoRef.current
      switch (a.type) {
        case 'togglePlay':
          return togglePlay()
        case 'seekBy':
          if (v) {
            seekTo(v.currentTime + a.seconds)
            flash(
              `${a.seconds > 0 ? '+' : '−'}${Math.abs(a.seconds)} s`,
              a.seconds > 0 ? 'right' : 'left',
            )
          }
          return
        case 'seekToFraction':
          if (v && Number.isFinite(v.duration)) seekTo(v.duration * a.fraction)
          return
        case 'seekToEnd':
          if (v) seekTo(a.end === 'start' ? 0 : v.duration)
          return
        case 'frameStep':
          if (v && v.paused) seekTo(v.currentTime + a.frames / 30)
          else flash('Pause to step frame by frame')
          return
        case 'volumeBy':
          return setVol((muted ? 0 : volume) + a.delta)
        case 'toggleMute':
          return toggleMute()
        case 'speed':
          return setSpeed(nextSpeed(rate, a.change))
        case 'toggleFullscreen':
          return toggleFullscreen()
        case 'togglePiP':
          return togglePiP()
        case 'toggleCaptions':
          captions.toggle()
          return flash(captions.visible ? 'Captions off' : 'Captions on')
        case 'nextTrack':
          return captions.nextTrack()
        case 'toggleBilingual':
          if (captions.bilingual === null)
            return flash('This track has no original to show with it')
          captions.toggleBilingual()
          return flash(captions.bilingual ? 'Translation only' : 'Original and translation')
        case 'captionDelay': {
          captions.nudge(a.ms)
          const next = captions.delayMs + a.ms
          return flash(`Captions ${next === 0 ? 'in sync' : `${next > 0 ? '+' : ''}${next} ms`}`)
        }
        case 'jumpCue':
          return captions.jumpCue(a.dir)
        case 'loopPoint':
          if (!v) return
          if (!loop) {
            setLoop({ a: v.currentTime, b: null })
            return flash(`Loop from ${fmtTime(v.currentTime)}: press A again to end it`)
          }
          if (loop.b === null && v.currentTime > loop.a) {
            setLoop({ a: loop.a, b: v.currentTime })
            v.currentTime = loop.a
            return flash(`Looping ${fmtTime(loop.a)}–${fmtTime(v.currentTime)}`)
          }
          setLoop(null)
          return flash('Loop off')
        case 'screenshot':
          return screenshot()
        case 'queue':
          if (!queue(a.dir)) flash(a.dir > 0 ? 'No next video in the queue' : 'No previous video')
          return
        case 'help':
          return setHelp((h) => !h)
      }
    },
    [
      togglePlay,
      seekTo,
      flash,
      setVol,
      muted,
      volume,
      toggleMute,
      setSpeed,
      rate,
      toggleFullscreen,
      togglePiP,
      captions,
      loop,
      screenshot,
      queue,
      videoRef,
    ],
  )

  // --- the control bar hides itself while playing ----------------------------------

  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const overBar = useRef(false)
  const wake = useCallback(() => {
    setControls(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!overBar.current) setControls(false)
    }, 2500)
  }, [])
  useEffect(() => {
    if (!playing) {
      clearTimeout(hideTimer.current)
      setControls(true)
    } else wake()
  }, [playing, wake])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.key === 'Escape') {
        setHelp(false)
        setMenu(null)
        return
      }
      // A focused button already answers Space itself.
      if (e.key === ' ' && (e.target as HTMLElement | null)?.tagName === 'BUTTON') return
      const a = actionFor(e)
      if (!a) return
      e.preventDefault()
      perform(a)
      wake()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [perform, wake])

  // --- gestures ---------------------------------------------------------------------

  const lastClick = useRef<{ zone: 'left' | 'middle' | 'right'; at: number } | null>(null)
  const pendingToggle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const streak = useRef<{ side: 'left' | 'right'; at: number; total: number } | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const holding = useRef(false)

  const zoneOf = (e: { clientX: number; currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    return x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'middle'
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const r = e.currentTarget.getBoundingClientRect()
    if (e.clientX - r.left < r.width / 2) return
    // Hold the right half: 2× while held (YouTube).
    holdTimer.current = setTimeout(() => {
      const v = videoRef.current
      if (!v || v.paused) return
      holding.current = true
      setHeld(true)
      v.playbackRate = 2
    }, 500)
  }
  const endHold = () => {
    clearTimeout(holdTimer.current)
    if (!holding.current) return
    setHeld(false)
    const v = videoRef.current
    if (v) v.playbackRate = rate
  }

  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (holding.current) {
      holding.current = false // the end of a hold, not a click
      return
    }
    setMenu(null)
    const zone = zoneOf(e)
    const now = performance.now()
    const prev = lastClick.current
    lastClick.current = { zone, at: now }
    // Further taps on the same side keep seeking: −10, −20, −30…
    const s = streak.current
    if (zone !== 'middle' && s && s.side === zone && now - s.at <= TAP_MS) {
      streak.current = tapStreak(s, zone, now)
      seekTo((videoRef.current?.currentTime ?? 0) + (zone === 'left' ? -10 : 10))
      flash(`${streak.current.total > 0 ? '+' : '−'}${Math.abs(streak.current.total)} s`, zone, 700)
      return
    }
    if (prev && prev.zone === zone && now - prev.at <= 300) {
      clearTimeout(pendingToggle.current)
      if (zone === 'middle') {
        toggleFullscreen()
        return
      }
      streak.current = tapStreak(null, zone, now)
      seekTo((videoRef.current?.currentTime ?? 0) + (zone === 'left' ? -10 : 10))
      flash(`${zone === 'left' ? '−' : '+'}10 s`, zone, 700)
      return
    }
    // A single click plays or pauses, once it's clear no second click follows.
    clearTimeout(pendingToggle.current)
    pendingToggle.current = setTimeout(togglePlay, 250)
  }

  // --- seek bar -------------------------------------------------------------------

  const barRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLVideoElement>(null)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const timeAt = useCallback(
    (clientX: number) => {
      const r = barRef.current!.getBoundingClientRect()
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration
    },
    [duration],
  )
  useEffect(() => {
    const p = previewRef.current
    if (p && hover && Number.isFinite(hover.t)) p.currentTime = hover.t
  }, [hover])
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => seekTo(timeAt(e.clientX))
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, seekTo, timeAt])

  const pct = (s: number) => (duration > 0 ? `${(s / duration) * 100}%` : '0%')
  const shownVolume = muted ? 0 : volume

  return (
    <div
      className="absolute inset-0 select-none"
      data-testid="video-stage"
      data-controls={controls ? 'shown' : 'hidden'}
      onMouseMove={wake}
      style={{ cursor: controls || !playing ? 'default' : 'none' }}
    >
      {props.children}

      {/* Gestures over the video (captions stay visible above it). */}
      <div
        data-testid="gesture-layer"
        className="absolute inset-0"
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onWheel={(e) => setVol(shownVolume + (e.deltaY < 0 ? 0.05 : -0.05))}
      />

      {/* Flashes: play/pause, seek ripples, volume, speed… */}
      {flashes.map((f) => (
        <div
          key={f.id}
          data-testid={`flash-${f.where}`}
          className={`pointer-events-none absolute flex items-center justify-center rounded-full bg-black/55 font-semibold text-white ${
            f.where === 'center'
              ? 'left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 animate-ping-once text-2xl'
              : f.where === 'left'
                ? 'left-[12%] top-1/2 -translate-y-1/2 px-5 py-3 text-lg'
                : f.where === 'right'
                  ? 'right-[12%] top-1/2 -translate-y-1/2 px-5 py-3 text-lg'
                  : 'left-1/2 top-4 -translate-x-1/2 px-4 py-1.5 text-sm'
          }`}
        >
          {f.text}
        </div>
      ))}
      {held && (
        <div
          data-testid="hold-speed"
          className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 text-sm font-semibold text-white"
        >
          2× ▶▶
        </div>
      )}
      {resumeOffer !== null && resumeOffer > 5000 && (
        <div
          data-testid="resume-offer"
          className="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-black/65 px-3 py-1.5 text-xs text-white"
        >
          Resumed at {fmtTime(resumeOffer / 1000)}
          <button
            type="button"
            className="rounded bg-white/15 px-2 py-0.5 hover:bg-white/25"
            onClick={() => {
              seekTo(0)
              setResumeOffer(null)
            }}
          >
            Start over
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => setResumeOffer(null)}>
            ✕
          </button>
        </div>
      )}
      {loop && (
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded-lg bg-black/65 px-3 py-1.5 text-xs text-white">
          Loop {fmtTime(loop.a)}–{loop.b === null ? '…' : fmtTime(loop.b)}
          <button type="button" aria-label="Stop looping" onClick={() => setLoop(null)}>
            ✕
          </button>
        </div>
      )}

      {/* Control bar */}
      <div
        data-testid="control-bar"
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-2 pt-8 transition-opacity duration-300 ${
          controls ? 'opacity-100' : 'opacity-0'
        }`}
        onMouseEnter={() => (overBar.current = true)}
        onMouseLeave={() => (overBar.current = false)}
      >
        {/* Seek bar: buffered, played, caption markers, hover time and frame. */}
        <div
          ref={barRef}
          data-testid="seek"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${fmtTime(time)} of ${fmtTime(duration)}`}
          tabIndex={0}
          className="group/seek relative h-4 cursor-pointer"
          onPointerDown={(e) => {
            seekTo(timeAt(e.clientX))
            setDragging(true)
          }}
          onPointerMove={(e) =>
            setHover({
              x: e.clientX - barRef.current!.getBoundingClientRect().left,
              t: timeAt(e.clientX),
            })
          }
          onPointerLeave={() => setHover(null)}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-white/25 transition-all group-hover/seek:h-1.5">
            {buffered.map(([a, b]) => (
              <div
                key={a}
                className="absolute inset-y-0 rounded bg-white/35"
                style={{ left: pct(a), width: pct(b - a) }}
              />
            ))}
            <div
              className="absolute inset-y-0 left-0 rounded bg-indigo-500"
              style={{ width: pct(time) }}
            />
            {captions.markers.slice(0, 600).map((m, i) => (
              <div
                key={i}
                className="absolute inset-y-0 w-px bg-white/30"
                style={{ left: pct(m) }}
              />
            ))}
          </div>
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-400 opacity-0 transition group-hover/seek:opacity-100"
            style={{ left: pct(time) }}
          />
          {hover && duration > 0 && (
            <div
              data-testid="seek-hover"
              className="pointer-events-none absolute bottom-5 flex -translate-x-1/2 flex-col items-center gap-1"
              style={{
                left: Math.min(Math.max(hover.x, 80), (barRef.current?.clientWidth ?? 0) - 80),
              }}
            >
              {props.previewSrc && (
                <video
                  ref={previewRef}
                  src={props.previewSrc}
                  muted
                  preload="metadata"
                  className="h-[90px] w-[160px] rounded border border-white/30 bg-black object-contain"
                />
              )}
              <span className="rounded bg-black/80 px-1.5 py-0.5 text-xs tabular-nums text-white">
                {fmtTime(hover.t)}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 text-white">
          <button
            type="button"
            data-testid="transport-play"
            aria-label={playing ? 'Pause' : 'Play'}
            className={BAR_BTN}
            onClick={togglePlay}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            aria-label="Back 10 s"
            className={BAR_BTN}
            onClick={() => perform({ type: 'seekBy', seconds: -10 })}
          >
            <BackIcon />
          </button>
          <button
            type="button"
            aria-label="Forward 10 s"
            className={BAR_BTN}
            onClick={() => perform({ type: 'seekBy', seconds: 10 })}
          >
            <ForwardIcon />
          </button>
          <button
            type="button"
            data-testid="mute"
            aria-label={muted ? 'Unmute' : 'Mute'}
            className={BAR_BTN}
            onClick={toggleMute}
          >
            <VolumeIcon level={shownVolume} />
          </button>
          <input
            type="range"
            aria-label="Volume"
            data-testid="volume"
            min={0}
            max={1}
            step={0.05}
            value={shownVolume}
            onChange={(e) => setVol(Number(e.target.value))}
            className="w-20 accent-white"
          />
          <button
            type="button"
            data-testid="time"
            className={`${BAR_BTN} tabular-nums text-xs`}
            title="Elapsed or remaining time"
            onClick={() => setRemaining((r) => !r)}
          >
            {remaining ? `−${fmtTime(duration - time)}` : fmtTime(time)} / {fmtTime(duration)}
          </button>

          <div className="ml-auto flex items-center gap-1">
            <select
              aria-label="Playback speed"
              data-testid="rate"
              className="rounded-md bg-transparent px-1 py-1 text-xs text-white hover:bg-white/15"
              value={rate}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              {SPEEDS.map((r) => (
                <option key={r} value={r} className="text-black">
                  {r}×
                </option>
              ))}
            </select>
            <div className="relative">
              <button
                type="button"
                data-testid="captions-menu"
                aria-label="Captions"
                aria-expanded={menu === 'captions'}
                className={`${BAR_BTN} text-xs font-bold ${captions.visible ? '' : 'opacity-50'}`}
                onClick={() => setMenu((m) => (m === 'captions' ? null : 'captions'))}
              >
                CC
              </button>
              {menu === 'captions' && <CaptionsMenu captions={captions} />}
            </div>
            <button
              type="button"
              aria-label="Picture in picture"
              className={BAR_BTN}
              onClick={togglePiP}
            >
              <PipIcon />
            </button>
            <button
              type="button"
              aria-label="Keyboard shortcuts"
              className={BAR_BTN}
              onClick={() => setHelp(true)}
            >
              <HelpIcon />
            </button>
            <button
              type="button"
              data-testid="fullscreen"
              aria-label="Fullscreen"
              className={BAR_BTN}
              onClick={toggleFullscreen}
            >
              <FullscreenIcon />
            </button>
          </div>
        </div>
      </div>

      {help && <ShortcutSheet onClose={() => setHelp(false)} />}
    </div>
  )
}

function CaptionsMenu({ captions }: { captions: CaptionControls }) {
  const row = 'flex items-center justify-between gap-3 px-3 py-1.5 text-xs'
  return (
    <div
      data-testid="captions-menu-panel"
      className="absolute bottom-10 right-0 z-10 w-64 rounded-lg border border-white/15 bg-zinc-950/95 py-1.5 text-white shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <label className={row}>
        Show captions
        <input type="checkbox" checked={captions.visible} onChange={captions.toggle} />
      </label>
      {captions.tracks.length > 0 && (
        <div className="border-t border-white/10 py-1">
          {captions.tracks.map((t) => (
            <label key={t.id} className={`${row} cursor-pointer hover:bg-white/10`}>
              <span className="truncate">{t.title ?? t.language}</span>
              <input
                type="radio"
                name="caption-track"
                checked={captions.activeTrackId === t.id}
                onChange={() => captions.setActive(t.id)}
              />
            </label>
          ))}
        </div>
      )}
      {captions.bilingual !== null && (
        <label className={`${row} border-t border-white/10`}>
          Original with the translation
          <input type="checkbox" checked={captions.bilingual} onChange={captions.toggleBilingual} />
        </label>
      )}
      <div className={`${row} border-t border-white/10`}>
        Show
        <button
          type="button"
          className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
          onClick={captions.toggleMode}
        >
          {captions.mode === 'words' ? 'Word by word' : 'Sentences'}
        </button>
      </div>
      <div className={row}>
        Delay
        <span className="flex items-center gap-1 tabular-nums">
          <button
            type="button"
            className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
            onClick={() => captions.nudge(-50)}
          >
            −
          </button>
          {captions.delayMs} ms
          <button
            type="button"
            className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
            onClick={() => captions.nudge(50)}
          >
            +
          </button>
        </span>
      </div>
    </div>
  )
}

/** The shortcut sheet (?): generated from the live keymap. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))]
  return (
    <div
      data-testid="shortcut-sheet"
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-2xl overflow-y-auto rounded-xl bg-zinc-900 p-5 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            className="text-zinc-400 hover:text-zinc-100"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {groups.map((g) => (
            <section key={g}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {g}
              </h3>
              {SHORTCUTS.filter((s) => s.group === g && s.keys.length > 0).map((s) => (
                <div
                  key={s.label}
                  className="flex items-center justify-between gap-3 py-0.5 text-sm"
                >
                  <span className="text-zinc-300">{s.label}</span>
                  <span className="flex gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-zinc-700 bg-zinc-800 px-1.5 text-xs"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              With the mouse
            </h3>
            {[
              ['Click', 'Play / pause'],
              ['Double-click left / right', 'Back / forward 10 s, more with each tap'],
              ['Hold the right half', '2× while held'],
              ['Double-click the middle', 'Fullscreen'],
              ['Wheel', 'Volume'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 py-0.5 text-sm">
                <span className="text-zinc-300">{v}</span>
                <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 text-xs">{k}</kbd>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
