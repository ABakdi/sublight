import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId, type SubtitleCue, type SubtitleTrack } from '@sublight/core'
import type { TranslateJob } from '@sublight/protocol'
import { JobError, type JobRunner, type RunContext, type RunOutput } from '../jobs/queue'
import type { LlamaWorker } from '../llm/llama'
import type { ModelManager } from '../models/manager'
import type { GpuResidency } from '../workers/gpu'
import { cueLine, groupParagraphs } from './paragraphs'
import { parseNumbered, resplitByDuration } from './parse'
import { buildMessages, glossaryProblem, languageName, type Register } from './prompt'

/** Bump when output changes for the same input, so stale cache entries miss. */
const PIPELINE_VERSION = 2
/** Continuity context: this many previous source/translation pairs. */
const CONTEXT_LINES = 3
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const REGISTERS: Register[] = ['casual', 'neutral', 'formal']

export interface TranslateDeps {
  models: ModelManager
  llama: LlamaWorker
  gpu: GpuResidency
}

interface ParagraphResult {
  lines: string[]
  lowConfidence: boolean
  tokensPerSecond: number | null
}

/**
 * `translate` jobs (Spec 07 §2, ADR-0009 approach, ADR-0019 model): a track's
 * cues grouped into paragraphs, each translated as numbered lines and mapped
 * back 1:1, so the translation inherits the source timings exactly. Each
 * paragraph is checkpointed; a restart resumes after the last one.
 */
