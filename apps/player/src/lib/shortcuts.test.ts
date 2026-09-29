import { describe, expect, it } from 'vitest'
import { actionFor, isTyping, nextSpeed, SHORTCUTS, tapStreak, type KeyLike } from './shortcuts'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
})

describe('the Player’s keyboard (M06b.11)', () => {
  it('maps VLC and YouTube keys to actions', () => {
    expect(actionFor(key(' '))).toEqual({ type: 'togglePlay' })
    expect(actionFor(key('k'))).toEqual({ type: 'togglePlay' })
    expect(actionFor(key('j'))).toEqual({ type: 'seekBy', seconds: -10 })
    expect(actionFor(key('L'))).toEqual({ type: 'seekBy', seconds: 10 })
    expect(actionFor(key('ArrowLeft'))).toEqual({ type: 'seekBy', seconds: -5 })
    expect(actionFor(key('ArrowRight', { shiftKey: true }))).toEqual({
      type: 'seekBy',
      seconds: 60,
    })
    expect(actionFor(key('7'))).toEqual({ type: 'seekToFraction', fraction: 0.7 })
    expect(actionFor(key('ArrowDown'))).toEqual({ type: 'volumeBy', delta: -0.05 })
    expect(actionFor(key('['))).toEqual({ type: 'speed', change: 'down' })
    expect(actionFor(key('>'))).toEqual({ type: 'speed', change: 'up' })
    expect(actionFor(key('g'))).toEqual({ type: 'captionDelay', ms: -50 })
    expect(actionFor(key('h'))).toEqual({ type: 'captionDelay', ms: 50 })
    expect(actionFor(key('ArrowLeft', { altKey: true }))).toEqual({ type: 'jumpCue', dir: -1 })
    expect(actionFor(key('ArrowRight', { altKey: true }))).toEqual({ type: 'jumpCue', dir: 1 })
    expect(actionFor(key('?'))).toEqual({ type: 'help' })
  })

  it('leaves browser shortcuts alone', () => {
    expect(actionFor(key('f', { ctrlKey: true }))).toBeNull()
    expect(actionFor(key('l', { metaKey: true }))).toBeNull()
    expect(actionFor(key('x'))).toBeNull()
  })

  it('every binding is on the sheet, once', () => {
    const shown = SHORTCUTS.filter((s) => s.keys.length > 0)
    expect(new Set(shown.map((s) => s.label)).size).toBe(shown.length)
    // Hidden rows are folded into a shown one (↑/↓, 0 … 9).
    for (const s of SHORTCUTS.filter((x) => x.keys.length === 0))
      expect(['Volume down', 'Jump to 0 % … 90 %']).toContain(s.label)
  })

  it('doesn’t fire while typing', () => {
    expect(isTyping({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isTyping({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(
      true,
    )
    expect(isTyping({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
  })

  it('steps through speeds and back to normal', () => {
    expect(nextSpeed(1, 'up')).toBe(1.25)
    expect(nextSpeed(1, 'down')).toBe(0.75)
    expect(nextSpeed(4, 'up')).toBe(4)
    expect(nextSpeed(0.25, 'down')).toBe(0.25)
    expect(nextSpeed(2.5, 'reset')).toBe(1)
  })

  it('adds 10 s for each further tap on the same side', () => {
    let s = tapStreak(null, 'right', 0)
    expect(s.total).toBe(10)
    s = tapStreak(s, 'right', 300)
    s = tapStreak(s, 'right', 700)
    expect(s.total).toBe(30)
    expect(tapStreak(s, 'left', 800).total).toBe(-10) // the other side starts over
    expect(tapStreak(s, 'right', 2000).total).toBe(10) // too late: starts over
  })
})
