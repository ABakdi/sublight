import type { CSSProperties } from 'react'

/** Shared look for the popup and options pages: plain, light, system font. */
export const colors = {
  text: '#101828',
  muted: '#667085',
  border: '#e4e7ec',
  ok: '#067647',
  warn: '#b54708',
  bad: '#b42318',
  accent: '#4f46e5',
}

export const button: CSSProperties = {
  font: 'inherit',
  fontSize: 12,
  padding: '6px 10px',
  borderRadius: 6,
  border: `1px solid ${colors.border}`,
  background: '#fff',
  color: colors.text,
  cursor: 'pointer',
}

export const primaryButton: CSSProperties = {
  ...button,
  background: colors.accent,
  borderColor: colors.accent,
  color: '#fff',
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
