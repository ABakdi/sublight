import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  activeCueAt,
  resolveStyle,
  shiftCues,
  type SubtitleCue,
  type SubtitleStyle,
} from '@sublight/core'
import { anchorLayout, REFERENCE_VIDEO_HEIGHT_PX, scaleFactor, type Anchor } from './geometry'
import { OVERLAY_CSS, styleToCssVars } from './style'

export interface SubtitleOverlayProps {
  cues: SubtitleCue[]
  /** Playback position, ms (rAF-sampled — no timer drift). Ignored when `video` is set. */
  currentMs?: number
  /**
   * The playing video element (Spec 05 §2): drives scheduling via a
   * `requestAnimationFrame` loop and measures the play region each frame.
   * Accepts the element, a ref object, or `null` — when absent the component
   * is controlled via `currentMs`.
   */
  video?: HTMLVideoElement | null | { current: HTMLVideoElement | null }
  /** Whole-track offset applied before scheduling (`track.syncOffsetMs`). */
  syncOffsetMs?: number
  /** Partial style; resolved over the core defaults. */
  style?: Partial<SubtitleStyle>
  /** Draft tracks render with the Spec 05 §6 provisional affordance. */
  draft?: boolean
  /** Extra class on the host element (scoped outside by the shadow root). */
  className?: string
}

interface Frame {
  text: string | null
  cssVars: Record<string, string>
  anchor: Anchor
  marginSide: AnchorLayoutSide
}

type AnchorLayoutSide = 'top' | 'bottom' | 'left' | 'right'

const shadowRoots = new WeakMap<
  ShadowRoot,
  { root: Root; unmountTimer?: ReturnType<typeof setTimeout> }
>()

const EMPTY_FRAME: Frame = { text: null, cssVars: {}, anchor: 'bottom', marginSide: 'bottom' }

function frameKeysEqual(a: Frame, b: Frame): boolean {
  if (a.text !== b.text || a.anchor !== b.anchor || a.marginSide !== b.marginSide) return false
  for (const k of Object.keys(a.cssVars)) if (a.cssVars[k] !== b.cssVars[k]) return false
  for (const k of Object.keys(b.cssVars)) if (b.cssVars[k] !== a.cssVars[k]) return false
  return true
}

/**
 * Shadow-DOM subtitle overlay (ADR-0012). One host per playing video — the
 * player and extension both enforce via the `data-sublight-host` marker
 * (Spec 01 §5). Geometry (anchor + font scaling) is measured per frame inside
 * the shadow host: position updates are layout-only, text changes only when
 * the active cue changes.
 */
export function SubtitleOverlay({
  cues,
  currentMs = 0,
  video = null,
  syncOffsetMs = 0,
  style,
  draft = false,
  className,
}: SubtitleOverlayProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<Root | null>(null)
  const [hostHeight, setHostHeight] = useState(REFERENCE_VIDEO_HEIGHT_PX)
  const [frame, setFrame] = useState<Frame>(EMPTY_FRAME)

  const effectiveStyle = useMemo(() => resolveStyle(style), [style])
  const effectiveCues = useMemo(
    () => (syncOffsetMs === 0 ? cues : shiftCues(cues, syncOffsetMs)),
    [cues, syncOffsetMs],
  )
  const scale = scaleFactor(hostHeight)

  // Element or ref-object → the live element; non-reactive, read per frame.
  const getVideo = useCallback(() => {
    if (video == null) return null
    return 'current' in video ? video.current : video
  }, [video])

  const compute = useCallback(
    (t: number): Frame => {
      const active = activeCueAt(effectiveCues, t)
      if (!active) return EMPTY_FRAME
      const layout = anchorLayout(effectiveStyle.position.anchor)
      return {
        text: active.text,
        cssVars: styleToCssVars(effectiveStyle, scale),
        anchor: effectiveStyle.position.anchor,
        marginSide: layout.marginSide,
      }
    },
    [effectiveCues, effectiveStyle, scale],
  )

  // Measure the play region; re-measure on host resize and window resize
  // (Spec 05 §3 — catches outside-page resizes and fullscreen entry).
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => {
      const h = host.getBoundingClientRect().height || host.clientHeight
      setHostHeight(h > 0 ? h : REFERENCE_VIDEO_HEIGHT_PX)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Video-driven scheduling: rAF loop samples currentTime; the frame only
  // changes when the active cue (or style/geometry) does.
  useEffect(() => {
    if (video == null) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const v = getVideo()
      if (!v) return
      const next = compute(v.currentTime * 1000)
      setFrame((prev) => (frameKeysEqual(prev, next) ? prev : next))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [video, getVideo, compute])

  // Controlled mode (no video): recompute on position/style changes.
  useLayoutEffect(() => {
    if (video != null) return
    const next = compute(currentMs)
    setFrame((prev) => (frameKeysEqual(prev, next) ? prev : next))
  }, [video, currentMs, compute])

  // One React root per shadow root for the host's lifetime. Unmounting is
  // deferred (a synchronous unmount inside the parent's commit makes React
  // warn and race), and a re-mount before it runs (StrictMode, fast swaps)
  // cancels it and reuses the root instead of creating a second one.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    let entry = shadowRoots.get(shadowRoot)
    if (entry) clearTimeout(entry.unmountTimer)
    else {
      entry = { root: createRoot(shadowRoot) }
      shadowRoots.set(shadowRoot, entry)
    }
    const current = entry
    rootRef.current = current.root
    current.root.render(createElement(ShadowContent, { frame, draft }))
    return () => {
      rootRef.current = null
      current.unmountTimer = setTimeout(() => {
        current.root.unmount()
        shadowRoots.delete(shadowRoot)
      }, 0)
    }
  }, [])

  // Update the shadow tree whenever the active frame changes.
  useEffect(() => {
    rootRef.current?.render(createElement(ShadowContent, { frame, draft }))
  }, [frame, draft])

  return (
    <div
      ref={hostRef}
      data-sublight-host=""
      data-sublight-overlay=""
      data-sublight-draft={draft ? '' : undefined}
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

function ShadowContent({ frame, draft }: { frame: Frame; draft: boolean }) {
  const layout = anchorLayout(frame.anchor)
  const boxStyle = {
    ...frame.cssVars,
    justifyContent: layout.justifyContent,
    alignItems: layout.alignItems,
  } as CSSProperties
  const cueClass = [
    'sl-cue',
    `sl-margin-${frame.marginSide}`,
    frame.text ? '' : 'is-empty',
    draft && frame.text ? 'is-draft' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return createElement(
    'div',
    null,
    createElement('style', null, OVERLAY_CSS),
    createElement(
      'div',
      { className: 'sl-cuebox', style: boxStyle },
      createElement(
        'div',
        { className: cueClass, 'data-anchor': frame.anchor },
        frame.text === null
          ? ''
          : [
              draft
                ? createElement('span', { key: 'badge', className: 'sl-draft-badge' }, '⧗')
                : null,
              ...frame.text
                .split('\n')
                .map((line, i) => createElement('div', { key: i, className: 'sl-line' }, line)),
            ],
      ),
    ),
  )
}
