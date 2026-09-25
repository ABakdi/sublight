import { useEffect, useMemo, useState } from 'react'
import type { AsrTask, ModelInfo } from '@sublight/protocol'
import { useCaptionStore, type CaptionPhase } from '../store/caption'
import { useEngineStore } from '../store/engine'
import { usePlayerStore } from '../store/player'

const BTN =
  'rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700'
const PRIMARY =
  'rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40'
const FIELD =
  'w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100'

/** Common spoken languages first; whisper detects ~100 when left on Auto. */
const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ru', 'Russian'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese'],
  ['ko', 'Korean'],
  ['hi', 'Hindi'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
]

const PHASE_LABEL: Record<CaptionPhase, string> = {
  idle: '',
  uploading: 'Sending the video to the engine',
  queued: 'Waiting',
  transcribing: 'Transcribing',
  done: 'Done',
  cancelled: 'Cancelled',
  error: 'Failed',
}

const DEFAULT_MODEL = 'whisper-small'

function mb(bytes: number | null): string {
  return bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : ''
}

/** Engine unreachable or unpaired: say exactly what to do (Spec 04 §5.3, AC5). */
function EngineGate() {
  const status = useEngineStore((s) => s.status)
  const check = useEngineStore((s) => s.check)
  const pair = useEngineStore((s) => s.pair)
  const [token, setToken] = useState('')

  if (status === 'offline' || status === 'checking') {
    return (
      <div
        data-testid="engine-offline"
        className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3"
      >
        <p className="text-sm font-medium text-zinc-200">
          {status === 'checking' ? 'Looking for the engine…' : 'The engine isn’t running'}
        </p>
        <p className="text-xs leading-relaxed text-zinc-400">
          Captions are made by the local engine on this computer. Start it from the sublight folder:
        </p>
        <code className="rounded bg-black/40 px-2 py-1 text-xs text-zinc-200">pnpm dev:engine</code>
        <button type="button" className={BTN} onClick={() => void check()}>
          Check again
        </button>
      </div>
    )
  }
  return (
    <form
      data-testid="engine-pairing"
      className="flex flex-col gap-2 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void pair(token)
      }}
    >
      <p className="text-sm font-medium text-zinc-200">Pair with the engine</p>
      <p className="text-xs leading-relaxed text-zinc-400">
        Run <code className="text-zinc-200">pnpm engine:token</code> and paste the token. It stays
        in this browser.
      </p>
      <input
        data-testid="pairing-token"
        type="password"
        autoComplete="off"
        className={FIELD}
        placeholder="64 hex characters"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <button type="submit" className={BTN} disabled={!token.trim()}>
        Pair
      </button>
    </form>
  )
}

function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelInfo[]
  value: string
  onChange: (id: string) => void
}) {
  const installModel = useEngineStore((s) => s.installModel)
  const selected = models.find((m) => m.id === value)
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-zinc-400" htmlFor="caption-model">
        Model
      </label>
      <select
        id="caption-model"
        data-testid="caption-model"
        className={FIELD}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.installed ? '' : ' — not installed'}
          </option>
        ))}
      </select>
      {selected && !selected.installed && (
        <div className="flex items-center gap-2">
          {selected.state === 'downloading' ? (
            <div className="flex-1" data-testid="model-download">
              <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
                <div
                  className="h-full bg-zinc-300"
                  style={{ width: `${Math.round((selected.progress ?? 0) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-zinc-400">
                Downloading {mb(selected.sizeBytes)} · {Math.round((selected.progress ?? 0) * 100)}%
              </p>
            </div>
          ) : (
            <button
              type="button"
              data-testid="install-model"
              className={BTN}
              onClick={() => void installModel(selected.id)}
            >
              Install ({mb(selected.sizeBytes)})
            </button>
          )}
          {selected.state === 'error' && (
            <span className="text-xs text-red-300">{selected.error}</span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Caption panel (Spec 04 §5, M03.2): engine gate, model/language/output
 * pickers, the "Caption this video" action, progress with cancel, and errors
 * in plain language.
 */
export function CaptionPanel() {
  const status = useEngineStore((s) => s.status)
  const allModels = useEngineStore((s) => s.models)
  const refreshModels = useEngineStore((s) => s.refreshModels)
  const hasFile = usePlayerStore((s) => s.videoFile !== null)
  const hasMediaHash = usePlayerStore((s) => Boolean(s.project?.media.mediaHash))
  const { phase, progress, detail, error, resultNote, start, cancel } = useCaptionStore()

  const models = useMemo(() => allModels.filter((m) => m.role === 'asr'), [allModels])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [language, setLanguage] = useState('')
  const [task, setTask] = useState<AsrTask>('transcribe')

  useEffect(() => {
    if (status === 'online') void refreshModels()
  }, [status, refreshModels])

  const selected = models.find((m) => m.id === model)
  const canTranslate = selected?.tasks?.includes('translate') ?? false
  useEffect(() => {
    if (!canTranslate && task === 'translate') setTask('transcribe')
  }, [canTranslate, task])

  if (status !== 'online') return <EngineGate />

  const running = phase === 'uploading' || phase === 'queued' || phase === 'transcribing'
  const ready = Boolean(selected?.installed) && (hasFile || hasMediaHash) && !running

  return (
    <div className="flex flex-col gap-3" data-testid="caption-panel">
      <ModelPicker models={models} value={model} onChange={setModel} />

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-zinc-400" htmlFor="caption-language">
          Spoken language
        </label>
        <select
          id="caption-language"
          data-testid="caption-language"
          className={FIELD}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="">Detect automatically</option>
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-1 text-sm text-zinc-200">
        <legend className="mb-1 text-xs text-zinc-400">Subtitles in</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="task"
            checked={task === 'transcribe'}
            onChange={() => setTask('transcribe')}
          />
          The spoken language
        </label>
        <label className={`flex items-center gap-2 ${canTranslate ? '' : 'opacity-40'}`}>
          <input
            type="radio"
            name="task"
            data-testid="caption-translate"
            disabled={!canTranslate}
            checked={task === 'translate'}
            onChange={() => setTask('translate')}
          />
          English (translated)
        </label>
        {!canTranslate && selected && (
          <span className="text-xs text-zinc-500">
            {selected.name} can’t translate; pick small or medium.
          </span>
        )}
      </fieldset>

      {!hasFile && !hasMediaHash && (
        <p className="text-xs text-amber-300">Open the video file again to caption it.</p>
      )}

      {running ? (
        <div className="flex flex-col gap-2" data-testid="caption-progress" data-phase={phase}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-zinc-200">{PHASE_LABEL[phase]}</span>
            <span className="tabular-nums text-zinc-400">{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-zinc-300 transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          {detail && <p className="text-xs text-zinc-500">{detail}</p>}
          <button
            type="button"
            data-testid="caption-cancel"
            className={BTN}
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="caption-start"
          className={PRIMARY}
          disabled={!ready}
          onClick={() =>
            void start({
              model,
              language: language || null,
              task: canTranslate ? task : 'transcribe',
            })
          }
        >
          Caption this video
        </button>
      )}

      {phase === 'done' && resultNote && (
        <p data-testid="caption-done" className="text-xs text-emerald-300">
          Added a subtitle track · {resultNote}
        </p>
      )}
      {phase === 'cancelled' && <p className="text-xs text-zinc-400">Captioning cancelled.</p>}
      {phase === 'error' && error && (
        <p
          data-testid="caption-error"
          data-code={error.code}
          role="alert"
          className="text-xs leading-relaxed text-red-300"
        >
          {error.message}
        </p>
      )}
    </div>
  )
}
