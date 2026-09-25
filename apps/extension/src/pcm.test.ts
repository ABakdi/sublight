import { describe, expect, it } from 'vitest'
import { base64ToBytes, levelDb, pcmToBase64, toPcm16k } from './pcm'

describe('pcm conversion (Spec 08 §2)', () => {
  it('downsamples 48 kHz stereo to 16 kHz mono', () => {
    const n = 4800 // 100 ms
    const l = new Float32Array(n).fill(0.5)
    const r = new Float32Array(n).fill(-0.5)
    const pcm = toPcm16k([l, r], 48000)
    expect(pcm).toHaveLength(1600)
    expect(Math.abs(pcm[10]!)).toBeLessThanOrEqual(1) // L and R cancel out
    expect(toPcm16k([l], 48000)[0]).toBe(Math.round(0.5 * 32767))
  })

  it('handles 44.1 kHz and clips out-of-range samples', () => {
    const pcm = toPcm16k([new Float32Array(4410).fill(2)], 44100)
    expect(pcm).toHaveLength(1600)
    expect(pcm[0]).toBe(32767)
  })

  it('round-trips through base64 for runtime messages', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 1234])
    const bytes = base64ToBytes(pcmToBase64(pcm))
    expect(Array.from(new Int16Array(bytes.buffer))).toEqual(Array.from(pcm))
  })

  it('reports silence and signal levels', () => {
    expect(levelDb(new Int16Array(100))).toBe(-120)
    expect(levelDb(new Int16Array(100).fill(16384))).toBeCloseTo(-6.02, 1)
  })
})
