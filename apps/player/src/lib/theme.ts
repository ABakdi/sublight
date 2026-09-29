/**
 * The Player's theme (M06b.10): dark, light, or the system's, remembered.
 * Applied as `data-theme` on <html>; the palette follows in index.css.
 */
export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'sublight.theme'

export function savedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  return choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice
}

const query = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

/** Apply a choice now and whenever the system's changes; returns an unsubscribe. */
export function applyTheme(choice: ThemeChoice): () => void {
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // storage blocked: this session only
  }
  const q = query()
  const set = () => {
    document.documentElement.dataset.theme = resolveTheme(choice, q?.matches ?? true)
  }
  set()
  q?.addEventListener('change', set)
  return () => q?.removeEventListener('change', set)
}

export const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}
