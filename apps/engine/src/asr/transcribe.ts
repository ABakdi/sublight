import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCuesFromWords,
  MAX_CUE_DURATION_MS,
  newId,
  type SpeechWord,
  type SubtitleCue,
  type SubtitleTrack,
} from '@sublight/core'
import type { TranscribeJob } from '@sublight/protocol'
import { sliceWav, type FfmpegBinaries } from '../media/ffmpeg'
import type { MediaStore } from '../media/store'
import { JobError, type JobRunner, type RunContext, type RunOutput } from '../jobs/queue'
import type { ModelManager } from '../models/manager'
import { isWhisperLanguage, whisperLanguageCode } from './languages'
import { cuesFromSegments } from './segments'
import type { WhisperWorker } from './whisper'
import { segmentsFromVerbose, wordsFromVerbose, type Segment, type VerboseJson } from './words'

/** Long-form chunking (Spec 07 §1.6): resumable 10-min pieces with overlap. */
export const CHUNK_MS = 10 * 60 * 1000
export const CHUNK_OVERLAP_MS = 1000
/** Bump when output changes for the same input, so stale cache entries miss. */
const PIPELINE_VERSION = 3

export interface TranscribeDeps {
  media: MediaStore
  models: ModelManager
  whisper: WhisperWorker
  ffmpeg: FfmpegBinaries
  chunkMs?: number
}

interface Chunk {
  index: number
  startMs: number
  /** Content owned by this chunk ends here; the overlap past it is only context. */
  endMs: number
  sliceMs: number
}

export function planChunks(durationMs: number, chunkMs = CHUNK_MS): Chunk[] {
  const chunks: Chunk[] = []
  for (let start = 0, i = 0; start < durationMs || i === 0; start += chunkMs, i++) {
    const end = Math.min(durationMs, start + chunkMs)
    chunks.push({
      index: i,
      startMs: start,
      endMs: end,
      sliceMs: Math.min(durationMs - start, chunkMs + CHUNK_OVERLAP_MS),
    })
    if (end >= durationMs) break
  }
  return chunks
}

/** Keep each word once across overlapping chunks: later chunks only add words after the last kept one. */
export function mergeWords(into: SpeechWord[], next: SpeechWord[], ownedUntilMs: number): void {
  const lastEnd = into[into.length - 1]?.endMs ?? -1
  for (const w of next) {
    if (w.startMs < lastEnd - 50) continue
    if (w.startMs >= ownedUntilMs) break
    into.push(w)
  }
}

export function mergeSegments(into: Segment[], next: Segment[], ownedUntilMs: number): void {
  const lastEnd = into[into.length - 1]?.endMs ?? -1
  for (const s of next) {
    if (s.startMs < lastEnd - 200) continue
    if (s.startMs >= ownedUntilMs) break
    into.push(s)
  }
}

/**
 * `transcribe` jobs (Spec 07 §1, ADR-0018): normalized audio → whisper-server
 * → word-level cues, or with `task: "translate"` → English segment-timed cues.
 * Each chunk's raw whisper output is checkpointed so an interrupted job
 * resumes after the last finished chunk.
 */
