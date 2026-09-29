import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  DISK_HEADROOM_BYTES,
  type ModelInfo,
  type ModelsResponse,
  type NativeResponse,
} from '@sublight/protocol'
import { engineRequest, native, startEngine, stopEngine } from './engine'
import { button, colors, primaryButton } from './ui'

/**
 * The engine and its models, from the extension (M06b.6, M06b.8): on or off
 * with a switch, what it's doing, when it turns itself off, and the models
 * with their disk space. Used by the popup's tabs and the Options page.
 */

const section: CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 14,
  marginTop: 14,
  background: '#fff',
}
const h2: CSSProperties = { fontSize: 15, margin: '0 0 6px' }
const small: CSSProperties = { fontSize: 12, color: colors.muted, lineHeight: 1.5 }

export function gb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`

type HostStatus = Extract<NativeResponse, { command: 'status' }>
type EngineView =
  | { kind: 'checking' }
  | { kind: 'no-host' }
  | { kind: 'starting' }
  | { kind: 'off'; version: string }
  | { kind: 'on'; status: HostStatus }

function describe(view: EngineView): { label: string; color: string; detail: string } {
  switch (view.kind) {
    case 'checking':
      return { label: 'Checking…', color: colors.muted, detail: '' }
    case 'no-host':
      return {
        label: 'Not installed',
        color: colors.bad,
        detail:
          'The engine that runs the speech models isn’t installed on this computer. Run install.sh (from the sublight website), then reopen this.',
      }
    case 'starting':
      return { label: 'Starting…', color: colors.warn, detail: 'Starting the engine…' }
    case 'off':
      return {
        label: 'Off',
        color: colors.muted,
        detail: 'It starts by itself when you caption a video, and turns off again when idle.',
      }
    case 'on': {
      const s = view.status
      const jobs = (s.activeJobs ?? 0) + (s.queuedJobs ?? 0)
      if (jobs > 0)
        return { label: 'Busy', color: colors.accent, detail: `${jobs} job${jobs > 1 ? 's' : ''}` }
      const exit = s.idle?.exitInMs
      const model = s.residentModel
      return {
        label: model ? 'On' : 'Idle',
        color: colors.ok,
        detail: [
          model ? `${model} loaded` : 'no model loaded',
          exit !== null && exit !== undefined ? `turns off in ${minutes(exit)} if unused` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }
    }
  }
}

/** The engine's state and its on/off switch (M06b.6), plus the idle delays (M06b.5). */
export function EngineCard() {
  const [view, setView] = useState<EngineView>({ kind: 'checking' })
  const [error, setError] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  const refresh = useCallback(async () => {
    const r = await native('status')
    if (!r) setView({ kind: 'no-host' })
    else if (!r.ok || r.command !== 'status') setView({ kind: 'no-host' })
    else setView(r.running ? { kind: 'on', status: r } : { kind: 'off', version: r.version })
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [refresh])

  const turnOn = async () => {
    setError(null)
    setView({ kind: 'starting' })
    if (!(await startEngine())) setError('The engine didn’t start: run install.sh again.')
    await refresh()
  }
  const turnOff = async () => {
    setError(null)
    setConfirmStop(false)
    if (!(await stopEngine())) setError('The engine didn’t stop.')
    await refresh()
  }

  const d = describe(view)
  const busy =
    view.kind === 'on' && (view.status.activeJobs ?? 0) + (view.status.queuedJobs ?? 0) > 0
  return (
    <section style={section} data-testid="engine-card" data-state={view.kind}>
      <h2 style={h2}>Engine</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{ width: 9, height: 9, borderRadius: 5, background: d.color, flex: 'none' }}
        />
        <b data-testid="engine-state" style={{ fontSize: 13, color: d.color, flex: 1 }}>
          {d.label}
        </b>
        {view.kind === 'off' && (
          <button data-testid="engine-switch" style={primaryButton} onClick={() => void turnOn()}>
            Turn on
          </button>
        )}
        {view.kind === 'on' &&
          (confirmStop ? (
            <>
              <button data-testid="engine-stop-yes" style={button} onClick={() => void turnOff()}>
                Stop the jobs
              </button>
              <button style={button} onClick={() => setConfirmStop(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              data-testid="engine-switch"
              style={button}
              onClick={() => (busy ? setConfirmStop(true) : void turnOff())}
            >
              Turn off
            </button>
          ))}
      </div>
      {d.detail && (
        <p data-testid="engine-detail" style={{ ...small, margin: '6px 0 0' }}>
          {d.detail}
        </p>
      )}
      {view.kind === 'on' && (
        <p style={{ ...small, margin: '2px 0 0' }}>
          v{view.status.version} · up {minutes(view.status.uptimeMs ?? 0)}
        </p>
      )}
      {error && <p style={{ ...small, color: colors.bad }}>{error}</p>}
      {view.kind === 'on' && <IdleSettings />}
    </section>
  )
}

/** The idle delays (M06b.5), stored in the engine's config.json. */
function IdleSettings() {
  const [idle, setIdle] = useState<{ unloadMinutes: number; exitMinutes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void engineRequest<{ idle: { unloadMinutes: number; exitMinutes: number } }>(
      '/v1/settings',
      {},
      { start: false },
    ).then(
      (r) => setIdle(r.idle),
      () => setIdle(null),
    )
  }, [])
  if (!idle) return null
  const save = async (patch: Partial<typeof idle>) => {
    setError(null)
    try {
      const r = await engineRequest<{ idle: typeof idle }>('/v1/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idle: patch }),
      })
      setIdle(r.idle)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const keep = idle.exitMinutes === 0
  const select = (
    value: number,
    onChange: (v: number) => void,
    testId: string,
    options: number[],
  ) => (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => void onChange(Number(e.target.value))}
      style={{ font: 'inherit', fontSize: 12 }}
    >
      {options.map((m) => (
        <option key={m} value={m}>
          {m} min
        </option>
      ))}
    </select>
  )
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 10, fontSize: 12 }}>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="keep-running"
          checked={keep}
          onChange={(e) => void save({ exitMinutes: e.target.checked ? 0 : 20 })}
        />
        Keep the engine running (don’t turn it off when idle)
      </label>
      {!keep && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Turn off after
          {select(
            idle.exitMinutes,
            (v) => save({ exitMinutes: v }),
            'idle-exit',
            [10, 20, 30, 60, 120],
          )}
          without use
        </label>
      )}
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        Free the graphics memory after
        {select(
          idle.unloadMinutes,
          (v) => save({ unloadMinutes: v }),
          'idle-unload',
          [2, 5, 10, 30],
        )}
      </label>
      <span style={{ ...small, fontSize: 11 }}>Halved on battery.</span>
      {error && <span style={{ color: colors.bad }}>{error}</span>}
    </div>
  )
}

const GROUPS: [ModelInfo['role'], string][] = [
  ['asr', 'Speech recognition'],
  ['translate', 'Translation (languages other than English)'],
]

/** Models from the extension (M06b.8): install, remove, disk space, cached audio. */
export function ModelsCard() {
  const [data, setData] = useState<ModelsResponse | null>(null)
  const [cacheBytes, setCacheBytes] = useState<number | null>(null)
  const [off, setOff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await engineRequest<ModelsResponse>('/v1/models', {}, { start: false }))
      const h = await engineRequest<{ mediaCacheBytes?: number }>(
        '/v1/health',
        {},
        { start: false },
      )
      setCacheBytes(h.mediaCacheBytes ?? null)
      setOff(false)
    } catch {
      setOff(true)
    }
  }, [])

  const downloading = data?.models.some((m) => m.state === 'downloading') ?? false
  useEffect(() => {
    void load()
    if (!downloading) return
    const id = setInterval(() => void load(), 1500)
    return () => clearInterval(id)
  }, [load, downloading])

  const act = async (path: string) => {
    setError(null)
    setConfirming(null)
    try {
      await engineRequest(path, { method: 'POST' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    await load()
  }

  if (off || !data)
    return (
      <section style={section} data-testid="models-card" data-state="off">
        <h2 style={h2}>Models</h2>
        <p style={small}>
          {off ? 'The engine is off. ' : 'Loading… '}
          {off && (
            <button
              style={button}
              onClick={() =>
                void startEngine().then(() => {
                  void load()
                })
              }
            >
              Turn it on
            </button>
          )}
        </p>
      </section>
    )

  const free = data.diskFreeBytes
  return (
    <section style={section} data-testid="models-card" data-state="on">
      <h2 style={h2}>Models</h2>
      <p data-testid="models-disk" style={{ ...small, margin: 0 }}>
        Models use <b>{gb(data.diskUsedBytes)}</b>
        {free !== null && (
          <>
            {' '}
            · <b>{gb(free)}</b> free
          </>
        )}
        {cacheBytes !== null && cacheBytes > 0 && (
          <>
            {' '}
            · cached audio {gb(cacheBytes)}{' '}
            <button
              data-testid="media-cache-clear"
              style={{ ...button, padding: '1px 6px', fontSize: 11 }}
              onClick={() => void act('/v1/media/clear')}
            >
              Clear
            </button>
          </>
        )}
      </p>
      {error && (
        <p data-testid="models-error" style={{ ...small, color: colors.bad }}>
          {error}
        </p>
      )}
      {GROUPS.map(([role, title]) => (
        <div key={role} style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: colors.muted, marginBottom: 4 }}>
            {title}
          </div>
          {data.models
            .filter((m) => m.role === role)
            .map((m) => {
              const size = m.sizeBytes ?? 0
              const fits = free === null || size + DISK_HEADROOM_BYTES <= free
              return (
                <div
                  key={m.id}
                  data-testid={`model-${m.id}`}
                  data-state={m.state}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 0',
                    borderTop: `1px solid ${colors.border}`,
                    fontSize: 12,
                  }}
                >
                  <span style={{ flex: 1 }}>
                    {m.name}
                    <span style={{ color: colors.muted }}> · {size ? gb(size) : ''}</span>
                  </span>
                  {m.state === 'downloading' ? (
                    <span data-testid={`model-${m.id}-progress`} style={{ color: colors.accent }}>
                      {Math.round((m.progress ?? 0) * 100)} %
                    </span>
                  ) : m.installed ? (
                    confirming === m.id ? (
                      <>
                        <button
                          style={button}
                          onClick={() => void act(`/v1/models/${m.id}/remove`)}
                        >
                          Remove
                        </button>
                        <button style={button} onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        data-testid={`model-${m.id}-remove`}
                        style={button}
                        onClick={() => setConfirming(m.id)}
                      >
                        Remove
                      </button>
                    )
                  ) : (
                    <button
                      data-testid={`model-${m.id}-install`}
                      style={fits ? primaryButton : { ...button, opacity: 0.5 }}
                      disabled={!fits}
                      title={fits ? undefined : 'Not enough free disk space'}
                      onClick={() => void act(`/v1/models/${m.id}/install`)}
                    >
                      Install
                    </button>
                  )}
                </div>
              )
            })}
        </div>
      ))}
    </section>
  )
}

/** Developer mode (Settings): shows what most people never need. */
export const DEVELOPER_MODE_KEY = 'developerMode'

interface DeviceSettings {
  device: 'auto' | 'cpu'
  gpu?: {
    whisper: { built: boolean; inUse: boolean }
    llama: { built: boolean; inUse: boolean }
  }
}

/** Where the models run (developer mode): the GPU when there is one, or the CPU. */
export function DeviceChoice() {
  const [s, setS] = useState<DeviceSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void engineRequest<DeviceSettings>('/v1/settings', {}, { start: false }).then(setS, () =>
      setS(null),
    )
  }, [])
  const choose = async (device: 'auto' | 'cpu') => {
    setError(null)
    try {
      setS(
        await engineRequest<DeviceSettings>('/v1/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device }),
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  if (!s) return <p style={small}>Turn the engine on to choose where the models run.</p>
  const built = s.gpu?.whisper.built ?? false
  return (
    <div data-testid="device-choice" style={{ display: 'grid', gap: 4, fontSize: 12 }}>
      <b>Run the models on</b>
      <label style={{ display: 'flex', gap: 6 }}>
        <input
          type="radio"
          name="device"
          data-testid="device-gpu"
          checked={s.device === 'auto'}
          disabled={!built}
          onChange={() => void choose('auto')}
        />
        The graphics card (GPU)
        {built ? ', much faster' : ': not available, the engine was built for the CPU'}
      </label>
      <label style={{ display: 'flex', gap: 6 }}>
        <input
          type="radio"
          name="device"
          data-testid="device-cpu"
          checked={s.device === 'cpu' || !built}
          onChange={() => void choose('cpu')}
        />
        The processor (CPU): slower, leaves the graphics card free
      </label>
      <span style={{ ...small, fontSize: 11 }}>
        Now: speech on the {s.gpu?.whisper.inUse ? 'GPU' : 'CPU'}, translation on the{' '}
        {s.gpu?.llama.inUse ? 'GPU' : 'CPU'}. A change applies from the next job.
      </span>
      {error && <span style={{ color: colors.bad }}>{error}</span>}
    </div>
  )
}
