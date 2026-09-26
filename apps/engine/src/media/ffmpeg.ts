import { spawn } from 'node:child_process'

export interface FfmpegBinaries {
  ffmpeg: string
  ffprobe: string
}

export const SYSTEM_FFMPEG: FfmpegBinaries = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run a process to completion, killing it after `timeoutMs`. */
export function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export interface ProbeResult {
  durationMs: number | null
  hasAudio: boolean
  audioCodec: string | null
  channels: number | null
}

/** ffprobe the container: duration + first audio stream (Spec 06 §4). */
export async function probe(bin: FfmpegBinaries, file: string): Promise<ProbeResult> {
  const r = await run(
    bin.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    60_000,
  )
  if (r.code !== 0) return { durationMs: null, hasAudio: false, audioCodec: null, channels: null }
  const json = JSON.parse(r.stdout) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; codec_name?: string; channels?: number }[]
  }
  const audio = json.streams?.find((s) => s.codec_type === 'audio')
  const seconds = Number(json.format?.duration)
  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    channels: audio?.channels ?? null,
  }
}

/** Any container/codec → 16 kHz mono s16 PCM WAV, Whisper's native input. */
export async function normalizeToWav(
  bin: FfmpegBinaries,
  input: string,
  output: string,
  timeoutMs: number,
): Promise<void> {
  const r = await run(
    bin.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      output,
    ],
    timeoutMs,
  )
  if (r.code !== 0)
    throw new Error(`ffmpeg normalize failed: ${r.stderr.trim().split('\n').pop() ?? r.code}`)
}

/** Mean volume in dB (volumedetect); -Infinity for digital silence. */
export async function meanVolumeDb(bin: FfmpegBinaries, file: string): Promise<number> {
  const r = await run(
    bin.ffmpeg,
    ['-nostdin', '-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    600_000,
  )
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr)
  if (!m) return Number.NEGATIVE_INFINITY
  return m[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[1])
}

/** Cut [startMs, startMs+durationMs) out of a normalized WAV (sample-exact, no re-encode needed). */
export async function sliceWav(
  bin: FfmpegBinaries,
  input: string,
  output: string,
  startMs: number,
  durationMs: number,
): Promise<void> {
  const r = await run(
    bin.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      input,
      '-c:a',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      output,
    ],
    120_000,
  )
  if (r.code !== 0)
    throw new Error(`ffmpeg slice failed: ${r.stderr.trim().split('\n').pop() ?? r.code}`)
}
