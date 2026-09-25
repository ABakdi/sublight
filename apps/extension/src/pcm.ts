/** Engine audio format (Spec 08 §2): 16 kHz mono signed 16-bit little-endian. */
export const TARGET_RATE = 16000

/**
 * Downmix to mono and resample to 16 kHz by averaging each output sample's
 * source span (a cheap low-pass, enough for speech), then clip to s16.
 */
export function toPcm16k(channels: Float32Array[], inputRate: number): Int16Array {
  const n = channels[0]?.length ?? 0
  if (n === 0) return new Int16Array(0)
  const ratio = inputRate / TARGET_RATE
  const outLen = Math.floor(n / ratio)
  const out = new Int16Array(outLen)
  for (let o = 0; o < outLen; o++) {
    const from = Math.floor(o * ratio)
    const to = Math.max(from + 1, Math.floor((o + 1) * ratio))
    let sum = 0
    for (let i = from; i < to && i < n; i++) {
      let s = 0
      for (const ch of channels) s += ch[i]!
      sum += s / channels.length
    }
    const v = sum / (to - from)
    out[o] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
  }
  return out
}

/** Runtime messages are JSON: raw bytes travel as base64. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** RMS level of s16 PCM in dBFS (−120 for silence). */
export function levelDb(pcm: Int16Array): number {
  if (!pcm.length) return -120
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!
  const rms = Math.sqrt(sum / pcm.length) / 32768
  return rms > 0 ? 20 * Math.log10(rms) : -120
}
