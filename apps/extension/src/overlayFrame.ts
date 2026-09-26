import { createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cuesForMode, type CaptionMode, type SubtitleCue, type SubtitleStyle } from '@sublight/core'
import { SubtitleOverlay } from '@sublight/overlay'
import { browser } from 'wxt/browser'

/** User caption style from the popup's quick toggles (storage.local). */
export const OVERLAY_STYLE_KEY = 'overlayStyle'
export interface QuickStyle {
  fontSize?: number
  anchor?: 'bottom' | 'top'
  /** 'words' (default): text fills in as each word is spoken; 'sentences': whole sentences. */
  mode?: CaptionMode
  /** Older setting ('lines' = whole cues), read as `mode`. */
  reveal?: 'words' | 'lines'
}

export function modeOf(style: QuickStyle): CaptionMode {
  return style.mode ?? (style.reveal === 'lines' ? 'sentences' : 'words')
}

const frames = new Set<OverlayFrame>()
let quickStyle: QuickStyle = {}
void browser.storage.local.get(OVERLAY_STYLE_KEY).then((got) => {
  quickStyle = (got[OVERLAY_STYLE_KEY] as QuickStyle | undefined) ?? {}
  for (const f of frames) f.refresh()
})
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[OVERLAY_STYLE_KEY]) return
  quickStyle = (changes[OVERLAY_STYLE_KEY].newValue as QuickStyle | undefined) ?? {}
  for (const f of frames) f.refresh()
})

/** Keep captions above player control bars (YouTube's is ~50 px + progress bar). */
export function marginFor(videoHeightPx: number): number {
  return Math.max(32, Math.round(videoHeightPx * 0.14))
}

/**
 * Overlay over a page video (Spec 05 §1, extension case). The page's own
 * layout is never touched: a fixed-position frame on <html> tracks the
 * video's box every animation frame, and the shared Shadow-DOM overlay
 * renders inside it. In fullscreen the frame moves into the fullscreen
 * element so it stays visible.
 */
export class OverlayFrame {
  private frame: HTMLDivElement
  private root: Root
  private raf = 0
  private cues: SubtitleCue[] = []
  private draft = false
  private offsetMs = 0
  private margin = 32

  constructor(private readonly video: HTMLVideoElement) {
    this.frame = document.createElement('div')
    this.frame.dataset.sublightFrame = ''
    Object.assign(this.frame.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
      border: '0',
    })
    document.documentElement.append(this.frame)
    this.root = createRoot(this.frame)
    frames.add(this)
    this.track()
  }

  /** Re-render with the current quick style. */
  refresh(): void {
    this.render()
  }

  get target(): HTMLVideoElement {
    return this.video
  }

  /** `offsetMs` delays display (live drafts arrive after their words were spoken). */
  setCues(cues: SubtitleCue[], draft: boolean, offsetMs = 0): void {
    this.cues = cues
    this.draft = draft
    this.offsetMs = offsetMs
    this.render()
  }

  /** Move the display delay (live drafts) without new cues. */
  setOffset(offsetMs: number): void {
    if (Math.abs(offsetMs - this.offsetMs) < 5) return
    this.offsetMs = offsetMs
    this.render()
  }

  private status: string | null = null
  /** A short note over the video ("Captioning this part…"), null hides it. */
  setStatus(text: string | null): void {
    if (text === this.status) return
    this.status = text
    this.render()
  }

  /** Cues for the display mode, rebuilt only when cues or mode change (not on offset moves). */
  private shaped: { from: SubtitleCue[]; mode: CaptionMode; cues: SubtitleCue[] } | null = null
  private shapedCues(): SubtitleCue[] {
    const mode = modeOf(quickStyle)
    if (this.shaped?.from !== this.cues || this.shaped.mode !== mode)
      this.shaped = { from: this.cues, mode, cues: cuesForMode(this.cues, mode) }
    return this.shaped.cues
  }

  private render(): void {
    const style: Partial<SubtitleStyle> = {
      ...(quickStyle.fontSize ? { fontSize: quickStyle.fontSize } : {}),
      position: { anchor: quickStyle.anchor ?? 'bottom', marginPx: this.margin },
    }
    this.root.render(
      createElement(
        Fragment,
        null,
        createElement(SubtitleOverlay, {
          cues: this.shapedCues(),
          video: this.video,
          draft: this.draft,
          syncOffsetMs: this.offsetMs,
          style,
        }),
        this.status &&
          createElement(
            'div',
            {
              'data-sublight-status': '',
              style: {
                position: 'absolute',
                top: 12,
                left: 12,
                padding: '5px 10px',
                borderRadius: 999,
                background: 'rgba(0,0,0,0.72)',
                color: '#fff',
                font: '600 13px system-ui, sans-serif',
              },
            },
            this.status,
          ),
      ),
    )
  }

  private track = () => {
    this.raf = requestAnimationFrame(this.track)
    const parent =
      document.fullscreenElement && document.fullscreenElement !== this.video
        ? document.fullscreenElement
        : document.documentElement
    if (this.frame.parentElement !== parent) parent.append(this.frame)
    const r = this.video.getBoundingClientRect()
    const s = this.frame.style
    const next = [`${r.left}px`, `${r.top}px`, `${r.width}px`, `${r.height}px`]
    if (s.left !== next[0]) s.left = next[0]!
    if (s.top !== next[1]) s.top = next[1]!
    if (s.width !== next[2]) s.width = next[2]!
    if (s.height !== next[3]) s.height = next[3]!
    s.display = r.width > 0 && r.height > 0 && this.video.isConnected ? 'block' : 'none'
    const margin = marginFor(r.height)
    if (margin !== this.margin) {
      this.margin = margin
      this.render()
    }
  }

  destroy(): void {
    frames.delete(this)
    cancelAnimationFrame(this.raf)
    this.root.unmount()
    this.frame.remove()
  }
}
