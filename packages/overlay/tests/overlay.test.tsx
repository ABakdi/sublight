// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { DEFAULT_SUBTITLE_STYLE } from '@sublight/core'
import { OVERLAY_CSS, SubtitleOverlay, styleToCssVars } from '../src/index'

const cues = [
  { id: 'c1', startMs: 0, endMs: 1000, text: 'First cue' },
  { id: 'c2', startMs: 2000, endMs: 3000, text: 'Second\nline' },
]

describe('overlay style mapping (Spec 02 §6)', () => {
  it('serializes the style schema into --sl-* custom properties', () => {
    const vars = styleToCssVars({ ...DEFAULT_SUBTITLE_STYLE, fontSize: 40, color: '#ff0000' })
    expect(vars['--sl-color']).toBe('#ff0000')
    expect(vars['--sl-font-size']).toBe('40px')
    expect(vars['--sl-opacity']).toBe('1')
    expect(vars['--sl-max-lines']).toBe('2')
  })
})

describe('SubtitleOverlay', () => {
  it('renders a shadow host with the single-host marker', () => {
    const { container } = render(createElement(SubtitleOverlay, { cues, currentMs: 500 }))
    const host = container.querySelector('[data-sublight-host]')
    expect(host).not.toBeNull()
    expect(host?.shadowRoot).not.toBeNull()
    expect(host?.shadowRoot?.querySelector('style')?.textContent).toContain('.sl-cue')
    // No host ancestors hijack arbitrary elements; the host itself is the overlay.
    expect(container.querySelectorAll('[data-sublight-host]')).toHaveLength(1)
  })

  it('resolves default style over partials', () => {
    const vars = styleToCssVars({ ...DEFAULT_SUBTITLE_STYLE, fontFamily: 'monospace' })
    expect(vars['--sl-font-family']).toBe('monospace')
  })

  it('exposes the stylesheet constant for preview tooling', () => {
    expect(OVERLAY_CSS).toContain('color-mix')
  })
})
