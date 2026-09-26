import { browser } from 'wxt/browser'
import type { OverlayFrame } from './overlayFrame'
import {
  clampDelay,
  CONTROLS_KEY,
  TARGETS,
  type ControlsActions,
  type ControlsModel,
  type ControlsPrefs,
  type Corner,
} from './quickControls'

/** "Translate to" (storage.local): 'original' or a language code; followed on every video. */
export const TARGET_KEY = 'captionTarget'
/** The language Alt+Shift+T switches to from the original. */
export const LAST_TARGET_KEY = 'lastTranslateTarget'

/**
 * The viewer's choices for this page: kept while the page lives, so scrolling
 * a feed (TikTok, Reels, Shorts) doesn't reset captions off or a delay.
 */
const viewer = { visible: true, delayMs: 0 }

const languageName = (code: string) => TARGETS.find(([c]) => c === code)?.[1] ?? code

function formatDelay(ms: number): string {
  return ms === 0 ? 'no delay' : `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`
}

/**
 * Wires the quick controls (and the keyboard shortcuts) to one overlay:
 * captions on/off, the viewer's delay, "Translate to", and where the controls
 * sit. `onTarget` asks for another language (captions made ahead only).
 */
export class ViewerControls implements ControlsActions {
  private model: ControlsModel

  constructor(
    private readonly overlay: OverlayFrame,
    private readonly opts: { canTranslate: boolean; onTarget?: (target: string) => void },
  ) {
    this.model = {
      visible: viewer.visible,
      delayMs: viewer.delayMs,
      target: 'original',
      canTranslate: opts.canTranslate,
      note: null,
      expanded: false,
      corner: 'top-left',
      near: false,
    }
    overlay.setVisible(viewer.visible)
    overlay.setUserDelay(viewer.delayMs)
    this.render()
    void browser.storage.local.get([CONTROLS_KEY, TARGET_KEY]).then((got) => {
      const prefs = (got[CONTROLS_KEY] as ControlsPrefs | undefined) ?? {}
      this.model = {
        ...this.model,
        corner: prefs.corner ?? this.model.corner,
        expanded: prefs.expanded ?? false,
        target: opts.canTranslate
          ? ((got[TARGET_KEY] as string | undefined) ?? 'original')
          : 'original',
      }
      this.render()
    })
  }

  get target(): string {
    return this.model.target
  }

  private render(): void {
    this.overlay.setControls(this.model, this)
  }

  private savePrefs(): void {
    const prefs: ControlsPrefs = { corner: this.model.corner, expanded: this.model.expanded }
    void browser.storage.local.set({ [CONTROLS_KEY]: prefs })
  }

  toggleVisible = (): void => {
    viewer.visible = !this.model.visible
    this.model = { ...this.model, visible: viewer.visible }
    this.overlay.setVisible(viewer.visible)
    this.overlay.toast(viewer.visible ? 'Captions on' : 'Captions off')
    this.render()
  }

  setDelay = (ms: number): void => {
    viewer.delayMs = clampDelay(ms)
    this.model = { ...this.model, delayMs: viewer.delayMs }
    this.overlay.setUserDelay(viewer.delayMs)
    this.overlay.toast(viewer.delayMs === 0 ? 'No delay' : `Delay ${formatDelay(viewer.delayMs)}`)
    this.render()
  }

  nudge(stepMs: number): void {
    this.setDelay(this.model.delayMs + stepMs)
  }

  setTarget = (target: string): void => {
    if (!this.opts.canTranslate || target === this.model.target) return
    this.model = { ...this.model, target }
    const save: Record<string, string> = { [TARGET_KEY]: target }
    if (target !== 'original') save[LAST_TARGET_KEY] = target
    void browser.storage.local.set(save)
    this.overlay.toast(
      target === 'original' ? 'Original language' : `Translate to ${languageName(target)}`,
    )
    this.opts.onTarget?.(target)
    this.render()
  }

  /** Alt+Shift+T: original ↔ the last language translated to (English at first). */
  async toggleTarget(): Promise<void> {
    if (!this.opts.canTranslate) return
    if (this.model.target !== 'original') return this.setTarget('original')
    const got = await browser.storage.local.get(LAST_TARGET_KEY)
    this.setTarget((got[LAST_TARGET_KEY] as string | undefined) ?? 'en')
  }

  setExpanded = (on: boolean): void => {
    this.model = { ...this.model, expanded: on }
    this.savePrefs()
    this.render()
  }

  toggleExpanded(): void {
    this.setExpanded(!this.model.expanded)
  }

  setCorner = (corner: Corner): void => {
    this.model = { ...this.model, corner }
    this.savePrefs()
    this.render()
  }

  setNote(note: string | null): void {
    if (note === this.model.note) return
    this.model = { ...this.model, note }
    this.render()
  }
}
