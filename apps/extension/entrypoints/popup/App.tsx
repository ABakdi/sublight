import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { serializeSrt, type CaptionMode } from '@sublight/core'
import { browser } from 'wxt/browser'
import { BUILD_ID } from '../../src/build'
import { HOLD_KEY } from '../../src/captionsContent'
import { EngineBadge } from '../../src/EngineBadge'
import { liveTrackKey, type SavedLiveTrack } from '../../src/liveController'
import type {
  CaptionsState,
  EngineStatus,
  LiveState,
  TabStatus,
  VideoState,
} from '../../src/messages'
import { modeOf, OVERLAY_STYLE_KEY, type QuickStyle } from '../../src/overlayFrame'
import { send } from '../../src/send'
import { button, card, clock, colors, label, primaryButton } from '../../src/ui'

const POLL_MS = 1000

/** Popup opened as a tab (tests, `pnpm ext:try`) targets `?tab=<id>` instead of itself. */
async function targetTabId(): Promise<number | null> {
  const fromQuery = Number(new URLSearchParams(location.search).get('tab'))
  if (Number.isInteger(fromQuery) && fromQuery > 0) return fromQuery
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

/** The frame whose video the popup talks about: a playing one, else the first with video. */
function primaryFrame(status: TabStatus | null): VideoState | null {
  const withVideo = status?.frames.filter((f) => f.primary) ?? []
  return withVideo.find((f) => f.primary!.isPlaying) ?? withVideo[0] ?? null
}

/** Extrapolate the playhead from the last report so the clock ticks without page messages. */
function playheadMs(frame: VideoState, now: number): number {
  const p = frame.primary!
  if (!p.isPlaying) return p.currentTimeMs
  const t = p.currentTimeMs + (now - frame.reportedAt) * p.playbackRate
  return p.durationMs === null ? t : Math.min(t, p.durationMs)
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const NO_ANSWER =
  'The extension’s background didn’t answer. Press “Reload sublight” above, or restart the browser.'
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Popup (Spec 09 §7): this tab's video, "Caption this video" (captions made
 * ahead of playback, exact timing, ADR-0020), how captions look, the SRT
 * download for the whole video, and live/test captions under "More".
 */
export function PopupApp() {
  const [tabId, setTabId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [tab, setTab] = useState<TabStatus | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)
  const [captions, setCaptions] = useState<CaptionsState | null>(null)
  /** The running service worker is an older build than this popup (not reloaded after an update). */
  const [stale, setStale] = useState(false)

  const refreshEngine = useCallback(() => {
    setEngine(null)
    send({ type: 'engine.status' }).then(setEngine, (e: unknown) =>
      setEngine({ state: 'offline', detail: String(e) }),
    )
  }, [])

  useEffect(() => {
    void targetTabId().then((id) => {
      setTabId(id)
      if (id !== null)
        void browser.tabs.get(id).then(
          (t) => setTitle(t.title ?? ''),
          () => {},
        )
    })
    refreshEngine()
    void browser.runtime.sendMessage({ type: 'ping' }).then(
      (r: unknown) => setStale((r as { build?: string } | undefined)?.build !== BUILD_ID),
      () => setStale(true),
    )
  }, [refreshEngine])

  useEffect(() => {
    if (tabId === null) return
    const poll = () => {
      setNow(Date.now())
      send({ type: 'tab.status', tabId }).then(setTab, () => setTab(null))
      send({ type: 'live.status', tabId }).then(setLive, () => setLive(null))
      send({ type: 'captions.status', tabId }).then(setCaptions, () => setCaptions(null))
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [tabId])

  const frame = primaryFrame(tab)
  const videoCount = tab?.frames.reduce((n, f) => n + f.videoCount, 0) ?? 0
  const demoOn = tab?.frames.some((f) => f.demoCaptions) ?? false
  const reported = (tab?.frames.length ?? 0) > 0
  const pageTitle = title || tab?.frames[0]?.title || frame?.title || ''
  const canCaption = !!frame && engine?.state === 'online'

  const run = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const captionsActive = captions?.phase === 'starting' || captions?.phase === 'captioning'
  const toggleCaptions = () =>
    run(async () => {
      if (tabId === null) return
      const state = await send({ type: captionsActive ? 'captions.stop' : 'captions.start', tabId })
      if (state === undefined) {
        setStale(true)
        throw new Error(NO_ANSWER)
      }
      setCaptions(state)
    })

  const liveActive = live?.phase === 'starting' || live?.phase === 'listening'
  const toggleLive = () =>
    run(async () => {
      if (tabId === null) return
      setLive(await send({ type: liveActive ? 'live.stop' : 'live.start', tabId }))
    })

  const toggleDemo = () =>
    run(async () => {
      if (tabId === null) return
      await send({ type: 'demo.toggle', tabId, on: !demoOn })
    })

  return (
    <main
      style={{
        width: 360,
        padding: 14,
        fontFamily: 'system-ui, sans-serif',
        color: colors.text,
        background: colors.surface,
        display: 'grid',
        gap: 10,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Logo />
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>sublight</h1>
        <button
          style={{ ...button, border: 'none', background: 'none', padding: 0, textAlign: 'right' }}
          onClick={refreshEngine}
          title="Check the engine again"
        >
          <EngineBadge status={engine} compact />
        </button>
      </header>

      {stale && (
        <section
          data-testid="stale-banner"
          style={{ ...card, borderColor: colors.warn, background: '#fffaeb' }}
        >
          <div style={{ fontSize: 12, lineHeight: 1.45 }}>
            sublight was updated, but the browser is still running the old version in the
            background, so new buttons won’t work until it reloads.
          </div>
          <button
            data-testid="reload-extension"
            style={primaryButton}
            onClick={() => browser.runtime.reload()}
          >
            Reload sublight
          </button>
          <div style={{ fontSize: 11, color: colors.muted }}>Then reload the video’s page too.</div>
        </section>
      )}

      <VideoCard
        reported={reported}
        frame={frame}
        videoCount={videoCount}
        title={pageTitle}
        now={now}
      />

      <CaptionsCard
        captions={captions}
        frame={frame}
        now={now}
        canCaption={canCaption}
        disabledReason={
          engine?.state !== 'online'
            ? 'Needs the engine: see the badge at the top.'
            : !frame
              ? 'No video found on this page (reload it if sublight was just installed).'
              : null
        }
        onToggle={() => void toggleCaptions()}
        onUseLive={() => void toggleLive()}
      />

      <DisplayCard />

      {tabId !== null && (
        <DownloadCard
          tabId={tabId}
          captions={captions}
          canCaption={canCaption}
          onState={setCaptions}
          onError={setError}
        />
      )}

      {error && (
        <div data-testid="popup-error" style={{ fontSize: 12, color: colors.bad }}>
          {error}
        </div>
      )}

      <details style={{ ...card, gap: 0 }} open={liveActive || demoOn || undefined}>
        <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>More</summary>
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <div style={label}>Live captions</div>
          <div style={{ fontSize: 11, color: colors.muted, lineHeight: 1.4 }}>
            For live streams and videos the engine can’t fetch: follows the sound as it plays, about
            3 s behind.
          </div>
          <button
            data-testid="live-toggle"
            style={canCaption ? button : { ...button, opacity: 0.5, cursor: 'default' }}
            disabled={!canCaption}
            onClick={() => void toggleLive()}
          >
            {liveActive ? 'Stop live captions' : 'Caption live'}
          </button>
          <LiveLine live={live} />
          {live?.notice && liveActive && (
            <div
              data-testid="live-notice"
              style={{ fontSize: 11, color: colors.warn, lineHeight: 1.4 }}
            >
              {live.notice}
            </div>
          )}
          {tabId !== null && live && live.phase !== 'starting' && <LiveDownload tabId={tabId} />}

          <div style={{ ...label, marginTop: 6 }}>Test captions</div>
          <button
            data-testid="demo-toggle"
            style={frame ? button : { ...button, opacity: 0.5, cursor: 'default' }}
            disabled={!frame}
            onClick={() => void toggleDemo()}
          >
            {demoOn ? 'Hide test captions' : 'Show test captions'}
          </button>
          <div style={{ fontSize: 11, color: colors.muted, lineHeight: 1.4 }}>
            Shows the video clock every 2.5 s, to check position and sync on this site.
          </div>
        </div>
      </details>

      <footer
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          color: colors.muted,
        }}
      >
        <button
          style={{
            ...button,
            border: 'none',
            padding: 0,
            background: 'none',
            color: colors.accent,
          }}
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          Options & pairing
        </button>
        <span>v{browser.runtime.getManifest().version}</span>
      </footer>
    </main>
  )
}

function Logo() {
  return (
    <span
      aria-hidden
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        background: colors.accent,
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontSize: 10,
        fontWeight: 800,
      }}
    >
      CC
    </span>
  )
}

function VideoCard(props: {
  reported: boolean
  frame: VideoState | null
  videoCount: number
  title: string
  now: number
}) {
  const { reported, frame, videoCount, title, now } = props
  let host = ''
  try {
    host = frame ? new URL(frame.url).hostname.replace(/^www\./, '') : ''
  } catch {
    // opaque URL
  }
  return (
    <section data-testid="video-status" data-videos={videoCount} style={card}>
      {!reported ? (
        <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.5 }}>
          sublight can’t see this page (browser pages and the Web Store are off-limits), or it is
          still loading. Reload the page if you just installed the extension.
        </div>
      ) : frame ? (
        <>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.35,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {title || 'Video'}
          </div>
          <div style={{ fontSize: 12, color: colors.muted }} data-testid="playhead">
            {frame.primary!.isPlaying ? 'Playing' : 'Paused'} · {clock(playheadMs(frame, now))}
            {frame.primary!.durationMs !== null
              ? ` / ${clock(frame.primary!.durationMs)}`
              : ' · live'}
            {host ? ` · ${host}` : ''}
            {videoCount > 1 ? ` · ${videoCount} videos` : ''}
            {frame.frame === 'iframe' ? ' · embedded' : ''}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: colors.muted }}>No video on this page.</div>
      )}
    </section>
  )
}

