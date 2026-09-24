import type { SubtitleStyle } from './types'
import type { ValidationResult } from './validation'

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

const val = (style: SubtitleStyle, errors: string[], field: string, ok: boolean, why: string) => {
  if (!ok) errors.push(`style.${field}: ${why}`)
}

/**
 * Style schema validation (Spec 02 §6). Returns per-field errors; consumers
 * fall back to defaults per field ([Spec 05 §5](../../../docs/specification/05-Overlay-Rendering.md)).
 */
export function validateStyle(style: SubtitleStyle): ValidationResult {
  const errors: string[] = []
  val(style, errors, 'color', HEX_COLOR_RE.test(style.color), `"${style.color}" is not #RRGGBB`)
  val(
    style,
    errors,
    'bgColor',
    HEX_COLOR_RE.test(style.bgColor),
    `"${style.bgColor}" is not #RRGGBB`,
  )
  val(style, errors, 'bgOpacity', style.bgOpacity >= 0 && style.bgOpacity <= 1, 'must be 0..1')
  val(style, errors, 'opacity', style.opacity >= 0 && style.opacity <= 1, 'must be 0..1')
  val(
    style,
    errors,
    'fontSize',
    Number.isFinite(style.fontSize) && style.fontSize > 0,
    'must be > 0',
  )
  val(style, errors, 'maxLines', style.maxLines >= 1 && style.maxLines <= 4, 'must be 1..4')
  val(
    style,
    errors,
    'lineHeight',
    Number.isFinite(style.lineHeight) && style.lineHeight > 0,
    'must be > 0',
  )
  val(
    style,
    errors,
    'align',
    style.align === 'left' || style.align === 'center' || style.align === 'right',
    `"${style.align}" not in left|center|right`,
  )
  val(
    style,
    errors,
    'edgeStyle',
    style.edgeStyle === 'none' ||
      style.edgeStyle === 'outline' ||
      style.edgeStyle === 'shadow' ||
      style.edgeStyle === 'raised',
    `"${style.edgeStyle}" not in none|outline|shadow|raised`,
  )
  val(
    style,
    errors,
    'wrapStyle',
    style.wrapStyle === 'smart' || style.wrapStyle === 'word',
    `"${style.wrapStyle}" not in smart|word`,
  )
  val(
    style,
    errors,
    'casing',
    style.casing === 'normal' || style.casing === 'uppercase' || style.casing === 'title',
    `"${style.casing}" not in normal|uppercase|title`,
  )
  val(
    style,
    errors,
    'position.anchor',
    [
      'bottom',
      'top',
      'left',
      'right',
      'bottom-left',
      'bottom-right',
      'top-left',
      'top-right',
    ].includes(style.position.anchor),
    `"${style.position.anchor}" is not a supported anchor`,
  )
  val(
    style,
    errors,
    'position.marginPx',
    Number.isFinite(style.position.marginPx) && style.position.marginPx >= 0,
    'must be >= 0',
  )
  val(
    style,
    errors,
    'fontWeight',
    style.fontWeight === 'normal' ||
      style.fontWeight === 'bold' ||
      (Number.isFinite(style.fontWeight) && style.fontWeight >= 100 && style.fontWeight <= 900),
    'must be normal|bold or 100..900',
  )
  return { valid: errors.length === 0, errors }
}
