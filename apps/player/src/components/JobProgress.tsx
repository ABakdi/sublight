import { useEffect, useState } from 'react'
import { useCaptionStore, type CaptionPhase } from '../store/caption'
import { BTN } from './ui'

const LABEL: Record<'caption' | 'translate', Record<CaptionPhase, string>> = {
  caption: {
    idle: '',
    uploading: 'Sending the video to the engine',
    queued: 'Waiting',
    transcribing: 'Transcribing',
    done: 'Done',
    cancelled: 'Cancelled',
    error: 'Failed',
  },
  translate: {
    idle: '',
    uploading: 'Sending the audio to the engine',
    queued: 'Waiting',
    transcribing: 'Translating',
    done: 'Done',
    cancelled: 'Cancelled',
    error: 'Failed',
  },
}

export function isRunning(phase: CaptionPhase): boolean {
  return phase === 'uploading' || phase === 'queued' || phase === 'transcribing'
}

/** Progress, cancel, result or error for the current engine run (caption or translate). */
export function JobProgress({ testId }: { testId: 'caption' | 'translate' }) {
  const { activity, phase, progress, detail, error, resultNote, cancel } = useCaptionStore()
  const pct = Math.round(progress * 100)
  return (
    <>
      {isRunning(phase) && (
        <div className="flex flex-col gap-2" data-testid={`${testId}-progress`} data-phase={phase}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-zinc-200">{LABEL[activity][phase]}</span>
            <span className="tabular-nums text-zinc-400">{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-zinc-300 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          {detail && <p className="text-xs text-zinc-400">{detail}</p>}
          <button
            type="button"
            data-testid={`${testId}-cancel`}
            className={BTN}
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        </div>
      )}
      {phase === 'done' && resultNote && (
        <p data-testid={`${testId}-done`} className="text-xs text-emerald-300">
          Added a subtitle track · {resultNote}
        </p>
      )}
      {phase === 'cancelled' && <p className="text-xs text-zinc-400">Cancelled.</p>}
      {phase === 'error' && error && (
        <p
          data-testid={`${testId}-error`}
          data-code={error.code}
          role="alert"
          className="text-xs leading-relaxed text-red-300"
        >
          {error.message}
        </p>
      )}
    </>
  )
}

/**
 * The current run as a small toast over the page (M06b.10): visible with the
 * panels closed, and the moment a run ends (done or failed) for a few seconds.
 */
export function JobToast({ onOpen }: { onOpen: () => void }) {
  const { activity, phase, progress, error, resultNote } = useCaptionStore()
  const [shownEnd, setShownEnd] = useState<CaptionPhase | null>(null)
  useEffect(() => {
    if (phase !== 'done' && phase !== 'error') return
    setShownEnd(phase)
    const t = setTimeout(() => setShownEnd(null), 5000)
    return () => clearTimeout(t)
  }, [phase])
  const running = isRunning(phase)
  if (!running && !shownEnd) return null
  const pct = Math.round(progress * 100)
  const text = running
    ? `${LABEL[activity][phase]}… ${pct}%`
    : phase === 'error'
      ? `${activity === 'caption' ? 'Captioning' : 'Translation'} failed: ${error?.message ?? ''}`
      : `${activity === 'caption' ? 'Captions' : 'Translation'} ready${resultNote ? ` · ${resultNote}` : ''}`
  return (
    <button
      type="button"
      data-testid="job-toast"
      data-phase={phase}
      onClick={onOpen}
      className={`fixed right-4 bottom-4 z-30 flex max-w-sm items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm shadow-xl ${
        phase === 'error'
          ? 'border-red-900/60 bg-red-950 text-red-200'
          : 'border-zinc-700 bg-zinc-900 text-zinc-100'
      }`}
    >
      {running && (
        <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded bg-zinc-700">
          <span className="block h-full bg-indigo-500" style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="min-w-0 truncate">{text}</span>
    </button>
  )
}
