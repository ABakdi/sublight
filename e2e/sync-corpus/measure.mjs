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

for (const clip of clips) {
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
  allOffsets.push(...offsets)
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
  })
}

const overallMedian = round1(median(allOffsets))

console.log('SYNC-ACCURACY CORPUS REPORT')
console.log('----------------------------')
console.log(`corpus: ${clips.length} clips, ${corpus.schema === 1 ? 'schema v1' : 'schema v?'}`)
console.log(
  `thresholds: median onset <= ${corpus.thresholds.maxMedianOnsetErrorMs} ms (F4) | drift <= ${corpus.thresholds.maxDriftMsPer2h} ms/2h`,
)
for (const row of rows) {
  const status = row.transcribed
    ? `transcribed: median onset ${row.medianOnsetErrorMs} ms, coverage ${Math.round((row.coverage ?? 0) * 100)}%, drift ${row.driftAcrossClipMs} ms`
    : `not transcribed (${row.recorded ? 'recorded' : 'recording pending'}, ${row.expectedWords} expected words)`
  console.log(`  ${row.id} [${row.language}] — ${status}`)
}
console.log('----------------------------')
console.log(
  `overall: ${transcribed}/${clips.length} clips transcribed; median word onset error: ${overallMedian} ms`,
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
