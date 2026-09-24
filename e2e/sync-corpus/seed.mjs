#!/usr/bin/env node
/**
 * Staging seeder for the sync corpus (M00.8) — deterministic fixtures.
 *
 * The engine's real ASR job (M03) will write `transcripts/<id>.cues.json`
 * from actual recordings. Until then this script generates *plausible*
 * ASR-shaped output for every clip that has word-level ground truth in
 * `corpus.json` (en-001 today), so `pnpm sync:measure` can be exercised with
 * real numbers: median onset error, word coverage, drift.
 *
 * Drift is modeled with a seeded PRNG (mulberry32) over a fixed offset
 * pattern, plus a sprinkling of dropped short function words — reproducible
 * on every run, and enough variation to move all three metrics.
 *
 * Run with: pnpm seed:staging
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const corpus = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8'))
const outDir = join(here, 'transcripts')
mkdirSync(outDir, { recursive: true })

/** Base per-word onset offsets (ms), cycled over each cue. */
const OFFSET_PATTERN = [-18, 35, 12, -25, 40, 18, -30, 22, 45, -12, 30]

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashId(id) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const rng = mulberry32(hashId('sublight-sync-staging'))

let seeded = 0
for (const clip of corpus.clips ?? []) {
  const cues = clip.expectedCues ?? []
  const hasWordGroundTruth = cues.some((cue) => (cue.words ?? []).length > 0)
  if (!hasWordGroundTruth) continue

  const asrCues = cues
    .map((cue) => {
      const words = (cue.words ?? [])
        .map((word, i) => {
          const offset = OFFSET_PATTERN[i % OFFSET_PATTERN.length] + Math.round((rng() - 0.5) * 12)
          const jitter = Math.round((rng() - 0.5) * 20)
          const drop = word.word.length <= 2 && rng() < 0.35
          if (drop) return null
          return {
            word: word.word,
            startMs: Math.max(0, word.startMs + offset),
            endMs: Math.max(0, word.endMs + offset + jitter),
          }
        })
        .filter((word) => word !== null)
      if (words.length === 0) return null
      return {
        startMs: words[0].startMs,
        endMs: words[words.length - 1].endMs,
        text: words.map((word) => word.word).join(' '),
        words,
      }
    })
    .filter((cue) => cue !== null)

  const path = join(outDir, `${clip.id}.cues.json`)
  writeFileSync(
    path,
    JSON.stringify(
      {
        clipId: clip.id,
        generator: 'seed.mjs — staging fixture; engine ASR output lands in M03',
        cues: asrCues,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  seeded += 1
  console.log(
    `seeded ${clip.id} (${asrCues.length} cue(s), ${asrCues.reduce((n, c) => n + c.words.length, 0)} word(s))`,
  )
}

console.log(
  `staging seed complete: ${seeded}/${corpus.clips?.length ?? 0} clips have transcripts in ${outDir}`,
)
