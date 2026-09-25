import type { SpeechWord } from '@sublight/core'

/** whisper-server `verbose_json` (examples/server/server.cpp, v1.9.4). */
export interface VerboseToken {
  word: string
  /** Seconds. Absent when timestamps are off. */
  start?: number
  end?: number
  /** DTW time in centiseconds, -1 when DTW is off. Unused: see wordsFromVerbose. */
  t_dtw?: number
  probability?: number
}

export interface VerboseSegment {
  id: number
  text: string
  start?: number
  end?: number
  words?: VerboseToken[]
  avg_logprob?: number
  no_speech_prob?: number
}

export interface VerboseJson {
  task: 'transcribe' | 'translate'
  language: string
  duration: number
  text: string
  segments: VerboseSegment[]
  detected_language?: string
}

export interface Segment {
  startMs: number
  endMs: number
  text: string
}

/** Non-speech markers whisper emits as text: [_BEG_], [BLANK_AUDIO], (music)… */
const SPECIAL_TOKEN_RE = /^\s*(\[_[A-Z]+_?\d*\]|\[_TT_\d+\])\s*$/
const NON_SPEECH_RE = /^\s*[[(][^\])]*[\])]\s*$/

/** A token that is only punctuation: it joins the previous word but carries no speech timing. */
const PUNCT_ONLY_RE = /^[\p{P}\p{S}\s]+$/u

/**
 * Whisper's own rule for text invented over silence/music: a segment the
 * model thinks is probably not speech *and* decoded with low confidence.
 */
export function isLikelyHallucination(seg: VerboseSegment): boolean {
  return (seg.no_speech_prob ?? 0) > 0.6 && (seg.avg_logprob ?? 0) < -1
}

const toMs = (seconds: number | undefined) => Math.max(0, Math.round((seconds ?? 0) * 1000))

/**
 * Whisper "words" are BPE tokens: a token starting with a space opens a new
 * word, anything else (sub-words, punctuation) extends the previous one. Word
 * times come from the token timestamps: start = first token t0, end = last
 * speech token t1. Punctuation-only tokens don't move the end — whisper often
 * times them across the following pause. DTW times (`t_dtw`) are ignored: on
 * whisper.cpp v1.9.4 they track token *ends* and put onsets 200-400 ms late
 * (measured against energy onsets, ADR-0008 / Spec 07 §1.2). Times are made
 * monotonic and ≥ 10 ms. `offsetMs` shifts everything (chunked long-form audio).
 */
export function wordsFromVerbose(json: VerboseJson, offsetMs = 0): SpeechWord[] {
  const words: SpeechWord[] = []
  for (const seg of json.segments) {
    if (isLikelyHallucination(seg)) continue
    let current: { text: string; start: number; end: number; probs: number[] } | null = null
    const flush = () => {
      if (!current) return
      const text = current.text.trim()
      if (text && !NON_SPEECH_RE.test(text)) {
        const confidence = current.probs.reduce((a, b) => a + b, 0) / current.probs.length
        words.push({
          word: text,
          startMs: current.start + offsetMs,
          endMs: current.end + offsetMs,
          ...(Number.isFinite(confidence)
            ? { confidence: Math.round(confidence * 1000) / 1000 }
            : {}),
        })
      }
      current = null
    }
    for (const tok of seg.words ?? []) {
      if (!tok.word || SPECIAL_TOKEN_RE.test(tok.word)) continue
      const t0 = toMs(tok.start)
      const t1 = toMs(tok.end)
      const punctuation = PUNCT_ONLY_RE.test(tok.word)
      // Segments can end mid-word ("erw" | "achte"): a segment's first token
      // without a leading space continues the previous segment's last word.
      if (
        current === null &&
        !/^\s/.test(tok.word) &&
        words.length > 0 &&
        !NON_SPEECH_RE.test(tok.word)
      ) {
        const prev = words.pop()!
        current = {
          text: ` ${prev.word}`,
          start: prev.startMs - offsetMs,
          end: prev.endMs - offsetMs,
          probs: prev.confidence !== undefined ? [prev.confidence] : [],
        }
      }
      const opensWord = (/^\s/.test(tok.word) && !punctuation) || current === null
      if (opensWord) {
        flush()
        current = { text: tok.word, start: t0, end: Math.max(t0, t1), probs: [] }
      } else if (current) {
        current.text += tok.word
        if (!punctuation) current.end = Math.max(current.end, t1)
      }
      if (current && tok.probability !== undefined) current.probs.push(tok.probability)
    }
    flush()
  }
  // Monotonic, non-overlapping, at least 10 ms each.
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const prev = words[i - 1]
    if (prev && w.startMs < prev.endMs) {
      if (w.startMs < prev.startMs + 10) w.startMs = prev.startMs + 10
      prev.endMs = Math.max(prev.startMs + 10, Math.min(prev.endMs, w.startMs))
    }
    if (w.endMs < w.startMs + 10) w.endMs = w.startMs + 10
  }
  return words
}

/** Segment-level output (used for `translate`, where word times don't map to speech). */
export function segmentsFromVerbose(json: VerboseJson, offsetMs = 0): Segment[] {
  return json.segments
    .filter((s) => !isLikelyHallucination(s))
    .map((s) => ({
      startMs: toMs(s.start) + offsetMs,
      endMs: toMs(s.end) + offsetMs,
      text: s.text.trim(),
    }))
    .filter((s) => s.text && !NON_SPEECH_RE.test(s.text) && s.endMs > s.startMs)
}
