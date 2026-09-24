import type { SubtitleStyle } from '@sublight/core'

export type Anchor = SubtitleStyle['position']['anchor']

/** Font-size baseline is for a 720-px-tall video (Spec 05 §3). */
export const REFERENCE_VIDEO_HEIGHT_PX = 720
export const MIN_FONT_SCALE = 0.5
export const MAX_FONT_SCALE = 2.5

/** Scale factor so 34 px stays legible at any container height, clamped [0.5, 2.5]. */
export function scaleFactor(containerHeightPx: number): number {
  if (!Number.isFinite(containerHeightPx) || containerHeightPx <= 0) return 1
  const s = containerHeightPx / REFERENCE_VIDEO_HEIGHT_PX
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, s))
}

export interface AnchorLayout {
  /** Horizontal placement of the cue box (flex). */
  justifyContent: 'flex-start' | 'center' | 'flex-end'
  /** Vertical placement of the cue box (flex). */
  alignItems: 'flex-start' | 'center' | 'flex-end'
  /** Which margin edge the position margin applies to. */
  marginSide: 'top' | 'bottom' | 'left' | 'right'
}

const ANCHOR_DEFS: Record<Anchor, AnchorLayout> = {
  bottom: { justifyContent: 'center', alignItems: 'flex-end', marginSide: 'bottom' },
  top: { justifyContent: 'center', alignItems: 'flex-start', marginSide: 'top' },
  left: { justifyContent: 'flex-start', alignItems: 'center', marginSide: 'left' },
  right: { justifyContent: 'flex-end', alignItems: 'center', marginSide: 'right' },
  'bottom-left': { justifyContent: 'flex-start', alignItems: 'flex-end', marginSide: 'bottom' },
  'bottom-right': { justifyContent: 'flex-end', alignItems: 'flex-end', marginSide: 'bottom' },
  'top-left': { justifyContent: 'flex-start', alignItems: 'flex-start', marginSide: 'top' },
  'top-right': { justifyContent: 'flex-end', alignItems: 'flex-start', marginSide: 'top' },
}

/** Anchor → flex alignment + margin edge (Spec 05 §3). */
export function anchorLayout(anchor: Anchor): AnchorLayout {
  return ANCHOR_DEFS[anchor] ?? ANCHOR_DEFS.bottom
}

export const ALL_ANCHORS: readonly Anchor[] = [
  'bottom',
  'top',
  'left',
  'right',
  'bottom-left',
  'bottom-right',
  'top-left',
  'top-right',
]
