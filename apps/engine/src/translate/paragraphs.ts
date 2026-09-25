import type { SubtitleCue } from '@sublight/core'

export interface ParagraphOptions {
  /** A silence at least this long starts a new paragraph. */
  gapMs?: number
  /** Break at a sentence end once a paragraph has this many cues… */
  softMaxCues?: number
  /** …and always at this many. */
  hardMaxCues?: number
  maxChars?: number
}

const SENTENCE_END = /[.!?…]["')\]»]?$/u

/** One subtitle line per cue, as the model sees it. */
export function cueLine(cue: SubtitleCue): string {
  return cue.text.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Group consecutive cues into paragraphs (Spec 07 §2.1): translating cue by
 * cue loses context, a whole film at once loses the 1:1 line mapping. Breaks
 * on long silences, on speaker changes, at a sentence end once the paragraph
 * is reasonably sized, and hard at the cue/char caps. Returns cue indices.
 */
export function groupParagraphs(cues: SubtitleCue[], opts: ParagraphOptions = {}): number[][] {
  const gapMs = opts.gapMs ?? 1500
  const softMax = opts.softMaxCues ?? 5
  const hardMax = opts.hardMaxCues ?? 8
  const maxChars = opts.maxChars ?? 1500
  const out: number[][] = []
  let current: number[] = []
  let chars = 0
  cues.forEach((cue, i) => {
    const prev = cues[i - 1]
    if (current.length > 0 && prev) {
      const line = cueLine(cue)
      const gap = cue.startMs - prev.endMs >= gapMs
      const speaker = (cue.speaker ?? null) !== (prev.speaker ?? null)
      const sentence = current.length >= softMax && SENTENCE_END.test(cueLine(prev))
      const full = current.length >= hardMax || chars + line.length > maxChars
      if (gap || speaker || sentence || full) {
        out.push(current)
        current = []
        chars = 0
      }
    }
    current.push(i)
    chars += cueLine(cue).length + 1
  })
  if (current.length) out.push(current)
  return out
}
