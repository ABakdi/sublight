// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { ModelInfo } from '@sublight/protocol'
import { useEngineStore } from '../store/engine'
import { ModelsPanel } from './ModelsPanel'

const model = (
  id: string,
  role: ModelInfo['role'],
  sizeGb: number,
  installed: boolean,
): ModelInfo => ({
  id,
  role,
  name: id,
  sizeBytes: sizeGb * 1024 ** 3,
  vramClass: null,
  license: 'MIT',
  installed,
  state: installed ? 'installed' : 'not-installed',
  progress: null,
})

describe('ModelsPanel (M06.8)', () => {
  it('shows disk use, blocks installs that won’t fit, and confirms before removing', () => {
    const removeModel = vi.fn(async () => {})
    useEngineStore.setState({
      status: 'online',
      refreshModels: async () => {},
      removeModel,
      models: [model('whisper-small', 'asr', 0.5, true), model('big-llm', 'translate', 3, false)],
      disk: { usedBytes: 0.5 * 1024 ** 3, freeBytes: 3.5 * 1024 ** 3 },
      modelError: null,
    })
    render(createElement(ModelsPanel))
    expect(screen.getByTestId('models-disk').textContent).toMatch(/512 MB.*3\.5 GB free/)
    expect(screen.getByTestId('models-low-disk')).toBeTruthy()
    // 3 GB + 1 GB headroom > 3.5 GB free
    expect((screen.getByTestId('model-install-big-llm') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('model-remove-whisper-small'))
    expect(removeModel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('model-remove-yes-whisper-small'))
    expect(removeModel).toHaveBeenCalledWith('whisper-small')
  })
})
