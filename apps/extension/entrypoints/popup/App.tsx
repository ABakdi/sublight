import { useCallback, useEffect, useState } from 'react'
import { serializeSrt } from '@sublight/core'
import { liveTrackKey, type SavedLiveTrack } from '../../src/liveController'
import { OVERLAY_STYLE_KEY, type QuickStyle } from '../../src/overlayFrame'
import { browser } from 'wxt/browser'
import { EngineBadge } from '../../src/EngineBadge'
import type { EngineStatus, LiveState, TabStatus, VideoState } from '../../src/messages'
import { send } from '../../src/send'
import { button, clock, colors, primaryButton } from '../../src/ui'

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

/**
 * Popup (Spec 09 §7): engine status, this tab's video, test captions.
 * Captioning and "Open in Sublight Player" arrive with M05/M05b.
 */
export function PopupApp() {
  const [tabId, setTabId] = useState<number | null>(null)
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [tab, setTab] = useState<TabStatus | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)

  const refreshEngine = useCallback(() => {
    setEngine(null)
    send({ type: 'engine.status' }).then(setEngine, (e: unknown) =>
      setEngine({ state: 'offline', detail: String(e) }),
    )
  }, [])

  useEffect(() => {
    void targetTabId().then(setTabId)
    refreshEngine()
  }, [refreshEngine])

  useEffect(() => {
    if (tabId === null) return
    const poll = () => {
      setNow(Date.now())
      send({ type: 'tab.status', tabId }).then(setTab, () => setTab(null))
      send({ type: 'live.status', tabId }).then(setLive, () => setLive(null))
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [tabId])

  const frame = primaryFrame(tab)
  const videoCount = tab?.frames.reduce((n, f) => n + f.videoCount, 0) ?? 0
  const demoOn = tab?.frames.some((f) => f.demoCaptions) ?? false
  const reported = (tab?.frames.length ?? 0) > 0

  const liveActive = live?.phase === 'starting' || live?.phase === 'listening'
  const toggleLive = async () => {
    if (tabId === null) return
    setError(null)
    try {
      setLive(await send({ type: liveActive ? 'live.stop' : 'live.start', tabId }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleDemo = async () => {
    if (tabId === null) return
    setError(null)
    try {
      await send({ type: 'demo.toggle', tabId, on: !demoOn })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main
      style={{
        width: 300,
        padding: 14,
        fontFamily: 'system-ui, sans-serif',
        color: colors.text,
        display: 'grid',
        gap: 12,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>sublight</h1>
        <span style={{ fontSize: 11, color: colors.muted }}>
          v{browser.runtime.getManifest().version}
        </span>
      </header>

      <section style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <EngineBadge status={engine} />
        <button style={{ ...button, alignSelf: 'start' }} onClick={refreshEngine}>
          Retry
        </button>
      </section>

      <section
        data-testid="video-status"
        data-videos={videoCount}
        style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 10, fontSize: 12 }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>This tab</div>
        {!reported ? (
          <div style={{ color: colors.muted }}>
            sublight can't see this page (browser pages and the Web Store are off-limits), or it is
            still loading. Reload the page if you just installed the extension.
          </div>
        ) : frame ? (
          <div style={{ lineHeight: 1.6 }}>
            <div>
              {videoCount} video{videoCount === 1 ? '' : 's'} found
              {frame.frame === 'iframe' ? ' (in an embedded player)' : ''}
            </div>
            <div style={{ color: colors.muted }} data-testid="playhead">
              {frame.primary!.isPlaying ? 'Playing' : 'Paused'} · {clock(playheadMs(frame, now))}
              {frame.primary!.durationMs !== null
                ? ` / ${clock(frame.primary!.durationMs)}`
                : ' · live'}
            </div>
          </div>
        ) : (
          <div style={{ color: colors.muted }}>No video on this page.</div>
        )}
      </section>

      <section style={{ display: 'grid', gap: 6 }} data-testid="live-section">
        <button
          data-testid="live-toggle"
          style={
            frame && engine?.state === 'online'
              ? primaryButton
              : { ...button, opacity: 0.5, cursor: 'default' }
          }
          disabled={!frame || engine?.state !== 'online'}
          onClick={toggleLive}
        >
          {liveActive ? 'Stop live captions' : 'Caption live'}
        </button>
        <LiveLine live={live} />
        {live?.notice && (live.phase === 'listening' || live.phase === 'starting') && (
          <div
            data-testid="live-notice"
            style={{ fontSize: 11, color: colors.warn, lineHeight: 1.4 }}
          >
            {live.notice}
          </div>
        )}
        {tabId !== null && live && live.phase !== 'starting' && <DownloadSrt tabId={tabId} />}
      </section>

      <section style={{ display: 'grid', gap: 6 }}>
        <button
          data-testid="demo-toggle"
          style={frame ? primaryButton : { ...button, opacity: 0.5, cursor: 'default' }}
          disabled={!frame}
          onClick={toggleDemo}
        >
          {demoOn ? 'Hide test captions' : 'Show test captions'}
        </button>
        <div style={{ fontSize: 11, color: colors.muted, lineHeight: 1.4 }}>
          Test captions show the video clock every 2.5 s, so you can check the overlay's position
          and sync on this site. Real captions need the engine (coming in M05).
        </div>
        <button style={{ ...button, opacity: 0.5, cursor: 'default' }} disabled>
          Open in Sublight Player (M05b)
        </button>
        {error && <div style={{ fontSize: 11, color: colors.bad }}>{error}</div>}
      </section>

      <QuickStyleRow />

      <footer style={{ borderTop: `1px solid ${colors.border}`, paddingTop: 8 }}>
        <button
          style={{ ...button, border: 'none', padding: 0, color: colors.accent }}
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          Options & pairing
        </button>
      </footer>
    </main>
  )
}

const SOURCE: Record<string, string> = { element: 'this video’s audio', tab: 'the tab’s audio' }

/** One line of live status (Spec 08 §7: surfaced, never silent). */
function LiveLine({ live }: { live: LiveState | null }) {
  if (!live) {
    return (
      <div style={{ fontSize: 11, color: colors.muted, lineHeight: 1.4 }}>
        Captions appear a few seconds behind the speech, then get refined when you stop.
      </div>
    )
  }
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
function DownloadSrt({ tabId }: { tabId: number }) {
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

const SIZES: [string, number][] = [
  ['S', 26],
  ['M', 34],
  ['L', 44],
]

/** Caption size and position, applied live to every overlay (M05.7). */
function QuickStyleRow() {
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
  const chip = (active: boolean) => ({
    ...button,
    padding: '3px 8px',
    ...(active ? { borderColor: colors.accent, color: colors.accent } : {}),
  })
  return (
    <section
      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: colors.muted }}
      data-testid="quick-style"
    >
      <span>Captions</span>
      {SIZES.map(([label, size]) => (
        <button
          key={label}
          data-testid={`size-${label}`}
          style={chip((style.fontSize ?? 34) === size)}
          onClick={() => update({ fontSize: size })}
        >
          {label}
        </button>
      ))}
      <span style={{ marginLeft: 4 }} />
      {(['bottom', 'top'] as const).map((a) => (
        <button
          key={a}
          data-testid={`anchor-${a}`}
          style={chip((style.anchor ?? 'bottom') === a)}
          onClick={() => update({ anchor: a })}
        >
          {a === 'bottom' ? 'Bottom' : 'Top'}
        </button>
      ))}
      <span style={{ marginLeft: 4 }} />
      <button
        data-testid="reveal-words"
        style={chip((style.reveal ?? 'words') === 'words')}
        title="Text fills in as each word is spoken"
        onClick={() =>
          update({ reveal: (style.reveal ?? 'words') === 'words' ? 'lines' : 'words' })
        }
      >
        Word by word
      </button>
    </section>
  )
}