/** Captioned stretches over the video's length, with the playhead. */
function Timeline(props: {
  coverage: CaptionsState['coverage']
  durationMs: number
  playhead: number
}) {
  const { coverage, durationMs, playhead } = props
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / durationMs) * 100))
  return (
    <div
      data-testid="captions-timeline"
      title="Captioned parts of the video"
      style={{
        position: 'relative',
        height: 8,
        borderRadius: 4,
        background: colors.border,
        overflow: 'hidden',
      }}
    >
      {coverage.map((r) => (
        <div
          key={r.startMs}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${pct(r.startMs)}%`,
            width: `${pct(Math.min(r.endMs, durationMs)) - pct(r.startMs)}%`,
            background: colors.accent,
            opacity: 0.55,
          }}
        />
      ))}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${pct(playhead)}%`,
          width: 2,
          background: colors.text,
        }}
      />
    </div>
  )
}

function CaptionsCard(props: {
  captions: CaptionsState | null
  frame: VideoState | null
  now: number
  canCaption: boolean
  disabledReason: string | null
  onToggle: () => void
  onUseLive: () => void
}) {
  const { captions, frame, now, canCaption, disabledReason, onToggle, onUseLive } = props
  const [hold, setHold] = useState(true)
  useEffect(() => {
    void browser.storage.local.get(HOLD_KEY).then((got) => setHold(got[HOLD_KEY] !== false))
  }, [])
  const phase = captions?.phase
  const active = phase === 'starting' || phase === 'captioning'
  const durationMs = frame?.primary?.durationMs ?? null
  const playhead = frame ? playheadMs(frame, now) : 0
  const here = captions?.coverage.find((r) => r.startMs <= playhead + 50 && r.endMs > playhead)
  const percent = Math.round((captions?.progress ?? 0) * 100)

  let status: ReactNode =
    !canCaption && disabledReason
      ? disabledReason
      : 'Transcribes ahead of the playhead, so every caption shows at its exact moment.'
  if (phase === 'starting') status = `${cap(captions?.detail ?? 'starting')}…`
  else if (phase === 'captioning')
    status = here
      ? `Captioned up to ${clock(Math.min(here.endMs, durationMs ?? here.endMs))} · ${percent}% of the video`
      : `${cap(captions?.detail ?? 'captioning')}…`
  else if (phase === 'done') status = 'The whole video is captioned.'
  else if (phase === 'stopped') status = 'Stopped.'

  const big: CSSProperties = { padding: '9px 12px', fontSize: 13 }
  return (
    <section style={card} data-testid="captions-card">
      <button
        data-testid="captions-toggle"
        style={
          canCaption
            ? { ...(active ? button : primaryButton), ...big }
            : { ...primaryButton, ...big, opacity: 0.5, cursor: 'default' }
        }
        disabled={!canCaption}
        onClick={onToggle}
      >
        {active ? 'Stop captions' : 'Caption this video'}
      </button>
      {captions && durationMs !== null && (phase === 'captioning' || phase === 'done') && (
        <Timeline coverage={captions.coverage} durationMs={durationMs} playhead={playhead} />
      )}
      {phase === 'error' ? (
        <div
          data-testid="captions-error"
          style={{ fontSize: 12, color: colors.bad, lineHeight: 1.4 }}
        >
          {captions?.error}
          {captions?.suggestLive && (
            <button style={{ ...button, display: 'block', marginTop: 6 }} onClick={onUseLive}>
              Use live captions instead
            </button>
          )}
        </div>
      ) : (
        <div
          data-testid="captions-status"
          data-phase={phase ?? 'idle'}
          style={{ fontSize: 12, color: colors.muted, lineHeight: 1.4 }}
        >
          {status}
        </div>
      )}
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
        <input
          type="checkbox"
          data-testid="hold-playback"
          checked={hold}
          onChange={(e) => {
            setHold(e.target.checked)
            void browser.storage.local.set({ [HOLD_KEY]: e.target.checked })
          }}
        />
        Pause until captions are ready
      </label>
    </section>
  )
}

