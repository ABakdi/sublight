import type { SubtitleStyle } from './types'

/**
 * User-global default style (Spec 02 §6). Lives in `core` so the player,
 * extension and overlay cannot diverge.
 */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  color: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0.65,
  fontSize: 34,
  fontFamily: "'Roboto', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  fontWeight: 'bold',
  textShadow: false,
  edgeStyle: 'outline',
  align: 'center',
  position: { anchor: 'bottom', marginPx: 32 },
  maxLines: 2,
  lineHeight: 1.25,
  wrapStyle: 'word',
  opacity: 1,
  casing: 'normal',
}

/** Merge a partial style over the defaults (client preference resolution). */
export function resolveStyle(partial?: Partial<SubtitleStyle>): SubtitleStyle {
  if (!partial) return { ...DEFAULT_SUBTITLE_STYLE }
  return {
    ...DEFAULT_SUBTITLE_STYLE,
    ...partial,
    position: {
      ...DEFAULT_SUBTITLE_STYLE.position,
      ...(partial.position ?? {}),
    },
  }
}
