import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

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

/**
 * Speech onsets in ms (Spec 07 §1.4a): the noise floor is the 10th
 * percentile of frame levels; an onset is the first frame at least `riseDb`
 * above it after `minSilenceMs` of frames below that line. Relative to each
 * file's own floor, so room tone and quiet consonants don't shift it.
 */
export function onsetsFromLevels(levels: Float32Array, opts: OnsetOptions = {}): number[] {
  if (levels.length === 0) return []
  const sorted = Float32Array.from(levels).sort()
  const floor = sorted[Math.floor(sorted.length * 0.1)]!
  const threshold = floor + (opts.riseDb ?? 10)
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