export function translateRunner(deps: TranslateDeps): JobRunner<TranslateJob> {
  async function attempt(
    lines: string[],
    job: TranslateJob,
    context: { source: string; target: string }[],
    signal: AbortSignal,
  ): Promise<{ lines: string[] | null; raw: string; tps: number | null }> {
    const messages = buildMessages({
      lines,
      sourceLang: job.track.language,
      targetLang: job.targetLang,
      register: job.style ?? 'neutral',
      glossary: job.glossary ?? [],
      context,
    })
    // Generous cap: translations run longer than the source in many languages.
    const chars = lines.reduce((n, l) => n + l.length, 0)
    const out = await deps.llama.chat(messages, {
      maxTokens: Math.max(256, Math.ceil(chars * 1.5)),
      signal,
    })
    return { lines: parseNumbered(out.text, lines.length), raw: out.text, tps: out.tokensPerSecond }
  }

  /** Validate 1:1; on mismatch retry as two halves once; then re-split by duration (Spec 07 §2.3). */
  async function translateParagraph(
    cues: SubtitleCue[],
    job: TranslateJob,
    context: { source: string; target: string }[],
    signal: AbortSignal,
    depth = 0,
  ): Promise<ParagraphResult> {
    const lines = cues.map(cueLine)
    const first = await attempt(lines, job, context, signal)
    if (first.lines) return { lines: first.lines, lowConfidence: false, tokensPerSecond: first.tps }
    if (depth === 0 && cues.length > 1) {
      const mid = Math.ceil(cues.length / 2)
      const a = await translateParagraph(cues.slice(0, mid), job, context, signal, 1)
      const b = await translateParagraph(
        cues.slice(mid),
        job,
        [
          ...context,
          ...cues.slice(0, mid).map((c, i) => ({ source: cueLine(c), target: a.lines[i]! })),
        ].slice(-CONTEXT_LINES),
        signal,
        1,
      )
      return {
        lines: [...a.lines, ...b.lines],
        lowConfidence: a.lowConfidence || b.lowConfidence,
        tokensPerSecond: a.tokensPerSecond ?? b.tokensPerSecond,
      }
    }
    const text = first.raw.replace(/^\s*\d+\s*[:.)]\s*/gm, ' ').replace(/<\/?subtitles>/g, ' ')
    return {
      lines: resplitByDuration(
        text,
        cues.map((c) => c.endMs - c.startMs),
      ),
      lowConfidence: true,
      tokensPerSecond: first.tps,
    }
  }

  return {
    type: 'translate',
    gpu: true,

    validate(req) {
      if (!req.track || !Array.isArray(req.track.cues) || req.track.cues.length === 0) {
        throw new JobError('JOB_INVALID', 'track with at least one cue is required')
      }
      if (req.track.cues.length > 20_000)
        throw new JobError('JOB_INVALID', 'track is too long (20,000 cues max)')
      if (!LANG_RE.test(req.targetLang ?? ''))
        throw new JobError('JOB_INVALID', `invalid target language '${req.targetLang}'`)
      if (!LANG_RE.test(req.track.language ?? ''))
        throw new JobError('JOB_INVALID', `invalid source language '${req.track.language}'`)
      if (req.targetLang === req.track.language)
        throw new JobError('JOB_INVALID', 'source and target language are the same')
      if (req.style && !REGISTERS.includes(req.style))
        throw new JobError('JOB_INVALID', `invalid style '${req.style}'`)
      const g = glossaryProblem(req.glossary ?? [])
      if (g) throw new JobError('JOB_INVALID', g)
      const entry = deps.models.entry(req.model)
      if (entry.role !== 'translate')
        throw new JobError('JOB_INVALID', `'${req.model}' is not a translation model`)
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
      const content = JSON.stringify({
        v: PIPELINE_VERSION,
        from: req.track.language,
        cues: req.track.cues.map((c) => [c.startMs, c.endMs, c.text, c.speaker ?? null]),
        to: req.targetLang,
        model: req.model,
        style: req.style ?? 'neutral',
        glossary: req.glossary ?? [],
      })
      return `translate|${createHash('sha256').update(content).digest('hex')}`
    },

    async run(req, ctx: RunContext): Promise<RunOutput> {
      const cues = req.track.cues
      const paragraphs = groupParagraphs(cues)
      ctx.progress(0, 'loading translation model')
      await deps.gpu.use('llm')
      await deps.llama.ensure(req.model, deps.models.pathOf(req.model))

      const out: string[] = new Array(cues.length).fill('')
      const low = new Array<boolean>(cues.length).fill(false)
      const speeds: number[] = []
      const dir = ctx.chunkDir()
      for (let p = 0; p < paragraphs.length; p++) {
        if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError')
        const idx = paragraphs[p]!
        const checkpoint = join(dir, `p${p}.json`)
        let result: ParagraphResult
        if (existsSync(checkpoint)) {
          result = JSON.parse(readFileSync(checkpoint, 'utf8')) as ParagraphResult
        } else {
          ctx.progress(p / paragraphs.length, `translating ${p + 1} of ${paragraphs.length}`)
          const before = idx[0]! - 1
          const context = []
          for (let i = Math.max(0, before - CONTEXT_LINES + 1); i <= before; i++) {
            if (out[i]) context.push({ source: cueLine(cues[i]!), target: out[i]! })
          }
          result = await translateParagraph(
            idx.map((i) => cues[i]!),
            req,
            context,
            ctx.signal,
          )
          writeFileSync(checkpoint, JSON.stringify(result))
        }
        idx.forEach((ci, k) => {
          out[ci] = result.lines[k] ?? ''
          low[ci] = result.lowConfidence
        })
        if (result.tokensPerSecond) speeds.push(result.tokensPerSecond)
        ctx.progress((p + 1) / paragraphs.length, `translating ${p + 1} of ${paragraphs.length}`)
        ctx.partial(makeTrack(req, cues, out, low, true))
      }

      const lowCount = low.filter(Boolean).length
      return {
        tracks: [makeTrack(req, cues, out, low, false)],
        language: req.track.language,
        translation: {
          paragraphs: paragraphs.length,
          lowConfidenceCues: lowCount,
          tokensPerSecond: speeds.length
            ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10
            : null,
        },
      }
    },
  }
}

function makeTrack(
  req: TranslateJob,
  cues: SubtitleCue[],
  lines: string[],
  low: boolean[],
  draft: boolean,
): SubtitleTrack {
  return {
    id: newId(),
    projectId: req.track.projectId,
    language: req.targetLang,
    title: `${languageName(req.targetLang)} (translated)`,
    kind: 'translation',
    derivedFrom: { trackId: req.track.id, sourceLanguage: req.track.language },
    ...(draft ? { draft: true } : {}),
    // Translation inherits source timing exactly (Spec 07 §2.3). Untranslated
    // cues keep their source text: in a draft until their paragraph lands; in
    // the final track (empty model output) flagged low-confidence.
    cues: cues.map((c, i) => ({
      id: newId(),
      startMs: c.startMs,
      endMs: c.endMs,
      text: lines[i] || c.text,
      ...(c.speaker ? { speaker: c.speaker } : {}),
      ...(low[i] || (!draft && !lines[i]) ? { lowConfidence: true } : {}),
    })),
    ...(req.track.syncOffsetMs ? { syncOffsetMs: req.track.syncOffsetMs } : {}),
    createdAt: Date.now(),
  }
}
