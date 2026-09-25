import { describe, expect, it } from 'vitest'
import { chooseTranslationPath, isEnglish, type TranscribeJob } from '../src/index'

describe('translation routing (Spec 07 §2.0, ADR-0018)', () => {
  it('sends English targets with audio to Whisper translate', () => {
    expect(chooseTranslationPath({ targetLang: 'en', hasAudio: true })).toBe('whisper-translate')
    expect(chooseTranslationPath({ targetLang: 'en-GB', hasAudio: true })).toBe('whisper-translate')
  })

  it('uses the LLM for non-English targets', () => {
    expect(chooseTranslationPath({ targetLang: 'de', hasAudio: true })).toBe('llm')
    expect(chooseTranslationPath({ targetLang: 'eo', hasAudio: true })).toBe('llm')
  })

  it('uses the LLM for text-only tracks and glossary/register requests', () => {
    expect(chooseTranslationPath({ targetLang: 'en', hasAudio: false })).toBe('llm')
    expect(
      chooseTranslationPath({ targetLang: 'en', hasAudio: true, wantsGlossaryOrStyle: true }),
    ).toBe('llm')
  })

  it('recognizes English tags only', () => {
    expect(isEnglish(' EN ')).toBe(true)
    expect(isEnglish('eng')).toBe(false)
    expect(isEnglish('es')).toBe(false)
  })

  it('types a Whisper translate job as a transcribe job with task "translate"', () => {
    const job: TranscribeJob = {
      type: 'transcribe',
      mediaHash: 'sha256:abc',
      model: 'whisper-small',
      params: { language: null, task: 'translate', maxCueDurationMs: 7000 },
    }
    expect(job.params.task).toBe('translate')
  })
})
