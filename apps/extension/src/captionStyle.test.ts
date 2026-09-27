import { describe, expect, it } from 'vitest'
import { appearanceFrom } from './captionStyle'

describe('caption style', () => {
  it('keeps valid appearance fields', () => {
    expect(
      appearanceFrom({ color: '#ffee00', bgOpacity: 0.2, edgeStyle: 'shadow', textShadow: true }),
    ).toEqual({ color: '#ffee00', bgOpacity: 0.2, edgeStyle: 'shadow', textShadow: true })
  })
  it('drops invalid fields one by one, keeping the rest', () => {
    expect(appearanceFrom({ color: 'red', bgOpacity: 3, casing: 'uppercase' })).toEqual({
      casing: 'uppercase',
    })
  })
  it('ignores size, position and unknown keys (the popup owns size and position)', () => {
    expect(
      appearanceFrom({ fontSize: 60, position: { anchor: 'top', marginPx: 0 }, evil: 1 }),
    ).toEqual({})
  })
  it('refuses font stacks that could break out of the CSS value', () => {
    expect(appearanceFrom({ fontFamily: 'x; } body { display: none' })).toEqual({})
    expect(appearanceFrom({ fontFamily: "Georgia, 'Times New Roman', serif" })).toEqual({
      fontFamily: "Georgia, 'Times New Roman', serif",
    })
  })
  it('reads nothing from a missing or broken value', () => {
    expect(appearanceFrom(undefined)).toEqual({})
    expect(appearanceFrom('bold')).toEqual({})
  })
})
