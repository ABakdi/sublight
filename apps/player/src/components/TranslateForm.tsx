import { useMemo, useState } from 'react'
import type { SubtitleTrack } from '@sublight/core'
import { chooseTranslationPath } from '@sublight/protocol'
import { useCaptionStore, type TranslateOptions } from '../store/caption'
import { useEngineStore } from '../store/engine'
import { usePlayerStore } from '../store/player'
import { isRunning, JobProgress } from './JobProgress'
import { BTN, FIELD, LANGUAGES, mb, PRIMARY } from './ui'

type Glossary = TranslateOptions['glossary']

/** Stable fallback: a fresh [] in a zustand selector re-renders forever. */
const NO_GLOSSARY: Glossary = []

/** "Gregor = Grégoire" per line ⇄ glossary entries. */
export function parseGlossary(text: string): Glossary {
  return text
    .split('\n')
    .map((line) => line.split(/\s*[=→]\s*/))
    .filter((parts) => parts.length === 2 && parts[0]!.trim() && parts[1]!.trim())
    .map(([source, target]) => ({ source: source!.trim(), target: target!.trim() }))
}

function formatGlossary(glossary: Glossary): string {
  return glossary.map((g) => `${g.source} = ${g.target}`).join('\n')
}

/**
 * Translate one track (M04, Spec 07 §2.0). English with the audio available
 * goes through Whisper from the audio itself; everything else, or a glossary
 * / register choice, uses the local translation model.
 */
export function TranslateForm({ track }: { track: SubtitleTrack }) {
  const status = useEngineStore((s) => s.status)
  const models = useEngineStore((s) => s.models)
  const installModel = useEngineStore((s) => s.installModel)
  const savedGlossary = usePlayerStore((s) => s.project?.settings.glossary ?? NO_GLOSSARY)
  const setGlossary = usePlayerStore((s) => s.setGlossary)
  const hasAudio = usePlayerStore(
    (s) => s.videoFile !== null || Boolean(s.project?.media.mediaHash),
  )
  const { phase, activity, sourceTrackId, translate } = useCaptionStore()

  const targets = useMemo(
    () => LANGUAGES.filter(([code]) => code !== track.language),
    [track.language],
  )
  const [target, setTarget] = useState(targets[0]?.[0] ?? 'en')
  const [style, setStyle] = useState<TranslateOptions['style']>('neutral')
  const [glossaryText, setGlossaryText] = useState(formatGlossary(savedGlossary))
  const glossary = parseGlossary(glossaryText)

  const llm = models.find((m) => m.role === 'translate')
  const whisperCanTranslate = models.some(
    (m) => m.role === 'asr' && m.installed && m.tasks?.includes('translate'),
  )
  const path = chooseTranslationPath({
    targetLang: target,
    hasAudio: hasAudio && whisperCanTranslate,
    wantsGlossaryOrStyle: glossary.length > 0 || style !== 'neutral',
  })
  const needsLlm = path === 'llm' && !llm?.installed
  const running = isRunning(phase)
  const mine = activity === 'translate' && sourceTrackId === track.id

  if (status !== 'online') {
    return (
      <p className="text-xs text-zinc-400">Start and pair the engine (Caption tab) to translate.</p>
    )
  }

  return (
    <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3" data-testid="translate-form">
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
          Into
          <select
            data-testid="translate-target"
            className={FIELD}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {targets.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
          Register
          <select
            data-testid="translate-style"
            className={FIELD}
            value={style}
            onChange={(e) => setStyle(e.target.value as TranslateOptions['style'])}
          >
            <option value="neutral">Neutral</option>
            <option value="casual">Casual</option>
            <option value="formal">Formal</option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Glossary (one per line: name = translation)
        <textarea
          data-testid="translate-glossary"
          className={`${FIELD} h-16 font-mono text-xs`}
          placeholder="Gregor = Grégoire"
          value={glossaryText}
          onChange={(e) => setGlossaryText(e.target.value)}
          onBlur={() => void setGlossary(glossary)}
        />
      </label>

      <p className="text-xs text-zinc-500" data-testid="translate-route" data-path={path}>
        {path === 'whisper-translate'
          ? 'English straight from the audio with Whisper (no extra download).'
          : `With the local translation model${llm ? ` (${llm.name})` : ''}.`}
      </p>

      {needsLlm && llm && (
        <div className="flex items-center gap-2">
          {llm.state === 'downloading' ? (
            <p className="text-xs text-zinc-400" data-testid="llm-download">
              Downloading the translation model · {Math.round((llm.progress ?? 0) * 100)}%
            </p>
          ) : (
            <button
              type="button"
              data-testid="install-llm"
              className={BTN}
              onClick={() => void installModel(llm.id)}
            >
              Install translation model ({mb(llm.sizeBytes)})
            </button>
          )}
        </div>
      )}

      {mine && running ? (
        <JobProgress testId="translate" />
      ) : (
        <>
          <button
            type="button"
            data-testid="translate-start"
            className={PRIMARY}
            disabled={running || needsLlm}
            onClick={() => {
              void setGlossary(glossary)
              void translate(track.id, { targetLang: target, style, glossary })
            }}
          >
            Translate
          </button>
          {mine && <JobProgress testId="translate" />}
        </>
      )}
    </div>
  )
}