function Segmented<T extends string>(props: {
  options: [T, string][]
  value: T
  onChange: (v: T) => void
  testId: string
}) {
  return (
    <div
      role="radiogroup"
      data-testid={props.testId}
      style={{
        display: 'inline-flex',
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: '#fff',
      }}
    >
      {props.options.map(([value, text]) => {
        const on = value === props.value
        return (
          <button
            key={value}
            role="radio"
            aria-checked={on}
            data-testid={`${props.testId}-${value}`}
            style={{
              ...button,
              border: 'none',
              borderRadius: 0,
              padding: '4px 10px',
              whiteSpace: 'nowrap',
              background: on ? colors.accentSoft : '#fff',
              color: on ? colors.accent : colors.text,
              fontWeight: on ? 600 : 400,
            }}
            onClick={() => props.onChange(value)}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}

const MODES: [CaptionMode, string][] = [
  ['words', 'Word by word'],
  ['sentences', 'Sentences'],
]

const SIZES: [string, number][] = [
  ['S', 26],
  ['M', 34],
  ['L', 44],
]

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 12,
}

/** How captions look, applied live to every overlay (M05.7). */
function DisplayCard() {
  const [style, setStyle] = useState<QuickStyle>({})
  useEffect(() => {
    void browser.storage.local
      .get(OVERLAY_STYLE_KEY)
      .then((got) => setStyle((got[OVERLAY_STYLE_KEY] as QuickStyle | undefined) ?? {}))
  }, [])
  const update = (patch: QuickStyle) => {
    const next = { ...style, ...patch }
    setStyle(next)
    void browser.storage.local.set({ [OVERLAY_STYLE_KEY]: next })
  }
  const size = SIZES.find(([, px]) => px === (style.fontSize ?? 34))?.[0] ?? 'M'
  return (
    <section style={card} data-testid="quick-style">
      <div style={label}>Display</div>
      <div style={row}>
        <span>Show</span>
        <Segmented
          testId="display-mode"
          options={MODES}
          value={modeOf(style)}
          onChange={(mode) => update({ mode, reveal: undefined })}
        />
      </div>
      <div style={row}>
        <span>Size</span>
        <Segmented
          testId="size"
          options={SIZES.map(([l]) => [l, l])}
          value={size}
          onChange={(l) => update({ fontSize: SIZES.find(([x]) => x === l)![1] })}
        />
      </div>
      <div style={row}>
        <span>Position</span>
        <Segmented
          testId="anchor"
          options={[
            ['bottom', 'Bottom'],
            ['top', 'Top'],
          ]}
          value={style.anchor ?? 'bottom'}
          onChange={(anchor) => update({ anchor })}
        />
      </div>
    </section>
  )
}

/** SRT of the whole video, word by word or by sentence (transcribing it first if needed). */
function DownloadCard(props: {
  tabId: number
  captions: CaptionsState | null
  canCaption: boolean
  onState: (s: CaptionsState | null) => void
  onError: (e: string | null) => void
}) {
  const { tabId, captions, canCaption, onState, onError } = props
  const [mode, setMode] = useState<CaptionMode>('sentences')
  const pending = captions?.pendingDownload
  const ready = captions?.phase === 'done'
  const enabled = (canCaption || ready) && !pending
  const download = async () => {
    onError(null)
    try {
      const state = await send({ type: 'captions.download', tabId, mode })
      if (state === undefined) throw new Error(NO_ANSWER)
      onState(state)
    } catch (e) {
      onError(errorText(e))
    }
  }
  return (
    <section style={card} data-testid="download-card">
      <div style={label}>Download subtitles</div>
      <div style={{ ...row, gap: 8 }}>
        <Segmented testId="download-mode" options={MODES} value={mode} onChange={setMode} />
        <button
          data-testid="download-srt"
          style={{
            ...primaryButton,
            whiteSpace: 'nowrap',
            ...(enabled ? {} : { opacity: 0.5, cursor: 'default' }),
          }}
          disabled={!enabled}
          onClick={() => void download()}
        >
          Download SRT
        </button>
      </div>
      <div
        data-testid="download-status"
        style={{ fontSize: 11, color: colors.muted, lineHeight: 1.4 }}
      >
        {pending
          ? `Transcribing the whole video… ${Math.round((captions?.progress ?? 0) * 100)}%. The file saves by itself when it’s done.`
          : ready
            ? 'Ready: saves right away.'
            : 'Transcribes the whole video first, several times faster than playing it.'}
      </div>
    </section>
  )
}

const SOURCE: Record<string, string> = { element: 'this video’s audio', tab: 'the tab’s audio' }

/** One line of live status (Spec 08 §7: surfaced, never silent). */
function LiveLine({ live }: { live: LiveState | null }) {
  if (!live) return null
  const text: Record<LiveState['phase'], string> = {
    starting: 'Starting…',
    listening: `Listening to ${SOURCE[live.source ?? ''] ?? 'the video'} · ${live.cues} cues${live.detail?.startsWith('live') ? ` · ${live.detail.replace('live · ', '')}` : ''}`,
    refining: 'Refining the captions with full context…',
    done: `Done · ${live.cues} cues`,
    error: live.error ?? 'Live captions failed.',
    stopped: 'Stopped.',
  }
  return (
    <div
      data-testid="live-status"
      data-phase={live.phase}
      style={{
        fontSize: 11,
        lineHeight: 1.4,
        color: live.phase === 'error' ? colors.bad : colors.muted,
      }}
    >
      {text[live.phase]}
    </div>
  )
}

/**
 * Save the live track as SRT (Spec 09 §7): the draft so far while listening,
 * the refined captions once stopped. Named after the page title.
 */
function LiveDownload({ tabId }: { tabId: number }) {
  const [saved, setSaved] = useState<SavedLiveTrack | null>(null)
  useEffect(() => {
    const key = liveTrackKey(tabId)
    void browser.storage.session.get(key).then((got) => {
      setSaved((got[key] as SavedLiveTrack | undefined) ?? null)
    })
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && key in changes)
        setSaved((changes[key]!.newValue as SavedLiveTrack | undefined) ?? null)
    }
    browser.storage.onChanged.addListener(onChanged)
    return () => browser.storage.onChanged.removeListener(onChanged)
  }, [tabId])
  if (!saved || saved.track.cues.length === 0) return null
  const { track, final } = saved
  const download = async () => {
    const title = (await browser.tabs.get(tabId).catch(() => null))?.title ?? ''
    const name =
      title
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'sublight-live'
    const url = URL.createObjectURL(
      new Blob([serializeSrt(track.cues)], { type: 'text/plain;charset=utf-8' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}${final ? '' : '.draft'}.${track.language}.srt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return (
    <button
      data-testid="live-download"
      data-final={final}
      style={button}
      onClick={() => void download()}
    >
      {final
        ? `Download SRT (${track.cues.length} cues)`
        : `Download draft SRT so far (${track.cues.length} cues)`}
    </button>
  )
}
