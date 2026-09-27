import { resolveStyle, validateStyle, type SubtitleStyle } from '@sublight/core'

/**
 * How captions look (Options → Caption style, Spec 09 §7): the appearance
 * fields of the shared style schema (Spec 02 §6), in storage.local. Size and
 * position stay with the popup's quick toggles (`overlayStyle`), which follow
 * the video's shape and the site's control bar.
 */
export const CAPTION_STYLE_KEY = 'captionStyle'

export const APPEARANCE_KEYS = [
  'color',
  'bgColor',
  'bgOpacity',
  'fontFamily',
  'fontWeight',
  'edgeStyle',
  'textShadow',
  'opacity',
  'casing',
  'align',
  'lineHeight',
] as const satisfies readonly (keyof SubtitleStyle)[]

export type CaptionAppearance = Partial<Pick<SubtitleStyle, (typeof APPEARANCE_KEYS)[number]>>

/**
 * The appearance fields of a stored value, each checked by the core
 * validator: an invalid or unknown field is dropped, so it falls back to the
 * default on its own (Spec 05 §5).
 */
export function appearanceFrom(raw: unknown): CaptionAppearance {
  if (typeof raw !== 'object' || raw === null) return {}
  const picked: Record<string, unknown> = {}
  for (const key of APPEARANCE_KEYS) {
    const v = (raw as Record<string, unknown>)[key]
    if (v === undefined) continue
    // Font stacks go into CSS: keep them to names, commas, quotes and spaces.
    if (key === 'fontFamily' && (typeof v !== 'string' || !/^[\w\s,'"-]{1,120}$/.test(v))) continue
    if (key === 'textShadow' && typeof v !== 'boolean') continue
    picked[key] = v
  }
  const { errors } = validateStyle(resolveStyle(picked as Partial<SubtitleStyle>))
  for (const e of errors) {
    const field = /^style\.(\w+)/.exec(e)?.[1]
    if (field) delete picked[field]
  }
  return picked as CaptionAppearance
}

/** Font stacks offered in Options (the default one first). */
export const FONT_CHOICES: [string, string][] = [
  [resolveStyle().fontFamily, 'Sans-serif (default)'],
  ["Georgia, 'Times New Roman', serif", 'Serif'],
  ["'Courier New', monospace", 'Monospace'],
  ["'Comic Sans MS', 'Comic Neue', cursive", 'Casual'],
]
