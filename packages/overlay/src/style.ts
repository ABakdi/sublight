import type { SubtitleStyle } from '@sublight/core'

/**
 * Map the shared style schema to CSS custom properties the Shadow DOM stylesheet
 * consumes (Spec 02 §6 / Spec 05). Serialized as a flat record of `--sl-*`.
 * `scale` applies the Spec 05 §3 font scaling (baseline @ 720 px height).
 */
export function styleToCssVars(style: SubtitleStyle, scale = 1): Record<string, string> {
  const vars: Record<string, string> = {
    '--sl-color': style.color,
    '--sl-bg-color': style.bgColor,
    '--sl-bg-opacity': String(style.bgOpacity),
    '--sl-font-size': `${Math.round(style.fontSize * scale)}px`,
    '--sl-font-family': style.fontFamily,
    '--sl-font-weight': String(style.fontWeight),
    '--sl-text-shadow': style.textShadow ? '1px 1px 2px rgba(0,0,0,0.9)' : 'none',
    '--sl-edge-style': style.edgeStyle,
    '--sl-align': style.align,
    '--sl-position-anchor': style.position.anchor,
    '--sl-position-margin': `${style.position.marginPx}px`,
    '--sl-max-lines': String(style.maxLines),
    '--sl-line-height': String(style.lineHeight),
    '--sl-opacity': String(style.opacity),
    '--sl-casing': style.casing,
    '--sl-secondary-color': style.bilingual?.secondaryColor ?? '#d4d4d8',
    '--sl-secondary-opacity': String(style.bilingual?.secondaryOpacity ?? 0.85),
    '--sl-secondary-scale': String(style.bilingual?.heightRatio ?? 0.75),
  }
  if (style.karaoke?.active) {
    vars['--sl-karaoke-color'] = style.karaoke.highlightColor
    vars['--sl-karaoke-lag'] = `${style.karaoke.lagMs}ms`
  }
  return vars
}

/**
 * Injected into the shadow root: rules keyed off the custom properties.
 * Anchor alignment + margin edge come from `geometry.anchorLayout` via the
 * `sl-margin-*` classes; `data-anchor` is kept for debugging/DOM queries.
 */
export const OVERLAY_CSS = `
:host { all: initial; }
.sl-cuebox {
  position: absolute;
  inset: 0;
  display: flex;
  width: 100%;
  height: 100%;
  pointer-events: none;
  font-family: var(--sl-font-family, sans-serif);
}
.sl-cue {
  max-width: 90%;
  padding: 0.2em 0.45em;
  color: var(--sl-color, #fff);
  background: color-mix(in srgb, var(--sl-bg-color, #000) calc(var(--sl-bg-opacity, 0.65) * 100%), transparent);
  opacity: var(--sl-opacity, 1);
  text-align: var(--sl-align, center);
  font-size: var(--sl-font-size, 34px);
  font-weight: var(--sl-font-weight, bold);
  line-height: var(--sl-line-height, 1.25);
  text-shadow: var(--sl-text-shadow, none);
  text-transform: var(--sl-casing, none);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  display: -webkit-box;
  -webkit-line-clamp: var(--sl-max-lines, 2);
  -webkit-box-orient: vertical;
}
.sl-margin-top { margin-top: var(--sl-position-margin, 32px); }
.sl-margin-bottom { margin-bottom: var(--sl-position-margin, 32px); }
.sl-margin-left { margin-left: var(--sl-position-margin, 32px); }
.sl-margin-right { margin-right: var(--sl-position-margin, 32px); }
.sl-line { display: block; }
.sl-cue.is-bilingual { display: block; -webkit-line-clamp: unset; }
.sl-secondary {
  display: block;
  color: var(--sl-secondary-color, #d4d4d8);
  opacity: var(--sl-secondary-opacity, 0.85);
  font-size: calc(var(--sl-secondary-scale, 0.75) * 1em);
  font-weight: normal;
}
.sl-draft-badge { margin-right: 0.35em; font-size: 0.8em; }
.sl-cue.is-empty { visibility: hidden; }
.sl-cue.is-draft {
  opacity: 0.9;
  border-bottom: 2px dashed currentColor;
}
@media (prefers-reduced-motion: no-preference) {
  .sl-cue { transition: opacity 80ms linear; }
}
`
