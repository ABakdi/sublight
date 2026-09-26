import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import type { SpeechWord } from '@sublight/core'

/** 16 kHz mono s16 PCM (the normalized WAV). */
const SAMPLE_RATE = 16000
const FRAME = 160 // 10 ms
const WAV_HEADER = 44

export interface OnsetOptions {
  /** Quiet needed before a rise counts as an onset. */
  minSilenceMs?: number
  /** Onset threshold above the estimated noise floor. */
  riseDb?: number
}

/** Frame levels in dBFS, 10 ms each, streamed from a normalized WAV. */
export function frameLevelsDb(wavPath: string): Float32Array {
  const fd = openSync(wavPath, 'r')
  try {
    const bytes = fstatSync(fd).size - WAV_HEADER
    const frames = Math.max(0, Math.floor(bytes / 2 / FRAME))
    const levels = new Float32Array(frames)
    const buf = Buffer.alloc(FRAME * 2 * 1000) // 10 s per read
    let frame = 0
    let offset = WAV_HEADER
    while (frame < frames) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      offset += n
      for (let f = 0; f + FRAME * 2 <= n && frame < frames; f += FRAME * 2, frame++) {
        let sum = 0
        for (let i = 0; i < FRAME; i++) {
          const s = buf.readInt16LE(f + i * 2)
          sum += s * s
        }
        const rms = Math.sqrt(sum / FRAME) / 32768
        levels[frame] = rms > 0 ? 20 * Math.log10(rms) : -120
      }
    }
    return levels
  } finally {
    closeSync(fd)
  }
}

/** Noise floor of frame levels: their 10th percentile. */
function noiseFloorDb(levels: Float32Array): number {
  const sorted = Float32Array.from(levels).sort()
  return sorted[Math.floor(sorted.length * 0.1)]!
}

/**
 * Speech onsets in ms (Spec 07 §1.4a): the noise floor is the 10th
 * percentile of frame levels; an onset is the first frame at least `riseDb`
 * above it after `minSilenceMs` of frames below that line. Relative to each
 * file's own floor, so room tone and quiet consonants don't shift it.
 */
export function onsetsFromLevels(levels: Float32Array, opts: OnsetOptions = {}): number[] {
  if (levels.length === 0) return []
  const threshold = noiseFloorDb(levels) + (opts.riseDb ?? 10)
  const quietFrames = Math.round((opts.minSilenceMs ?? 150) / 10)
  const onsets: number[] = []
  let quiet = quietFrames // audio start counts as after silence
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]! < threshold) quiet++
    else {
      if (quiet >= quietFrames) onsets.push(i * 10)
      quiet = 0
    }
  }
  return onsets
}

export function speechOnsetsMs(wavPath: string, opts?: OnsetOptions): number[] {
  return onsetsFromLevels(frameLevelsDb(wavPath), opts)
}

export { SAMPLE_RATE }

/** Frame levels (dBFS, 10 ms frames) of in-memory 16 kHz PCM. */
export function levelsFromPcm(pcm: Int16Array): Float32Array {
  const frames = Math.floor(pcm.length / FRAME)
  const levels = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += pcm[i]! * pcm[i]!
    const rms = Math.sqrt(sum / FRAME) / 32768
    levels[f] = rms > 0 ? 20 * Math.log10(rms) : -120
  }
  return levels
}

/** Quiet kept before the first onset when trimming: a little lead-in helps whisper. */
const LEAD_IN_MS = 300
/** A sound this short at a window's start, then a pause, is the previous word's tail. */
const LEFTOVER_MS = 250
const LEFTOVER_GAP_MS = 500

/**
 * Leading silence to cut from a window before whisper, in ms. Whisper stamps
 * the first word at the start of the audio, and with a long pause there every
 * later word can slip by one (JFK, a window from 1.9 s: "not" timed where
 * "ask" is spoken). Starting 300 ms before the first onset fixes it.
 */
export function leadingSilenceMs(pcm: Int16Array): number {
  const levels = levelsFromPcm(pcm)
  const onsets = onsetsFromLevels(levels)
  let first = onsets[0]
  // A live window starts where the last committed word ended, which can be a
  // few frames early: a short leftover of that word, then the pause. Skip it.
  const next = onsets[1]
  if (first === 0 && next !== undefined) {
    const threshold = noiseFloorDb(levels) + 10
    const tail = levels.slice(LEFTOVER_MS / 10, next / 10)
    if (tail.length * 10 >= LEFTOVER_GAP_MS && tail.every((l) => l < threshold)) first = next
  }
  return first === undefined ? 0 : Math.max(0, first - LEAD_IN_MS)
}

/** Only move a start this far (whisper's segment-start guess vs the real onset). */
export const SNAP_MAX_MS = 500
const SNAP_PAUSE_MS = 150

/**
 * Whisper times the first word of a segment at the segment's start, which is
 * often the end of the preceding silence rather than where speech begins
 * (JFK: "And" at 0.00 s vs 0.32 s). For words after a pause, move the start
 * forward to an energy onset inside the word (≤ 500 ms later, before its
 * end). Never earlier, never past the word.
 */
export function snapToOnsets(words: SpeechWord[], onsetsMs: number[]): SpeechWord[] {
  return words.map((w, i) => {
    const prev = words[i - 1]
    if (prev && w.startMs - prev.endMs < SNAP_PAUSE_MS) return w
    const onset = onsetsMs.find(
      (o) => o > w.startMs && o <= w.startMs + SNAP_MAX_MS && o < w.endMs - 20,
    )
    return onset === undefined ? w : { ...w, startMs: onset }
  })
}
