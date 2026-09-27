#!/usr/bin/env node
/**
 * How close captions ahead of playback come to one continuous transcription
 * of the same audio (checkpoint tool, docs/checkpoints). The ahead-of-playback
 * job cuts the video into pieces; the reference hears it all at once, so
 * differences show what the cutting costs: words lost or doubled, and timing.
 *
 *   node e2e/checkpoint/timing-vs-reference.mjs <page url> [--model whisper-small] [--language de]
 *
 * Needs the engine running (`sublight-engine start --detach`) with yt-dlp and
 * the model installed; reads the token from ~/.sublight/config.json.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const pageUrl = process.argv[2]
if (!pageUrl || pageUrl.startsWith('--')) {
  console.error('usage: timing-vs-reference.mjs <page url> [--model whisper-small] [--language de]')
  process.exit(1)
}
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const model = arg('--model', 'whisper-small')
const language = arg('--language', null)
const home = process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
const base = `http://127.0.0.1:${config.port ?? 17421}`
const auth = { authorization: `Bearer ${config.token}` }

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...auth, ...init.headers } })
  const body = await res.json()
  if (!res.ok) throw new Error(`${path}: ${body?.error?.message ?? res.status}`)
  return body
}

async function runJob(creation) {
  const job = await api('/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creation),
  })
  const started = Date.now()
  for (;;) {
    const s = await api(`/v1/jobs/${job.id}`)
    if (s.state === 'done') break
    if (['failed', 'cancelled'].includes(s.state))
      throw new Error(`job ${s.state}: ${s.error?.message}`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  const result = await api(`/v1/jobs/${job.id}/result`)
  return { cues: result.tracks[0].cues, seconds: Math.round((Date.now() - started) / 1000) }
}

/** Words with a time: spread evenly over their cue (cues are what the viewer sees). */
function words(cues) {
  const out = []
  for (const c of cues) {
    const list = c.text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean)
    list.forEach((w, i) => {
      const text = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      const t = c.startMs + ((c.endMs - c.startMs) * (i + 0.5)) / list.length
      if (text) out.push({ text, t })
    })
  }
  return out
}

/** Longest common subsequence alignment: matched pairs, and counts of the rest. */
function align(ref, got) {
  const n = ref.length
  const m = got.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        ref[i].text === got[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ref[i].text === got[j].text) pairs.push([ref[i++], got[j++]])
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return { pairs, missing: n - pairs.length, extra: m - pairs.length }
}

// The reference: the whole audio, uploaded and transcribed in one job.
const dir = mkdtempSync(join(tmpdir(), 'sublight-timing-'))
execFileSync(
  join(home, 'bin', 'yt-dlp'),
  [
    '-q',
    '--no-warnings',
    '--js-runtimes',
    `node:${process.execPath}`,
    '-f',
    'bestaudio',
    '-o',
    join(dir, 'audio.%(ext)s'),
    '--',
    pageUrl,
  ],
  { stdio: 'inherit' },
)
const file = join(dir, readdirSync(dir)[0])
const uploaded = await api('/v1/media/timing-reference', {
  method: 'PUT',
  headers: { 'x-source-name': 'reference' },
  body: readFileSync(file),
})
const reference = await runJob({
  type: 'transcribe',
  mediaHash: uploaded.mediaHash,
  model,
  params: { language, maxCueDurationMs: 7000 },
})
const ahead = await runJob({ type: 'url', pageUrl, model, params: { language } })

const ref = words(reference.cues)
const got = words(ahead.cues)
const { pairs, missing, extra } = align(ref, got)
const errors = pairs.map(([a, b]) => Math.abs(a.t - b.t)).sort((a, b) => a - b)
const q = (p) =>
  (errors[Math.min(errors.length - 1, Math.floor(errors.length * p))] / 1000).toFixed(2)
console.log(
  JSON.stringify(
    {
      pageUrl,
      model,
      referenceWords: ref.length,
      aheadWords: got.length,
      missing,
      extra,
      timingErrorSeconds: { median: Number(q(0.5)), p90: Number(q(0.9)), max: Number(q(1)) },
      wordsOffMoreThan2s: errors.filter((e) => e > 2000).length,
      jobSeconds: { reference: reference.seconds, ahead: ahead.seconds },
    },
    null,
    2,
  ),
)
