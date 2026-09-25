#!/usr/bin/env node
/**
 * Run the sync corpus through a running engine (M03.5).
 *
 *   pnpm sync:run [--model whisper-small] [--only <clipId>]
 *
 * For each clip with an `audio` source (a repo path, or `remote` with a
 * pinned SHA-256, downloaded once into ~/.sublight/corpus-cache), this
 * uploads the audio, runs a transcribe job and writes
 * transcripts/<id>.cues.json. Clips whose reference is `energy-onsets` also
 * get transcripts/<id>.reference.json: speech onsets after pauses from
 * ffmpeg `silencedetect` (a different detector from the engine's own δ
 * estimator, so the check stays independent). Then run `pnpm sync:measure`.
 *
 * Needs the engine running with the model installed; the token comes from
 * SUBLIGHT_TOKEN or ~/.sublight/config.json.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const corpus = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8'))
const home = process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
const cacheDir = join(home, 'corpus-cache')
const engineUrl = process.env.SUBLIGHT_ENGINE_URL ?? 'http://127.0.0.1:17421'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const model = arg('--model') ?? 'whisper-small'
const only = arg('--only')

function token() {
  if (process.env.SUBLIGHT_TOKEN) return process.env.SUBLIGHT_TOKEN
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).token
}
const auth = { Authorization: `Bearer ${token()}` }

async function api(path, init = {}) {
  const res = await fetch(`${engineUrl}${path}`, { ...init, headers: { ...auth, ...init.headers } })
  const body = await res.json()
  if (!res.ok) throw new Error(`${path}: ${body.error?.code} ${body.error?.message}`)
  return body
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Local audio path for a clip: repo file, or a verified cached download. */
async function audioFile(clip) {
  if (clip.audio.path) return resolve(repoRoot, clip.audio.path)
  const { url, sha256: pinned } = clip.audio.remote
  mkdirSync(cacheDir, { recursive: true })
  const target = join(cacheDir, `${pinned}${url.slice(url.lastIndexOf('.'))}`)
  if (existsSync(target) && sha256(target) === pinned) return target
  process.stderr.write(`  downloading ${url}\n`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  writeFileSync(`${target}.part`, Buffer.from(await res.arrayBuffer()))
  const got = sha256(`${target}.part`)
  if (got !== pinned) throw new Error(`checksum mismatch for ${url}: ${got}`)
  renameSync(`${target}.part`, target)
  return target
}

/** Trim to the clip's window with ffmpeg (stream copy) when `trim` is set. */
function trimmed(file, clip) {
  if (!clip.audio.trim) return file
  const { startMs = 0, durationMs } = clip.audio.trim
  const out = join(cacheDir, `${clip.id}.trim${file.slice(file.lastIndexOf('.'))}`)
  if (existsSync(out)) return out
  const r = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-ss',
    String(startMs / 1000),
    '-t',
    String(durationMs / 1000),
    '-i',
    file,
    '-c',
    'copy',
    out,
  ])
  if (r.status !== 0) throw new Error(`ffmpeg trim failed: ${r.stderr}`)
  return out
}

/** Speech onsets after ≥ 300 ms pauses, noise floor relative to the mean volume. */
function energyOnsets(file) {
  const vol = spawnSync(
    'ffmpeg',
    ['-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  )
  const mean = Number(/mean_volume:\s*(-?[\d.]+)/.exec(vol.stderr)?.[1] ?? -30)
  const noise = Math.min(-25, mean - 10).toFixed(1)
  const r = spawnSync(
    'ffmpeg',
    ['-nostdin', '-i', file, '-af', `silencedetect=noise=${noise}dB:d=0.3`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  )
  return [...r.stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) =>
    Math.round(Number(m[1]) * 1000),
  )
}

async function transcribe(clip, file) {
  const mediaId = `corpus-${clip.id}`
  process.stderr.write(`  uploading ${(statSync(file).size / 1e6).toFixed(1)} MB\n`)
  await api(`/v1/media/${mediaId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Readable.toWeb(createReadStream(file)),
    duplex: 'half',
  })
  const job = await api('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'transcribe',
      mediaHash: mediaId,
      model,
      params: { language: clip.language, maxCueDurationMs: 7000 },
    }),
  })
  const t0 = Date.now()
  for (;;) {
    const s = await api(`/v1/jobs/${job.id}`)
    if (s.state === 'done') break
    if (s.state === 'failed' || s.state === 'cancelled')
      throw new Error(`job ${s.state}: ${s.error?.message}`)
    process.stderr.write(`\r  ${s.detail ?? s.state} ${Math.round(s.progress * 100)}%   `)
    await new Promise((r) => setTimeout(r, 1000))
  }
  const result = await api(`/v1/jobs/${job.id}/result`)
  process.stderr.write(`\r  done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`)
  return result
}

const clips = corpus.clips.filter((c) => c.audio && (!only || c.id === only))
if (clips.length === 0) console.log('no clips with audio to run')
for (const clip of clips) {
  console.error(`${clip.id} [${clip.language}]`)
  const file = trimmed(await audioFile(clip), clip)
  const result = await transcribe(clip, file)
  const track = result.tracks[0]
  writeFileSync(
    join(here, 'transcripts', `${clip.id}.cues.json`),
    JSON.stringify({
      clipId: clip.id,
      generator: `engine ${model}`,
      syncOffsetMs: track.syncOffsetMs ?? 0,
      realtimeFactor: result.realtimeFactor ?? null,
      cues: track.cues,
    }) + '\n',
  )
  if (clip.reference?.method === 'energy-onsets') {
    writeFileSync(
      join(here, 'transcripts', `${clip.id}.reference.json`),
      JSON.stringify({
        clipId: clip.id,
        method: 'ffmpeg silencedetect, pauses >= 300 ms',
        onsetsMs: energyOnsets(file),
      }) + '\n',
    )
  }
}
