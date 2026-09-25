// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleTrack } from '@sublight/core'
import type { JobCreation, JobSummary, ModelInfo } from '@sublight/protocol'
import { engine } from '../lib/engine'
import { DB_NAME, __resetDbForTests } from '../lib/idb'
import { parseGlossary } from '../components/TranslateForm'
import { useCaptionStore } from './caption'
import { socket, useEngineStore } from './engine'
import { activeTrackOf, usePlayerStore } from './player'

const HASH = `sha256:${'b'.repeat(64)}`
const done = (): JobSummary => ({
  id: 'j',
  type: 'translate',
  state: 'done',
  progress: 1,
  priority: 'batch',
  createdAt: 1,
  updatedAt: 1,
})

const model = (
  id: string,
  role: ModelInfo['role'],
  installed: boolean,
  tasks?: ModelInfo['tasks'],
): ModelInfo => ({
  id,
  role,
  name: id,
  sizeBytes: 1,
  vramClass: null,
  license: 'x',
  installed,
  state: installed ? 'installed' : 'not-installed',
  progress: null,
  ...(tasks ? { tasks } : {}),
})

const german: SubtitleTrack = {
  id: 'de-track',
  projectId: '',
  language: 'de',
  kind: 'transcript',
  cues: [
    {
      id: 'c',
      startMs: 0,
      endMs: 1000,
      text: 'Hallo',
      words: [{ word: 'Hallo', startMs: 0, endMs: 900 }],
    },
  ],
  createdAt: 1,
}

async function projectWithGerman() {
  await usePlayerStore.getState().openWithFile(new File(['v'], 'film.mp4', { type: 'video/mp4' }))
  await usePlayerStore.getState().addGeneratedTrack(german)
  await usePlayerStore.getState().setMediaHash(HASH)
}

function stubResult(track: Partial<SubtitleTrack>) {
  vi.spyOn(engine, 'result').mockResolvedValue({
    id: 'j',
    state: 'done',
    tracks: [{ ...german, id: 'out', kind: 'translation', language: 'en', ...track }],
    translation: { paragraphs: 1, lowConfidenceCues: 0, tokensPerSecond: 21.5 },
  })
}

describe('translate flow (M04, Spec 07 §2.0 routing)', () => {
  beforeEach(async () => {
    __resetDbForTests()
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = req.onerror = req.onblocked = () => r()
    })
    URL.createObjectURL = vi.fn(() => 'blob:x') as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
    usePlayerStore.setState({
      view: { name: 'library' },
      project: null,
      videoObjectUrl: null,
      videoFile: null,
      error: null,
    })
    useCaptionStore.getState().reset()
    vi.spyOn(socket, 'subscribe').mockImplementation(() => {})
    vi.spyOn(engine, 'mediaInfo').mockResolvedValue({ mediaHash: HASH, durationMs: 1000 })
  })
  afterEach(() => vi.restoreAllMocks())

  it('translates to English from the audio with Whisper when it can', async () => {
    useEngineStore.setState({
      models: [
        model('whisper-small', 'asr', true, ['transcribe', 'translate']),
        model('qwen3-4b-instruct', 'translate', false),
      ],
    })
    await projectWithGerman()
    const create = vi.spyOn(engine, 'createJob').mockResolvedValue(done())
    stubResult({ derivedFrom: { sourceLanguage: 'de' } })
    await useCaptionStore
      .getState()
      .translate('de-track', { targetLang: 'en', style: 'neutral', glossary: [] })
    expect(create.mock.calls[0]![0]).toMatchObject({
      type: 'transcribe',
      mediaHash: HASH,
      params: { task: 'translate', language: 'de' },
    })
    // The Whisper track comes from audio; the player links it to its source track.
    const added = activeTrackOf(usePlayerStore.getState().project!)!
    expect(added.derivedFrom).toEqual({ trackId: 'de-track', sourceLanguage: 'de' })
  })

  it('uses the local model for other languages, without word timings in the request', async () => {
    useEngineStore.setState({
      models: [
        model('whisper-small', 'asr', true, ['transcribe', 'translate']),
        model('qwen3-4b-instruct', 'translate', true),
      ],
    })
    await projectWithGerman()
    const create = vi.spyOn(engine, 'createJob').mockResolvedValue(done())
    stubResult({ language: 'fr' })
    const glossary = [{ source: 'Gregor', target: 'Grégoire' }]
    await useCaptionStore
      .getState()
      .translate('de-track', { targetLang: 'fr', style: 'formal', glossary })
    const body = create.mock.calls[0]![0] as Extract<JobCreation, { type: 'translate' }>
    expect(body).toMatchObject({
      type: 'translate',
      model: 'qwen3-4b-instruct',
      targetLang: 'fr',
      style: 'formal',
      glossary,
    })
    expect(body.track.cues[0]).not.toHaveProperty('words')
    expect(useCaptionStore.getState().resultNote).toBe('1 cues · fr · 21.5 tokens/s')
  })

  it('uses the local model for English too when a glossary is given', async () => {
    useEngineStore.setState({
      models: [
        model('whisper-small', 'asr', true, ['transcribe', 'translate']),
        model('qwen3-4b-instruct', 'translate', true),
      ],
    })
    await projectWithGerman()
    const create = vi.spyOn(engine, 'createJob').mockResolvedValue(done())
    stubResult({})
    await useCaptionStore.getState().translate('de-track', {
      targetLang: 'en',
      style: 'neutral',
      glossary: [{ source: 'a', target: 'b' }],
    })
    expect(create.mock.calls[0]![0]).toMatchObject({ type: 'translate' })
  })

  it('asks to install the translation model when it is missing', async () => {
    useEngineStore.setState({ models: [model('qwen3-4b-instruct', 'translate', false)] })
    await projectWithGerman()
    const create = vi.spyOn(engine, 'createJob')
    await useCaptionStore
      .getState()
      .translate('de-track', { targetLang: 'fr', style: 'neutral', glossary: [] })
    expect(create).not.toHaveBeenCalled()
    expect(useCaptionStore.getState().error).toMatchObject({ code: 'MODEL_NOT_INSTALLED' })
  })

  it('pairs a translation with its source for bilingual display, and unpairs on removal', async () => {
    await projectWithGerman()
    await usePlayerStore.getState().addGeneratedTrack({
      ...german,
      id: 'fr-track',
      language: 'fr',
      kind: 'translation',
      derivedFrom: { trackId: 'de-track', sourceLanguage: 'de' },
    })
    await usePlayerStore
      .getState()
      .setBilingual({ sourceTrackId: 'de-track', translationTrackId: 'fr-track' })
    const p = usePlayerStore.getState().project!
    expect(p.settings.bilingual).toEqual({
      sourceTrackId: 'de-track',
      translationTrackId: 'fr-track',
    })
    expect(p.settings.activeTrackId).toBe('fr-track')
    await usePlayerStore.getState().removeTrack('de-track')
    expect(usePlayerStore.getState().project!.settings.bilingual).toBeNull()
  })
})

describe('glossary text', () => {
  it('parses "source = target" lines and skips incomplete ones', () => {
    expect(parseGlossary('Gregor = Grégoire\nSamsa→Samsa\nbroken line\n = x')).toEqual([
      { source: 'Gregor', target: 'Grégoire' },
      { source: 'Samsa', target: 'Samsa' },
    ])
  })
})