export function transcribeRunner(deps: TranscribeDeps): JobRunner<TranscribeJob> {
  const chunkMs = deps.chunkMs ?? CHUNK_MS
  return {
    type: 'transcribe',
    gpu: true,

    validate(req) {
      if (!req.mediaHash || !deps.media.resolve(req.mediaHash)) {
        throw new JobError(
          'JOB_INVALID',
          `unknown media '${req.mediaHash}' — upload it with PUT /v1/media/:id first`,
          false,
          404,
        )
      }
      const entry = deps.models.entry(req.model)
      if (entry.role !== 'asr')
        throw new JobError('JOB_INVALID', `'${req.model}' is not a speech-recognition model`)
      const task = req.params?.task ?? 'transcribe'
      if (!entry.tasks?.includes(task)) {
        throw new JobError(
          'JOB_INVALID',
          `'${req.model}' cannot ${task}; use whisper-small or another multilingual model`,
        )
      }
      if (req.params?.language && !isWhisperLanguage(req.params.language)) {
        throw new JobError('JOB_INVALID', `unsupported language '${req.params.language}'`)
      }
      const maxCue = req.params?.maxCueDurationMs ?? MAX_CUE_DURATION_MS
      if (!Number.isInteger(maxCue) || maxCue < 1000 || maxCue > 15000) {
        throw new JobError(
          'JOB_INVALID',
          'maxCueDurationMs must be an integer between 1000 and 15000',
        )
      }
      if (!deps.models.isInstalled(req.model)) {
        throw new JobError(
          'MODEL_NOT_INSTALLED',
          `model '${req.model}' is not installed — POST /v1/models/${req.model}/install`,
          false,
          409,
        )
      }
    },

    cacheKey(req) {
      const hash = deps.media.resolve(req.mediaHash)
      const p = req.params ?? {}
      return [
        'transcribe',
        PIPELINE_VERSION,
        hash,
        req.model,
        p.task ?? 'transcribe',
        p.language ?? 'auto',
        p.maxCueDurationMs ?? MAX_CUE_DURATION_MS,
      ].join('|')
    },

    async run(req, ctx) {
      const started = Date.now()
      const hash = deps.media.resolve(req.mediaHash)
      if (!hash)
        throw new JobError('JOB_INVALID', 'media was evicted from the cache; upload it again')
      const wav = deps.media.wavPath(hash)
      const durationMs = deps.media.meta(hash)!.durationMs
      const task = req.params?.task ?? 'transcribe'
      const maxCue = req.params?.maxCueDurationMs ?? MAX_CUE_DURATION_MS

      ctx.progress(0, 'loading model')
      await deps.whisper.ensure(req.model, deps.models.pathOf(req.model))

      const chunks = planChunks(durationMs, chunkMs)
      const dir = ctx.chunkDir()
      const words: SpeechWord[] = []
      const segments: Segment[] = []
      let language = req.params?.language ?? null
      // A resumed run only times part of the audio; keep it out of the speed metric.
      let resumed = false

      for (const chunk of chunks) {
        if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
        const checkpoint = join(dir, `${chunk.index}.json`)
        let json: VerboseJson
        if (existsSync(checkpoint)) {
          resumed = true
          json = JSON.parse(readFileSync(checkpoint, 'utf8')) as VerboseJson
        } else {
          ctx.progress(
            chunk.index / chunks.length,
            chunks.length > 1
              ? `transcribing part ${chunk.index + 1} of ${chunks.length}`
              : 'transcribing',
          )
          let input = wav
          if (chunks.length > 1) {
            input = join(dir, `${chunk.index}.wav`)
            await sliceWav(deps.ffmpeg, wav, input, chunk.startMs, chunk.sliceMs)
          }
          try {
            json = await deps.whisper.infer(input, {
              language,
              translate: task === 'translate',
              signal: ctx.signal,
            })
          } finally {
            if (input !== wav) rmSync(input, { force: true })
          }
          writeFileSync(checkpoint, JSON.stringify(json))
        }
        // Detect once, then pin the language so every chunk decodes the same way.
        language ??= whisperLanguageCode(json.detected_language ?? json.language)

        const owned = chunk.index === chunks.length - 1 ? Number.POSITIVE_INFINITY : chunk.endMs
        if (task === 'translate')
          mergeSegments(segments, segmentsFromVerbose(json, chunk.startMs), owned)
        else mergeWords(words, wordsFromVerbose(json, chunk.startMs), owned)

        ctx.progress((chunk.index + 1) / chunks.length, 'transcribing')
        if (chunks.length > 1) ctx.partial(makeTrack(task, language, build(), true))
      }

      function build(): SubtitleCue[] {
        return task === 'translate'
          ? cuesFromSegments(segments, maxCue)
          : buildCuesFromWords(words, { maxCueDurationMs: maxCue })
      }

      const track = makeTrack(task, language, build(), false)
      const wallSeconds = (Date.now() - started) / 1000
      return {
        tracks: [track],
        ...(language ? { language } : {}),
        ...(durationMs > 0 && !resumed
          ? { realtimeFactor: Math.round((wallSeconds / (durationMs / 1000)) * 1000) / 1000 }
          : {}),
      } satisfies RunOutput
    },
  }
}

function makeTrack(
  task: 'transcribe' | 'translate',
  language: string | null,
  cues: SubtitleCue[],
  draft: boolean,
): SubtitleTrack {
  const source = language ?? 'und'
  const translated = task === 'translate'
  return {
    id: newId(),
    // The engine doesn't know the client's project; clients set it on import.
    projectId: '',
    language: translated ? 'en' : source,
    title: translated ? 'English (Whisper translation)' : `${source} (Whisper)`,
    kind: translated ? 'translation' : 'transcript',
    ...(translated ? { derivedFrom: { sourceLanguage: source } } : {}),
    ...(draft ? { draft: true } : {}),
    cues,
    createdAt: Date.now(),
  }
}

export type { RunContext }
