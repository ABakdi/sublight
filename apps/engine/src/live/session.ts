import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import type { SpeechWord } from '@sublight/core'
import type { LiveAnchor } from '@sublight/protocol'

export const SAMPLE_RATE = 16000
const MS_PER_SAMPLE = 1000 / SAMPLE_RATE

interface ChunkIndex {
  /** First sample of the chunk in the session's sample stream. */
  sample: number
  samples: number
  /** Wall-clock time of the chunk's first sample (client clock = engine clock, same machine). */
  wallMs: number
}

/**
 * One live capture (Spec 08 §2-§5): the PCM stream as it arrives (appended
 * to a scratch file so hours of audio don't sit in memory), when each chunk
 * was captured, and the playback anchors that map capture time to media
 * time. Pure bookkeeping: the runner decides when to transcribe.
 */
export class LiveSession {
  private readonly fd: number
  private chunks: ChunkIndex[] = []
  private anchors: LiveAnchor[] = []
  private total = 0
  /** Last time audio arrived (engine clock), for the idle timeout. */
  lastAudioAt = Date.now()
  stopping = false

  constructor(private readonly file: string) {
    this.fd = openSync(file, 'w+')
  }

  get totalSamples(): number {
    return this.total
  }

  get receivedMs(): number {
    return this.total * MS_PER_SAMPLE
  }

  /** Append one chunk of 16 kHz mono s16le PCM captured starting at `wallMs`. */
  append(pcm: Buffer, wallMs: number): void {
    const samples = Math.floor(pcm.length / 2)
    if (samples === 0) return
    writeSync(this.fd, pcm, 0, samples * 2, this.total * 2)
    this.chunks.push({ sample: this.total, samples, wallMs })
    this.total += samples
    this.lastAudioAt = Date.now()
  }

  /** Samples [from, to) as Int16. */
  read(from: number, to: number): Int16Array {
    const start = Math.max(0, from)
    const end = Math.min(this.total, to)
    const buf = Buffer.alloc(Math.max(0, end - start) * 2)
    if (buf.length) readSync(this.fd, buf, 0, buf.length, start * 2)
    return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2)
  }

  /** Wall-clock time of a sample, interpolated inside its chunk. */
  wallAt(sample: number): number {
    if (this.chunks.length === 0) return 0
    let lo = 0
    let hi = this.chunks.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.chunks[mid]!.sample <= sample) lo = mid
      else hi = mid - 1
    }
    const c = this.chunks[lo]!
    return c.wallMs + (sample - c.sample) * MS_PER_SAMPLE
  }

  /** First sample captured at or after `wallMs`. */
  sampleAtWall(wallMs: number): number {
    for (const c of this.chunks) {
      const end = c.wallMs + c.samples * MS_PER_SAMPLE
      if (wallMs < c.wallMs) return c.sample
      if (wallMs < end) return c.sample + Math.floor((wallMs - c.wallMs) / MS_PER_SAMPLE)
    }
    return this.total
  }

  anchor(a: LiveAnchor): void {
    // Anchors can arrive slightly out of order (separate requests); keep them sorted.
    this.anchors.push(a)
    this.anchors.sort((x, y) => x.wallMs - y.wallMs)
  }

  get anchorList(): readonly LiveAnchor[] {
    return this.anchors
  }

  /** Media time (video position) at a wall-clock instant, or null before the first anchor. */
  mediaAtWall(wallMs: number): number | null {
    let a: LiveAnchor | undefined
    for (const x of this.anchors) {
      if (x.wallMs <= wallMs) a = x
      else break
    }
    a ??= this.anchors[0]
    if (!a) return null
    return a.playing ? a.mediaMs + (wallMs - a.wallMs) * a.rate : a.mediaMs
  }

  /** Is the video playing at this instant? (Paused audio is silence and never transcribed.) */
  playingAtWall(wallMs: number): boolean {
    let a: LiveAnchor | undefined
    for (const x of this.anchors) {
      if (x.wallMs <= wallMs) a = x
      else break
    }
    return a?.playing ?? true
  }

  /**
   * Words timed relative to sample `from` → media time. Words that land in a
   * paused stretch, or before the first anchor, are dropped.
   */
  toMedia(words: SpeechWord[], from: number): SpeechWord[] {
    const out: SpeechWord[] = []
    for (const w of words) {
      const startWall = this.wallAt(from + Math.round(w.startMs / MS_PER_SAMPLE))
      const endWall = this.wallAt(from + Math.round(w.endMs / MS_PER_SAMPLE))
      if (!this.playingAtWall(startWall)) continue
      const start = this.mediaAtWall(startWall)
      const end = this.mediaAtWall(endWall)
      if (start === null || end === null) continue
      out.push({ ...w, startMs: Math.round(start), endMs: Math.round(Math.max(end, start + 10)) })
    }
    return out
  }

  /**
   * Contiguous playing stretches of captured audio, as sample ranges, split at
   * every anchor (seek, pause, rate change): the unit of the refinement pass.
   */
  playingSegments(): { from: number; to: number }[] {
    const cuts = new Set<number>([0, this.total])
    for (const a of this.anchors) cuts.add(Math.min(this.total, this.sampleAtWall(a.wallMs)))
    const points = [...cuts].sort((a, b) => a - b)
    const out: { from: number; to: number }[] = []
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]!
      const to = points[i + 1]!
      if (to - from < SAMPLE_RATE / 2) continue
      if (this.playingAtWall(this.wallAt(from) + 1)) out.push({ from, to })
    }
    return out
  }

  close(): void {
    try {
      closeSync(this.fd)
    } catch {
      // already closed
    }
    rmSync(this.file, { force: true })
  }
}

/** RMS level of PCM in dBFS (−120 for digital silence). */
export function levelDb(pcm: Int16Array): number {
  if (pcm.length === 0) return -120
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!
  const rms = Math.sqrt(sum / pcm.length) / 32768
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

/** Minimal 16 kHz mono s16le WAV around raw samples, for whisper-server. */
export function wavBytes(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Split window words into committed and tentative (Spec 08 §5): a word is
 * stable once it ends more than `holdMs` before the newest audio, since
 * whisper still revises the last few seconds as more context arrives.
 */
export function splitStable(
  words: SpeechWord[],
  windowMs: number,
  holdMs: number,
): { committed: SpeechWord[]; tentative: SpeechWord[] } {
  const cut = windowMs - holdMs
  const idx = words.findIndex((w) => w.endMs > cut)
  return idx === -1
    ? { committed: words, tentative: [] }
    : { committed: words.slice(0, idx), tentative: words.slice(idx) }
}
