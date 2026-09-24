import {
  createElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { activeCueAt, resolveStyle, type SubtitleCue, type SubtitleStyle } from '@sublight/core'
import { OVERLAY_CSS, styleToCssVars } from './style'

export interface SubtitleOverlayProps {
  cues: SubtitleCue[]
  /** Playback position, ms (rAF-sampled — no timer drift). */
  currentMs: number
  /** Partial style; resolved over the core defaults. */
  style?: Partial<SubtitleStyle>
  /** Extra class on the host element (scoped outside by the shadow root). */
  className?: string
}

interface Frame {
  text: string | null
  cssVars: Record<string, string>
}

/**
 * Shadow-DOM subtitle overlay (ADR-0012). One host per playing video — the
 * player and extension both enforce via the `data-sublight-host` marker
 * (Spec 01 §5).
 */
export function SubtitleOverlay({ cues, currentMs, style, className }: SubtitleOverlayProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<Root | null>(null)

  const effectiveStyle = useMemo(() => resolveStyle(style), [style])
  const active = useMemo(() => activeCueAt(cues, currentMs), [cues, currentMs])

  // Only re-render the shadow content when the active cue or style changes —
  // currentMs updates every frame but the DOM stays untouched between cues.
  const [frame, setFrame] = useState<Frame>({ text: null, cssVars: {} })
  useLayoutEffect(() => {
    setFrame(
      active
        ? { text: active.text, cssVars: styleToCssVars(effectiveStyle) }
        : { text: null, cssVars: {} },
    )
  }, [active, effectiveStyle])

  // Create the shadow root + React root once for the host's lifetime.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const root = createRoot(shadowRoot)
    rootRef.current = root
    root.render(createElement(ShadowContent, { frame }))
    return () => {
      rootRef.current = null
      root.unmount()
    }
  }, [])

  // Update the shadow tree whenever the active frame changes.
  useEffect(() => {
    const root = rootRef.current
    if (root) root.render(createElement(ShadowContent, { frame }))
  }, [frame])

  return (
    <div
      ref={hostRef}
      data-sublight-host=""
      data-sublight-overlay=""
      aria-live="polite"
      aria-atomic="true"
      className={className}
      style={
        {
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 2147483647,
        } as CSSProperties
      }
    />
  )
}

function ShadowContent({ frame }: { frame: Frame }) {
  const boxStyle = frame.cssVars as CSSProperties
  return createElement(
    'div',
    null,
    createElement('style', null, OVERLAY_CSS),
    createElement(
      'div',
      { className: 'sl-cuebox', style: boxStyle },
      createElement(
        'div',
        { className: frame.text ? 'sl-cue' : 'sl-cue is-empty' },
        frame.text === null
          ? ''
          : frame.text
              .split('\n')
              .map((line, i) => createElement('div', { key: i, className: 'sl-line' }, line)),
      ),
    ),
  )
}
