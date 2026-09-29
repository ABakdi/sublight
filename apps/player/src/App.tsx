import { useEffect, useState } from 'react'
import {
  COOKIE_BROWSERS,
  decodeOpenPayload,
  type CookieBrowser,
  type OpenInPlayerPayload,
} from '@sublight/protocol'
import { engineBaseUrl } from './lib/engine'
import { useEngineStore, type EngineStatus as Status } from './store/engine'
import { usePlayerStore } from './store/player'
import { Library } from './components/Library'
import { PlayerView } from './components/PlayerView'
import { applyTheme, NEXT_THEME, savedTheme, type ThemeChoice } from './lib/theme'

export function App() {
  const status = useEngineStore((s) => s.status)
  const health = useEngineStore((s) => s.health)
  const check = useEngineStore((s) => s.check)
  const view = usePlayerStore((s) => s.view)
  const openFromPage = usePlayerStore((s) => s.openFromPage)
  const setError = usePlayerStore((s) => s.setError)
  const [theme, setTheme] = useState<ThemeChoice>(savedTheme)
  useEffect(() => applyTheme(theme), [theme])

  // "Open in Sublight Player" (M05b): the extension hands the page's video over in the hash.
  // Any site can link here with a hash, so nothing happens until the viewer says so (baseline F6).
  const [handoff, setHandoff] = useState<OpenInPlayerPayload | null>(null)
  useEffect(() => {
    const m = /^#sl=([\w-]+)$/.exec(location.hash)
    if (!m) return
    history.replaceState(null, '', location.pathname + location.search) // consume once
    try {
      setHandoff(decodeOpenPayload(m[1]!))
    } catch {
      setError('The video handed over by the extension couldn’t be read.')
    }
  }, [setError])

  useEffect(() => {
    void check()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [check])

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">sublight player</h1>
          <p className="text-xs text-zinc-400">
            Local AI subtitles for any video — engine{' '}
            <code className="text-zinc-300">{engineBaseUrl().replace(/^https?:\/\//, '')}</code>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="theme-toggle"
            data-theme-choice={theme}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500"
            title="Theme: follow the system, light or dark"
            onClick={() => setTheme(NEXT_THEME[theme])}
          >
            {theme === 'system' ? '◐ System' : theme === 'light' ? '☀ Light' : '☾ Dark'}
          </button>
          <EngineStatus status={status} gpuName={health?.gpu.name ?? null} />
        </div>
      </header>

      {handoff ? (
        <HandoffConfirm
          payload={handoff}
          onOpen={(useLogin) => {
            setHandoff(null)
            void openFromPage(withLoginConsent(handoff, useLogin))
          }}
          onCancel={() => setHandoff(null)}
        />
      ) : view.name === 'library' ? (
        <Library />
      ) : (
        <PlayerView />
      )}
    </div>
  )
}

/** A browser whose login the hand-over asks for, when it names a real one. */
function loginAsked(payload: OpenInPlayerPayload): string | null {
  const b = payload.engine?.cookiesFromBrowser
  return typeof b === 'string' && (COOKIE_BROWSERS as readonly string[]).includes(b) ? b : null
}

/**
 * The browser login goes to the engine only when the viewer ticks it here
 * (security pass 2, S2): any site can link to the Player with a hand-over.
 */
export function withLoginConsent(
  payload: OpenInPlayerPayload,
  useLogin: boolean,
): OpenInPlayerPayload {
  const browser = loginAsked(payload)
  const engine: NonNullable<OpenInPlayerPayload['engine']> = { ...(payload.engine ?? {}) }
  delete engine.cookiesFromBrowser
  if (useLogin && browser) engine.cookiesFromBrowser = browser as CookieBrowser
  return { ...payload, engine }
}

/** "Open this video?": the handed-over page, before the engine fetches anything for it. */
function HandoffConfirm({
  payload,
  onOpen,
  onCancel,
}: {
  payload: OpenInPlayerPayload
  onOpen: (useLogin: boolean) => void
  onCancel: () => void
}) {
  const login = loginAsked(payload)
  const [useLogin, setUseLogin] = useState(false)
  let site = payload.source.pageUrl
  try {
    site = new URL(payload.source.pageUrl).host
  } catch {
    // shown as given
  }
  const title = payload.media.title || payload.source.pageTitle
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div
        data-testid="handoff-confirm"
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5"
      >
        <h2 className="text-base font-semibold">Open this video?</h2>
        {title && <p className="mt-2 text-sm text-zinc-200">{title}</p>}
        <p className="mt-1 text-xs break-all text-zinc-400">
          From <b className="text-zinc-200">{site}</b>. The engine will fetch it from there.
        </p>
        {login && (
          <label className="mt-3 flex items-start gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              data-testid="handoff-login"
              checked={useLogin}
              onChange={(e) => setUseLogin(e.target.checked)}
            />
            <span>
              Use my {login[0]!.toUpperCase() + login.slice(1)} login to fetch it (for videos that
              need one). The engine reads that browser’s cookies for this site.
            </span>
          </label>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            data-testid="handoff-open"
            autoFocus
            className="rounded-md bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-400"
            onClick={() => onOpen(useLogin)}
          >
            Open
          </button>
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function EngineStatus({ status, gpuName }: { status: Status; gpuName: string | null }) {
  const styles: Record<Status, string> = {
    checking: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
    online: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30',
    offline: 'bg-red-400/10 text-red-300 ring-red-400/30',
    unauthorized: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
  }
  const label =
    status === 'online'
      ? `engine online${gpuName ? ` · ${gpuName}` : ''}`
      : status === 'unauthorized'
        ? 'engine not paired'
        : `engine ${status}`
  return (
    <div
      className={`rounded-full px-3 py-1 text-xs ring-1 ${styles[status]}`}
      data-testid="engine-status"
    >
      {label}
    </div>
  )
}
