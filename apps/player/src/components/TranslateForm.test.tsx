// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { SubtitleTrack } from '@sublight/core'
import { useEngineStore } from '../store/engine'
import { usePlayerStore } from '../store/player'
import { TranslateForm } from './TranslateForm'

const track: SubtitleTrack = {
  id: 'en',
  projectId: 'p',
  language: 'en',
  kind: 'import',
  cues: [{ id: 'c', startMs: 0, endMs: 1000, text: 'Hello' }],
  createdAt: 1,
}

describe('TranslateForm', () => {
  it('renders without a render loop and offers the model install for French', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:x') as unknown as typeof URL.createObjectURL
    await usePlayerStore.getState().openWithFile(new File(['v'], 'v.mp4'))
    useEngineStore.setState({
      status: 'online',
      models: [
        {
          id: 'qwen3-4b-instruct',
          role: 'translate',
          name: 'Qwen3',
          sizeBytes: 2497280736,
          vramClass: null,
          license: 'Apache-2.0',
          installed: false,
          state: 'not-installed',
          progress: null,
        },
      ],
    })
    render(createElement(TranslateForm, { track }))
    expect(await screen.findByTestId('translate-target')).toBeTruthy()
    expect(screen.getByTestId('translate-route').getAttribute('data-path')).toBe('llm')
    expect(screen.getByTestId('install-llm').textContent).toContain('2382 MB')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
