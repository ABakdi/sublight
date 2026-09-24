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

describe('player placeholder (M00.2)', () => {
  it('boots and renders the app title', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /sublight player/i })).toBeTruthy()
  })

  it('shows the engine status bar and placeholder actions', () => {
    render(<App />)
    expect(screen.getByTestId('engine-status')).toBeTruthy()
    expect(screen.getByText('Load a video')).toBeTruthy()
    expect(screen.getByText('Projects')).toBeTruthy()
  })
})
