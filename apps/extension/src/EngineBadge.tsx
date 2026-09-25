import type { EngineStatus } from './messages'
import { colors } from './ui'

const COPY: Record<EngineStatus['state'], { label: string; color: string }> = {
  online: { label: 'Engine online', color: colors.ok },
  'no-token': { label: 'Engine not paired', color: colors.warn },
  unauthorized: { label: 'Token rejected', color: colors.bad },
  refused: { label: 'Engine refused the request', color: colors.bad },
  offline: { label: 'Engine offline', color: colors.muted },
}

export function engineHint(status: EngineStatus): string {
  switch (status.state) {
    case 'online':
      return `v${status.version} · protocol ${status.protocol}`
    case 'no-token':
      return 'Paste the engine token in Options (run `pnpm engine:token`).'
    case 'unauthorized':
      return 'The saved token does not match the engine. Paste it again in Options.'
    case 'refused':
      return status.detail
    case 'offline':
      return 'Start it with `pnpm dev:engine`. Playback and test captions work without it.'
  }
}

export function EngineBadge({ status }: { status: EngineStatus | null }) {
  const copy = status ? COPY[status.state] : { label: 'Checking engine…', color: colors.muted }
  return (
    <div data-testid="engine-status" data-state={status?.state ?? 'checking'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
        <span
          aria-hidden
          style={{ width: 8, height: 8, borderRadius: 4, background: copy.color, flex: 'none' }}
        />
        <span style={{ color: copy.color }}>{copy.label}</span>
      </div>
      {status && (
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 2, lineHeight: 1.4 }}>
          {engineHint(status)}
        </div>
      )}
    </div>
  )
}
