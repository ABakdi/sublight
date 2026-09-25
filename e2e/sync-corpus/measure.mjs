#!/usr/bin/env node
/**
 * Sync-accuracy harness (M00.8) — must always print a numeric report.
 *
 * Reads e2e/sync-corpus/corpus.json (ground truth) and, per clip, an optional
 * e2e/sync-corpus/transcripts/<id>.cues.json produced by the engine's ASR job
 * (M03 will write these). Metrics:
 *   - per-word onset offset  = asrWord.startMs - expectedWord.startMs,
 *     matched greedily to the nearest expected word within ±500 ms (word order
 *     preserved);
 *   - median onset error (ms) — the Requirement F4 yardstick (≤ 250 ms);
 *   - word coverage          = fraction of expected words matched;
 *   - drift indicator        = |(last offset) - (first offset)|, guardrail for
 *     the ≤ 500 ms / 2 h budget.
 *
 * With no transcripts yet it prints the corpus overview and "0 clips
 * transcribed" — the acceptance is that the report runs and is numeric.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const corpusPath = join(here, 'corpus.json')

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function round1(n) {
  return n === null ? null : Math.round(n * 10) / 10
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
const clips = corpus.clips ?? []

let transcribed = 0
const rows = []
const allOffsets = []
/** |error| per matched word/onset across all clips. */
const absErrors = []

/**
 * Energy-onset clips (no hand-timed words): pair each reference onset with
 * the nearest ASR word start (after the track's δ) within ±500 ms. Error =
 * word start − onset. Drift = shift of the median error between the first and
 * last fifth of the clip.
 */
function measureOnsets(clip, reference, transcript) {
  const delta = transcript.syncOffsetMs ?? 0
  const starts = (transcript.cues ?? []).flatMap((c) =>
    (c.words ?? []).map((w) => w.startMs + delta),
  )
  const pairs = []
  for (const onset of reference.onsetsMs) {
    let best = null
    for (const s of starts) {
      const d = s - onset
      if (Math.abs(d) <= 500 && (best === null || Math.abs(d) < Math.abs(best))) best = d
    }
    if (best !== null) pairs.push({ at: onset, err: best })
  }
  const errs = pairs.map((p) => p.err)
  const span = reference.onsetsMs.at(-1) ?? 0
  const head = pairs.filter((p) => p.at <= span * 0.2).map((p) => p.err)
  const tail = pairs.filter((p) => p.at >= span * 0.8).map((p) => p.err)
  const drift = head.length && tail.length ? Math.abs(median(tail) - median(head)) : 0
  return {
    id: clip.id,
    language: clip.language,
    recorded: true,
    transcribed: true,
    method: 'energy onsets',
    expectedWords: reference.onsetsMs.length,
    asrWords: starts.length,
    matched: pairs.length,
    medianOnsetErrorMs: round1(median(errs.map(Math.abs))),
    biasMs: round1(median(errs)),
    coverage: pairs.length / Math.max(1, reference.onsetsMs.length),
    driftAcrossClipMs: round1(drift),
    errors: errs,
  }
}

for (const clip of clips) {
  if (clip.reference?.method === 'energy-onsets') {
    const tPath = join(here, 'transcripts', `${clip.id}.cues.json`)
    const rPath = join(here, 'transcripts', `${clip.id}.reference.json`)
    if (!existsSync(tPath) || !existsSync(rPath)) {
      rows.push({
        id: clip.id,
        language: clip.language,
        recorded: true,
        transcribed: false,
        expectedWords: 0,
        method: 'energy onsets',
      })
      continue
    }
    transcribed += 1
    const row = measureOnsets(
      clip,
      JSON.parse(readFileSync(rPath, 'utf8')),
      JSON.parse(readFileSync(tPath, 'utf8')),
    )
    absErrors.push(...row.errors.map(Math.abs))
    rows.push(row)
    continue
  }
  const expectedWords = (clip.expectedCues ?? []).flatMap((c) =>
    (c.words ?? []).map((w) => w.startMs),
  )
  const transcriptPath = join(here, 'transcripts', `${clip.id}.cues.json`)
  if (!existsSync(transcriptPath)) {
    rows.push({
      id: clip.id,
      language: clip.language,
      recorded: clip.recorded,
      transcribed: false,
      expectedWords: expectedWords.length,
    })
    continue
  }
  transcribed += 1
  const asrCues = JSON.parse(readFileSync(transcriptPath, 'utf8')).cues ?? []
  const asrWords = asrCues.flatMap((c) => (c.words ?? []).map((w) => w.startMs))

  // Greedy nearest-match alignment, word order preserved.
  const offsets = []
  let matched = 0
  let j = 0
  for (const expected of expectedWords) {
    while (j < asrWords.length && asrWords[j] < expected - 500) j += 1
    const candidate = asrWords[j]
    if (candidate !== undefined && candidate <= expected + 500 && candidate >= expected - 500) {
      offsets.push(candidate - expected)
      matched += 1
      j += 1
    }
  }
  // Staging examples are synthetic: shown, but never counted as a real result.
  if (!clip.example) {
    allOffsets.push(...offsets)
    absErrors.push(...offsets.map(Math.abs))
  } else transcribed -= 1
  const med = median(offsets)
  const drift = offsets.length > 1 ? Math.abs(offsets[offsets.length - 1] - offsets[0]) : 0
  rows.push({
    id: clip.id,
    language: clip.language,
    recorded: true,
    transcribed: true,
    expectedWords: expectedWords.length,
    asrWords: asrWords.length,
    matched,
    medianOnsetErrorMs: round1(med),
    coverage: matched / Math.max(1, expectedWords.length),
    driftAcrossClipMs: round1(drift),
    example: Boolean(clip.example),
  })
}

const overallMedian = round1(median(absErrors))

console.log('SYNC-ACCURACY CORPUS REPORT')
console.log('----------------------------')
console.log(`corpus: ${clips.length} clips, ${corpus.schema === 1 ? 'schema v1' : 'schema v?'}`)
console.log(
  `thresholds: median onset <= ${corpus.thresholds.maxMedianOnsetErrorMs} ms (F4) | drift <= ${corpus.thresholds.maxDriftMsPer2h} ms/2h`,
)
for (const row of rows) {
  const status = row.transcribed
    ? `${row.example ? 'STAGING EXAMPLE (synthetic, not counted)' : 'transcribed'}${row.method ? ` (${row.method})` : ''}: median |onset error| ${row.medianOnsetErrorMs} ms${row.biasMs !== undefined ? `, bias ${row.biasMs} ms` : ''}, coverage ${Math.round((row.coverage ?? 0) * 100)}% of ${row.expectedWords}, drift ${row.driftAcrossClipMs} ms`
    : row.method
      ? `not run yet (pnpm sync:run, ${row.method} reference)`
      : `not transcribed (${row.recorded ? 'recorded' : 'recording pending'}, ${row.expectedWords} expected words)`
  console.log(`  ${row.id} [${row.language}] — ${status}`)
}
console.log('----------------------------')
console.log(
  `overall: ${transcribed}/${clips.length} clips transcribed; median |word onset error|: ${overallMedian} ms`,
)
if (overallMedian === null) {
  console.log(
    '  no ASR output yet — expected (engine transcription lands in M03); thresholds not evaluated.',
  )
} else {
  const pass = overallMedian <= corpus.thresholds.maxMedianOnsetErrorMs
  console.log(
    `  Requirement F4 (median onset <= ${corpus.thresholds.maxMedianOnsetErrorMs} ms): ${pass ? 'PASS' : 'FAIL'}`,
  )
}
process.exit(0)
