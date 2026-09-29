import { describe, expect, it } from 'vitest'
import { NEXT_THEME, resolveTheme } from './theme'

describe('the Player’s theme (M06b.10)', () => {
  it('follows the system unless chosen, and cycles system → light → dark', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect([NEXT_THEME.system, NEXT_THEME.light, NEXT_THEME.dark]).toEqual([
      'light',
      'dark',
      'system',
    ])
  })
})
