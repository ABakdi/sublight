import { useEffect, useState } from 'react'
import { DISK_HEADROOM_BYTES, type ModelInfo } from '@sublight/protocol'
import { useEngineStore } from '../store/engine'
import { BTN } from './ui'

/** Below this much free space, warn (models are 0.1–3 GB each). */
const LOW_DISK_BYTES = 5 * 1024 ** 3

export function gb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`
}

const GROUPS: [ModelInfo['role'], string][] = [
  ['asr', 'Speech recognition'],
  ['translate', 'Translation'],
]

/**
 * The models on this computer (M06.8, Spec 04): what's installed and how big,
 * install or remove, and how much disk is left. An install that wouldn't fit
 * (with 1 GB to spare) is disabled here and refused by the engine.
 */
export function ModelsPanel() {
  const status = useEngineStore((s) => s.status)
  const models = useEngineStore((s) => s.models)
  const disk = useEngineStore((s) => s.disk)
  const modelError = useEngineStore((s) => s.modelError)
  const refreshModels = useEngineStore((s) => s.refreshModels)
  const installModel = useEngineStore((s) => s.installModel)
  const removeModel = useEngineStore((s) => s.removeModel)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    if (status === 'online') void refreshModels()
  }, [status, refreshModels])

  if (status !== 'online') {
    return (
      <p className="text-xs text-zinc-400">
        Connect the engine to see and manage its models (Caption tab → pairing).
      </p>
    )
  }

  const free = disk?.freeBytes ?? null
  return (
    <div className="flex flex-col gap-4" data-testid="models-panel">
      {disk && (
        <div data-testid="models-disk" className="text-xs text-zinc-400">
          Models use <b className="text-zinc-200">{gb(disk.usedBytes)}</b>
          {free !== null && (
            <>
              {' '}
              · <b className="text-zinc-200">{gb(free)}</b> free on this disk
            </>
          )}
          {free !== null && free < LOW_DISK_BYTES && (
            <p data-testid="models-low-disk" className="mt-1 text-amber-300">
              The disk is almost full: remove models you don’t use, or free space elsewhere.
            </p>
          )}
        </div>
      )}
      {modelError && (
        <p data-testid="models-error" className="text-xs text-red-300">
          {modelError}
        </p>
      )}
      {GROUPS.map(([role, title]) => (
        <section key={role} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{title}</h3>
          {models
            .filter((m) => m.role === role)
            .map((m) => {
              const size = m.sizeBytes ?? 0
              const fits = free === null || size + DISK_HEADROOM_BYTES <= free
              return (
                <div
                  key={m.id}
                  data-testid={`model-${m.id}`}
                  data-state={m.state}
                  className="rounded-lg border border-zinc-800 p-2.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm text-zinc-100">{m.name}</span>
                    <span className="text-xs text-zinc-500">{size ? gb(size) : ''}</span>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    {m.license}
                    {m.vramClass ? ` · ${m.vramClass}` : ''}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    {m.state === 'downloading' ? (
                      <div className="flex-1">
                        <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
                          <div
                            className="h-full bg-indigo-500"
                            style={{ width: `${Math.round((m.progress ?? 0) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-[11px] text-zinc-400">
                          Downloading… {Math.round((m.progress ?? 0) * 100)} %
                        </p>
                      </div>
                    ) : m.installed ? (
                      confirming === m.id ? (
                        <>
                          <span className="text-xs text-zinc-300">Remove it?</span>
                          <button
                            type="button"
                            data-testid={`model-remove-yes-${m.id}`}
                            className={BTN}
                            onClick={() => {
                              setConfirming(null)
                              void removeModel(m.id)
                            }}
                          >
                            Remove
                          </button>
                          <button type="button" className={BTN} onClick={() => setConfirming(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-xs text-emerald-300">Installed</span>
                          <button
                            type="button"
                            data-testid={`model-remove-${m.id}`}
                            className={`${BTN} ml-auto`}
                            onClick={() => setConfirming(m.id)}
                          >
                            Remove
                          </button>
                        </>
                      )
                    ) : (
                      <>
                        <button
                          type="button"
                          data-testid={`model-install-${m.id}`}
                          className={BTN}
                          disabled={!fits}
                          onClick={() => void installModel(m.id)}
                        >
                          Install{size ? ` (${gb(size)})` : ''}
                        </button>
                        {!fits && (
                          <span className="text-[11px] text-amber-300">Not enough disk space</span>
                        )}
                        {m.state === 'error' && m.error && (
                          <span className="text-[11px] text-red-300">{m.error}</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
        </section>
      ))}
    </div>
  )
}
