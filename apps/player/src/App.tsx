import { useEffect } from 'react'
import { useEngineStore } from './store/engine'
import { usePlayerStore } from './store/player'
import { Library } from './components/Library'
import { PlayerView } from './components/PlayerView'

export function App() {
  const status = useEngineStore((s) => s.status)
  const health = useEngineStore((s) => s.health)
  const check = useEngineStore((s) => s.check)
  const view = usePlayerStore((s) => s.view)

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
            <code className="text-zinc-300">127.0.0.1:17421</code>
          </p>
        </div>
        <EngineStatus status={status} gpuName={health?.gpu.name ?? null} />
      </header>

      {view.name === 'library' ? <Library /> : <PlayerView />}
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
