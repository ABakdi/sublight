import { useEffect } from 'react'
import { useEngineStore } from './store/engine'

const PLACEHOLDER_ACTIONS = [
  {
    title: 'Load a video',
    detail: 'Local file or a page video via the extension',
    soon: 'M01 / M05b',
  },
  { title: 'Projects', detail: 'Transcribe, translate, and browse your library', soon: 'M01' },
  { title: 'Editor', detail: 'Cue grid, word bar, sync nudges, SRT export', soon: 'M07' },
  { title: 'Settings', detail: 'Styles, defaults, glossary, engine health', soon: 'M01' },
]

export function App() {
  const status = useEngineStore((s) => s.status)
  const health = useEngineStore((s) => s.health)
  const check = useEngineStore((s) => s.check)

  useEffect(() => {
    void check()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [check])

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-8">
      <header className="flex items-center justify-between border-b border-zinc-800 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">sublight player</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Local AI subtitles for any video — engine{' '}
            <code className="text-zinc-300">127.0.0.1:17421</code>
          </p>
        </div>
        <EngineStatus status={status} gpuName={health?.gpu.name ?? null} />
      </header>

      <main className="grid flex-1 gap-4 py-8 sm:grid-cols-2">
        {PLACEHOLDER_ACTIONS.map((action) => (
          <button
            key={action.title}
            type="button"
            disabled
            className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 text-left transition hover:border-zinc-700"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-medium text-zinc-100">{action.title}</h2>
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                {action.soon}
              </span>
            </div>
            <p className="mt-2 text-sm text-zinc-400">{action.detail}</p>
          </button>
        ))}
      </main>

      <footer className="border-t border-zinc-800 pt-4 text-xs text-zinc-500">
        Foundations build (M00) — placeholder UI. All AI runs locally; nothing leaves your machine.
      </footer>
    </div>
  )
}

function EngineStatus({
  status,
  gpuName,
}: {
  status: 'checking' | 'online' | 'offline'
  gpuName: string | null
}) {
  const styles: Record<'checking' | 'online' | 'offline', string> = {
    checking: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
    online: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30',
    offline: 'bg-red-400/10 text-red-300 ring-red-400/30',
  }
  const label =
    status === 'online' ? `engine online${gpuName ? ` · ${gpuName}` : ''}` : `engine ${status}`
  return (
    <div
      className={`rounded-full px-3 py-1 text-xs ring-1 ${styles[status]}`}
      data-testid="engine-status"
    >
      {label}
    </div>
  )
}
