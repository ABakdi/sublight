import { useCallback, useEffect, useState } from 'react'
import { browser } from 'wxt/browser'
import { EngineBadge } from '../../src/EngineBadge'
import type { EngineStatus, TabStatus, VideoState } from '../../src/messages'
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
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [tabId])

  const frame = primaryFrame(tab)
  const videoCount = tab?.frames.reduce((n, f) => n + f.videoCount, 0) ?? 0
  const demoOn = tab?.frames.some((f) => f.demoCaptions) ?? false
  const reported = (tab?.frames.length ?? 0) > 0

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
