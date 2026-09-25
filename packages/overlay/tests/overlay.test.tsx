// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { DEFAULT_SUBTITLE_STYLE } from '@sublight/core'

// jsdom has no ResizeObserver; the overlay only needs observe/disconnect.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)
import {
  ALL_ANCHORS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  OVERLAY_CSS,
  SubtitleOverlay,
  anchorLayout,
  scaleFactor,
  styleToCssVars,
} from '../src/index'

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

  it('applies the font scale factor to the baseline size', () => {
    const vars = styleToCssVars({ ...DEFAULT_SUBTITLE_STYLE, fontSize: 40 }, 1.5)
    expect(vars['--sl-font-size']).toBe('60px')
  })
})

describe('overlay geometry (Spec 05 §3)', () => {
  it('clamps font scale to [0.5, 2.5] against the 720px baseline', () => {
    expect(scaleFactor(720)).toBe(1)
    expect(scaleFactor(1440)).toBe(2)
    expect(scaleFactor(2880)).toBe(MAX_FONT_SCALE) // 4x -> clamp
    expect(scaleFactor(72)).toBe(MIN_FONT_SCALE) // 0.1x -> clamp
    expect(scaleFactor(0)).toBe(1)
    expect(scaleFactor(Number.NaN)).toBe(1)
  })

  it('maps every anchor to the right flex axes and margin edge', () => {
    expect(anchorLayout('bottom')).toEqual({
      justifyContent: 'center',
      alignItems: 'flex-end',
      marginSide: 'bottom',
    })
    expect(anchorLayout('top')).toMatchObject({ alignItems: 'flex-start', marginSide: 'top' })
    expect(anchorLayout('left')).toMatchObject({ justifyContent: 'flex-start', marginSide: 'left' })
    expect(anchorLayout('bottom-right')).toMatchObject({
      justifyContent: 'flex-end',
      alignItems: 'flex-end',
    })
    expect(ALL_ANCHORS).toHaveLength(8)
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

  it('renders the active cue text into the shadow root', () => {
    const { container } = render(createElement(SubtitleOverlay, { cues, currentMs: 500 }))
    const shadow = container.querySelector('[data-sublight-host]')?.shadowRoot
    expect(shadow?.textContent).toContain('First cue')
  })

  it('shows nothing when playback is outside every cue', () => {
    const { container } = render(createElement(SubtitleOverlay, { cues, currentMs: 1500 }))
    const shadow = container.querySelector('[data-sublight-host]')?.shadowRoot
    expect(shadow?.querySelector('.sl-cue')?.textContent ?? '').toBe('')
  })

  it('applies syncOffsetMs before scheduling (Spec 02 syncOffsetMs)', () => {
    const shifted = [{ id: 's1', startMs: 600, endMs: 1200, text: 'Late start' }]
    const before = render(
      createElement(SubtitleOverlay, { cues: shifted, currentMs: 650, syncOffsetMs: 100 }),
    )
    const shadowBefore = before.container.querySelector('[data-sublight-host]')?.shadowRoot
    // 650 + 100 = 750 < 700 (600 + 100) -> still before the shifted cue
    expect(shadowBefore?.querySelector('.sl-cue')?.textContent ?? '').toBe('')

    const after = render(
      createElement(SubtitleOverlay, { cues: shifted, currentMs: 750, syncOffsetMs: 100 }),
    )
    const shadowAfter = after.container.querySelector('[data-sublight-host]')?.shadowRoot
    expect(shadowAfter?.textContent).toContain('Late start')
  })

  it('marks draft tracks with the provisional affordance', () => {
    const { container } = render(
      createElement(SubtitleOverlay, { cues, currentMs: 500, draft: true }),
    )
    const host = container.querySelector('[data-sublight-host]') as HTMLElement | null
    const shadow = host?.shadowRoot
    expect(shadow?.querySelector('.sl-cue')?.classList.contains('is-draft')).toBe(true)
    expect(shadow?.textContent).toContain('⧗')
    expect(host?.dataset.sublightDraft).toBeDefined()
  })

  it('renders at the anchor chosen by the style', () => {
    const { container } = render(
      createElement(SubtitleOverlay, {
        cues,
        currentMs: 500,
        style: { position: { anchor: 'top-right', marginPx: 24 } },
      }),
    )
    const shadow = container.querySelector('[data-sublight-host]')?.shadowRoot
    const cue = shadow?.querySelector('.sl-cue')
    expect(cue?.getAttribute('data-anchor')).toBe('top-right')
    expect(cue?.classList.contains('sl-margin-top')).toBe(true)
  })
})

describe('overlay lifecycle', () => {
  it('survives StrictMode double effects and swaps without React errors', async () => {
    const { StrictMode } = await import('react')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const draft = [{ id: 'd', startMs: 0, endMs: 1000, text: 'Draft cue' }]
    const view = render(
      createElement(
        StrictMode,
        null,
        createElement(SubtitleOverlay, { cues: draft, currentMs: 500, draft: true }),
      ),
    )
    // Draft replaced by the final track, then the overlay goes away entirely.
    view.rerender(
      createElement(StrictMode, null, createElement(SubtitleOverlay, { cues, currentMs: 500 })),
    )
    view.unmount()
    await new Promise((r) => setTimeout(r, 10)) // deferred inner-root unmounts
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('bilingual mode (Spec 05 §7)', () => {
  const readCue = (container: HTMLElement) => {
    const host = container.querySelector('[data-sublight-host]')!
    const cue = host.shadowRoot!.querySelector('.sl-cue')!
    return {
      secondary: cue.querySelector('.sl-secondary')?.textContent ?? null,
      lines: [...cue.querySelectorAll('.sl-line')].map((l) => l.textContent),
      bilingual: cue.classList.contains('is-bilingual'),
    }
  }
  const translation = [{ id: 't', startMs: 0, endMs: 1000, text: 'Hello' }]
  const source = [
    { id: 's1', startMs: 0, endMs: 1000, text: 'Hallo' },
    { id: 's2', startMs: 1500, endMs: 2500, text: 'nur\nQuelle' },
  ]

  it('shows the source line above the translation, each on its own timing', async () => {
    const view = render(
      createElement(SubtitleOverlay, { cues: translation, secondaryCues: source, currentMs: 500 }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(readCue(view.container)).toEqual({
      secondary: 'Hallo',
      lines: ['Hello'],
      bilingual: true,
    })
    view.rerender(
      createElement(SubtitleOverlay, { cues: translation, secondaryCues: source, currentMs: 2000 }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(readCue(view.container)).toEqual({ secondary: 'nur Quelle', lines: [], bilingual: true })
  })
})
