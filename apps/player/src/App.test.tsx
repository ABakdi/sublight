// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { App } from './App'

beforeEach(() => {
  // No engine in unit tests: health probe fails -> offline badge.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('engine not running')))
})

afterEach(() => {
  cleanup()
})

describe('player shell (M01.3)', () => {
  it('boots to the library with the app title and engine status', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /sublight player/i })).toBeTruthy()
    expect(screen.getByTestId('engine-status')).toBeTruthy()
    expect(screen.getByTestId('open-video')).toBeTruthy()
  })

  it('shows the empty-library state once IndexedDB settles', async () => {
    render(<App />)
    expect(await screen.findByText(/no projects yet/i)).toBeTruthy()
  })

  it('exposes the file input used by e2e and the FSA fallback', () => {
    render(<App />)
    expect(screen.getByTestId('file-input')).toBeTruthy()
  })
})
