import { createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cuesForMode, type CaptionMode, type SubtitleCue, type SubtitleStyle } from '@sublight/core'
import { SubtitleOverlay } from '@sublight/overlay'
import { QuickControls, type ControlsActions, type ControlsModel } from './quickControls'
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
export function marginFor(videoHeightPx: number, portrait = false): number {
  // Vertical feeds (TikTok, Reels, Shorts) put a caption and buttons low on the video.
  return Math.max(32, Math.round(videoHeightPx * (portrait ? 0.22 : 0.14)))
}

/** A video noticeably taller than wide: short-form feeds. */
export function isPortrait(width: number, height: number): boolean {
  return width > 0 && height > 0 && width < height * 0.8
}
/** Characters per caption line on a vertical video (42 on a landscape one). */
export const PORTRAIT_LINE_CHARS = 24

/** Events that must not reach the page from the controls (site shortcuts, click-to-pause). */
const CONTAINED_EVENTS = [
  'keydown',
  'keyup',
  'keypress',
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'touchstart',
  'touchend',
  'wheel',
  'contextmenu',
]

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
  /** A second line (the translation, when both languages are shown). */
  private secondary: SubtitleCue[] | null = null
  private draft = false
  private offsetMs = 0
  /** The viewer's own delay (quick controls), added to `offsetMs`. */
  private userDelayMs = 0
  private visible = true
  private portrait = false
  private margin = 32
  private controlsHost: HTMLDivElement | null = null
  private controlsRoot: Root | null = null
  private controls: { model: ControlsModel; actions: ControlsActions } | null = null
  private near = false
  private nearTimer: ReturnType<typeof setTimeout> | undefined

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
    const captions = document.createElement('div')
    this.frame.append(captions)
    Object.assign(captions.style, { position: 'absolute', inset: '0' })
    this.root = createRoot(captions)
    frames.add(this)
    this.track()
    document.addEventListener('mousemove', this.onPointer, { passive: true })
  }

  /** Show the collapsed controls fully while the pointer is over the video. */
  private onPointer = (e: MouseEvent) => {
    const r = this.video.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) return
    clearTimeout(this.nearTimer)
    this.nearTimer = setTimeout(() => this.setNear(false), 2500)
    this.setNear(true)
  }

  private setNear(on: boolean): void {
    if (on === this.near) return
    this.near = on
    this.renderControls()
  }

  /** Quick controls over the video (null removes them). */
  setControls(model: ControlsModel | null, actions?: ControlsActions): void {
    if (!model || !actions) {
      this.controls = null
      this.controlsRoot?.unmount()
      this.controlsRoot = null
      this.controlsHost?.remove()
      this.controlsHost = null
      return
    }
    this.controls = { model, actions }
    if (!this.controlsHost) {
      // Own shadow root: page CSS can't restyle the controls, and their
      // events stop here instead of reaching the site's shortcuts.
      const host = document.createElement('div')
      host.dataset.sublightControls = ''
      Object.assign(host.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
      const shadow = host.attachShadow({ mode: 'open' })
      const mount = document.createElement('div')
      Object.assign(mount.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
      shadow.append(mount)
      for (const type of CONTAINED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation())
      this.frame.append(host)
      this.controlsHost = host
      this.controlsRoot = createRoot(mount)
    }
    this.renderControls()
  }

  private renderControls(): void {
    if (!this.controls || !this.controlsRoot) return
    this.controlsRoot.render(
      createElement(QuickControls, {
        model: {
          ...this.controls.model,
          near: this.near,
          // Above the site's control bar (landscape) or caption and buttons (feeds).
          bottomInset: Math.max(10, Math.round(this.margin * 0.6)),
          topInset: this.portrait ? Math.round(this.margin * 0.4) : 10,
        },
        actions: this.controls.actions,
      }),
    )
  }

  /** A second, smaller line above the captions (null removes it). */
  setSecondary(cues: SubtitleCue[] | null): void {
    if (cues === this.secondary) return
    this.secondary = cues
    this.render()
  }

  /** Captions on/off (the controls stay). */
  setVisible(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    this.render()
  }

  /** The viewer's delay: + shows captions later, − earlier. */
  setUserDelay(ms: number): void {
    if (ms === this.userDelayMs) return
    this.userDelayMs = ms
    this.render()
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

  private toastText: string | null = null
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  /** A brief note in the middle of the video ("Delay +300 ms"). */
  toast(text: string): void {
    clearTimeout(this.toastTimer)
    this.toastText = text
    this.render()
    this.toastTimer = setTimeout(() => {
      this.toastText = null
      this.render()
    }, 1200)
  }

  private status: string | null = null
  /** A short note over the video ("Captioning this part…"), null hides it. */
  setStatus(text: string | null): void {
    if (text === this.status) return
    this.status = text
    this.render()
  }

  /** Cues for the display mode, rebuilt only when cues or mode change (not on offset moves). */
  private shaped: {
    from: SubtitleCue[]
    mode: CaptionMode
    portrait: boolean
    cues: SubtitleCue[]
  } | null = null
  private shapedCues(): SubtitleCue[] {
    const mode = modeOf(quickStyle)
    const s = this.shaped
    if (s?.from !== this.cues || s.mode !== mode || s.portrait !== this.portrait) {
      const opts = this.portrait ? { maxLineChars: PORTRAIT_LINE_CHARS } : {}
      this.shaped = {
        from: this.cues,
        mode,
        portrait: this.portrait,
        cues: cuesForMode(this.cues, mode, opts),
      }
    }
    return this.shaped!.cues
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
          cues: this.visible ? this.shapedCues() : [],
          video: this.video,
          draft: this.draft,
          syncOffsetMs: this.offsetMs + this.userDelayMs,
          ...(this.visible && this.secondary
            ? {
                secondaryCues: this.secondary,
                secondarySyncOffsetMs: this.offsetMs + this.userDelayMs,
              }
            : {}),
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
                left: '50%',
                transform: 'translateX(-50%)',
                whiteSpace: 'nowrap',
                padding: '5px 10px',
                borderRadius: 999,
                background: 'rgba(0,0,0,0.72)',
                color: '#fff',
                font: '600 13px system-ui, sans-serif',
              },
            },
            this.status,
          ),
        this.toastText &&
          createElement(
            'div',
            {
              'data-sublight-toast': '',
              style: {
                position: 'absolute',
                top: '38%',
                left: '50%',
                transform: 'translateX(-50%)',
                whiteSpace: 'nowrap',
                padding: '8px 14px',
                borderRadius: 10,
                background: 'rgba(0,0,0,0.72)',
                color: '#fff',
                font: '600 15px system-ui, sans-serif',
              },
            },
            this.toastText,
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
    const portrait = isPortrait(r.width, r.height)
    const margin = marginFor(r.height, portrait)
    if (margin !== this.margin || portrait !== this.portrait) {
      this.margin = margin
      this.portrait = portrait
      this.render()
      this.renderControls()
    }
  }

  destroy(): void {
    frames.delete(this)
    cancelAnimationFrame(this.raf)
    clearTimeout(this.nearTimer)
    clearTimeout(this.toastTimer)
    document.removeEventListener('mousemove', this.onPointer)
    this.setControls(null)
    this.root.unmount()
    this.frame.remove()
  }
}
