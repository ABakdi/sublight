import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateCues, type SubtitleTrack } from '@sublight/core'
import { loadConfig, sublightHome } from '../src/config'
import { enginePaths } from '../src/paths'
import { createServices, runtimeBinary } from '../src/services'

/**
 * Real translation through the pinned llama-server + Qwen3-4B (M04). Runs
 * only where `pnpm engine:setup-llama` built the binary and the model is
 * installed in ~/.sublight/models — skipped in CI.
 */
const realPaths = enginePaths(sublightHome())
const config = loadConfig({
  llama: { port: 17497, gpu: 'auto', threads: 4, contextTokens: 4096 },
  whisper: { port: 17496, gpu: 'auto', threads: 4 },
})
const ready =
  existsSync(runtimeBinary('llama', config, realPaths).binary) &&
  existsSync(join(realPaths.models, 'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf'))

const jfk: SubtitleTrack = {
  id: 'jfk',
  projectId: 'test',
  language: 'en',
  kind: 'transcript',
  createdAt: 1,
  cues: [
    { id: '1', startMs: 320, endMs: 2110, text: 'And so my fellow Americans,' },
    { id: '2', startMs: 3490, endMs: 4300, text: 'ask not' },
    { id: '3', startMs: 5030, endMs: 7970, text: 'what your country can do for you,' },
    { id: '4', startMs: 8190, endMs: 10990, text: 'ask what you can do for your country.' },
  ],
}

describe.skipIf(!ready)('real translation with Qwen3-4B', () => {
  const paths = {
    ...enginePaths(mkdtempSync(join(tmpdir(), 'sublight-tr-'))),
    models: realPaths.models,
    bin: realPaths.bin,
  }
  const services = createServices(config, paths)
  services.jobs.start()
  afterAll(() => services.llama.stop())

  it('translates English to German line by line, keeping the timings', async () => {
    const job = services.jobs.create({
      type: 'translate',
      track: jfk,
      model: 'qwen3-4b-instruct',
      targetLang: 'de',
      glossary: [{ source: 'Americans', target: 'Amerikaner' }],
      style: 'formal',
    })
    for (
      let i = 0;
      i < 900 && !['done', 'failed'].includes(services.jobs.get(job.id)!.state);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 200))
    }
    const summary = services.jobs.get(job.id)!
    expect(summary.error).toBeUndefined()
    const result = services.jobs.result(job.id)!
    const out = result.tracks[0]!
    expect(out.cues.map((c) => [c.startMs, c.endMs])).toEqual(
      jfk.cues.map((c) => [c.startMs, c.endMs]),
    )
    expect(validateCues(out.cues).valid).toBe(true)
    expect(result.translation!.lowConfidenceCues).toBe(0)
    // Wording varies (Land / Vaterland / Staat…); check language and glossary, not phrasing.
    expect(out.cues.every((c) => c.text.trim().length > 0)).toBe(true)
    const text = out.cues.map((c) => c.text).join(' ')
    expect(text).toMatch(/Amerikaner/)
    expect(text).toMatch(/\b(nicht|was|dein|Ihr|euer|für)\b/i)
    expect(text).not.toMatch(/\b(what|your|country)\b/i)
  }, 180_000)
})
