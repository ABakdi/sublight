import { toPcm16k, TARGET_RATE } from './pcm'

export interface PcmCapture {
  stop(): void
}

export interface CaptureOptions {
  /** Also play the audio (tabCapture mutes the tab for the user otherwise). */
  monitor: boolean
  /** ~1 s of 16 kHz PCM and the wall-clock time its first sample was heard. */
  onChunk(pcm: Int16Array, wallMs: number): void
  chunkMs?: number
}

/**
 * Tap a MediaStream's audio (Spec 08 §2, the CapturedAudio contract): Web
 * Audio → 16 kHz mono s16 chunks stamped with wall-clock capture time, which
 * the engine maps to media time through playback anchors. ScriptProcessor is
 * deprecated but needs no separately loaded worklet module, which content
 * scripts can't easily provide.
 */
export function startPcmCapture(stream: MediaStream, opts: CaptureOptions): PcmCapture {
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 2, 2)
  const chunkSamples = Math.round(((opts.chunkMs ?? 1000) * TARGET_RATE) / 1000)
  let pending: Int16Array[] = []
  let pendingLen = 0
  let chunkWall = 0

  proc.onaudioprocess = (e) => {
    const input = e.inputBuffer
    const channels = Array.from({ length: input.numberOfChannels }, (_, c) =>
      input.getChannelData(c),
    )
    // This buffer was heard `duration + latency` ago.
    const heardAt = Date.now() - (input.duration + (ctx.baseLatency || 0)) * 1000
    const pcm = toPcm16k(channels, input.sampleRate)
    if (pendingLen === 0) chunkWall = heardAt
    pending.push(pcm)
    pendingLen += pcm.length
    if (pendingLen >= chunkSamples) {
      const out = new Int16Array(pendingLen)
      let o = 0
      for (const p of pending) {
        out.set(p, o)
        o += p.length
      }
      pending = []
      pendingLen = 0
      opts.onChunk(out, Math.round(chunkWall))
    }
    // Output silence from the processor itself; monitoring goes direct.
    for (let c = 0; c < e.outputBuffer.numberOfChannels; c++)
      e.outputBuffer.getChannelData(c).fill(0)
  }

  source.connect(proc)
  // A ScriptProcessor only runs while connected to the destination; it outputs silence.
  proc.connect(ctx.destination)
  if (opts.monitor) source.connect(ctx.destination)

  return {
    stop() {
      proc.onaudioprocess = null
      source.disconnect()
      proc.disconnect()
      void ctx.close()
      // Braces matter: with `monitor` constant-folded to false, Rollup turned
      // `for (…) if (opts.monitor) t.stop()` into a for loop with no body.
      if (opts.monitor) {
        stream.getAudioTracks().forEach((t) => t.stop())
      }
    },
  }
}
