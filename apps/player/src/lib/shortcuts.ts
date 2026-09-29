/**
 * The Player's keyboard (M06b.11): one table drives both the key handling and
 * the shortcut sheet (?), so the sheet always lists exactly the live bindings.
 * VLC's keys where they don't clash with YouTube's.
 */

export type PlayerAction =
  | { type: 'togglePlay' }
  | { type: 'seekBy'; seconds: number }
  | { type: 'seekToFraction'; fraction: number }
  | { type: 'seekToEnd'; end: 'start' | 'end' }
  | { type: 'frameStep'; frames: 1 | -1 }
  | { type: 'volumeBy'; delta: number }
  | { type: 'toggleMute' }
  | { type: 'speed'; change: 'down' | 'up' | 'reset' }
  | { type: 'toggleFullscreen' }
  | { type: 'togglePiP' }
  | { type: 'toggleCaptions' }
  | { type: 'nextTrack' }
  | { type: 'toggleBilingual' }
  | { type: 'captionDelay'; ms: number }
  | { type: 'jumpCue'; dir: 1 | -1 }
  | { type: 'loopPoint' }
  | { type: 'screenshot' }
  | { type: 'queue'; dir: 1 | -1 }
  | { type: 'help' }

export interface Shortcut {
  /** As shown on the sheet. */
  keys: string[]
  label: string
  group: 'Playback' | 'Seeking' | 'Sound and view' | 'Captions' | 'More'
  /** Does this key event mean this shortcut? */
  match(e: KeyLike): boolean
  action: PlayerAction
}

export interface KeyLike {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

const plain =
  (...keys: string[]) =>
  (e: KeyLike) =>
    !e.altKey && !e.ctrlKey && !e.metaKey && keys.includes(e.key)
const noShift =
  (...keys: string[]) =>
  (e: KeyLike) =>
    plain(...keys)(e) && !e.shiftKey
const withShift =
  (...keys: string[]) =>
  (e: KeyLike) =>
    plain(...keys)(e) && e.shiftKey
const withAlt =
  (...keys: string[]) =>
  (e: KeyLike) =>
    e.altKey && !e.ctrlKey && !e.metaKey && keys.includes(e.key)

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

export const SHORTCUTS: Shortcut[] = [
  {
    keys: ['Space', 'K'],
    label: 'Play / pause',
    group: 'Playback',
    match: plain(' ', 'k', 'K'),
    action: { type: 'togglePlay' },
  },
  {
    keys: ['<', '['],
    label: 'Slower',
    group: 'Playback',
    match: plain('<', '['),
    action: { type: 'speed', change: 'down' },
  },
  {
    keys: ['>', ']'],
    label: 'Faster',
    group: 'Playback',
    match: plain('>', ']'),
    action: { type: 'speed', change: 'up' },
  },
  {
    keys: ['='],
    label: 'Normal speed',
    group: 'Playback',
    match: plain('='),
    action: { type: 'speed', change: 'reset' },
  },
  {
    keys: [','],
    label: 'Previous frame (paused)',
    group: 'Playback',
    match: plain(','),
    action: { type: 'frameStep', frames: -1 },
  },
  {
    keys: ['.'],
    label: 'Next frame (paused)',
    group: 'Playback',
    match: plain('.'),
    action: { type: 'frameStep', frames: 1 },
  },
  {
    keys: ['J'],
    label: 'Back 10 s',
    group: 'Seeking',
    match: plain('j', 'J'),
    action: { type: 'seekBy', seconds: -10 },
  },
  {
    keys: ['L'],
    label: 'Forward 10 s',
    group: 'Seeking',
    match: plain('l', 'L'),
    action: { type: 'seekBy', seconds: 10 },
  },
  {
    keys: ['←'],
    label: 'Back 5 s',
    group: 'Seeking',
    match: noShift('ArrowLeft'),
    action: { type: 'seekBy', seconds: -5 },
  },
  {
    keys: ['→'],
    label: 'Forward 5 s',
    group: 'Seeking',
    match: noShift('ArrowRight'),
    action: { type: 'seekBy', seconds: 5 },
  },
  {
    keys: ['Shift+←'],
    label: 'Back 1 min',
    group: 'Seeking',
    match: withShift('ArrowLeft'),
    action: { type: 'seekBy', seconds: -60 },
  },
  {
    keys: ['Shift+→'],
    label: 'Forward 1 min',
    group: 'Seeking',
    match: withShift('ArrowRight'),
    action: { type: 'seekBy', seconds: 60 },
  },
  ...Array.from({ length: 10 }, (_, n): Shortcut => ({
    keys: n === 0 ? ['0 … 9'] : [],
    label: 'Jump to 0 % … 90 %',
    group: 'Seeking',
    match: plain(String(n)),
    action: { type: 'seekToFraction', fraction: n / 10 },
  })),
  {
    keys: ['Home'],
    label: 'To the start',
    group: 'Seeking',
    match: plain('Home'),
    action: { type: 'seekToEnd', end: 'start' },
  },
  {
    keys: ['End'],
    label: 'To the end',
    group: 'Seeking',
    match: plain('End'),
    action: { type: 'seekToEnd', end: 'end' },
  },
  {
    keys: ['Alt+←', 'Alt+→'],
    label: 'Previous / next caption',
    group: 'Seeking',
    match: withAlt('ArrowLeft', 'ArrowRight'),
    action: { type: 'jumpCue', dir: 1 },
  },
  {
    keys: ['↑', '↓'],
    label: 'Volume up / down',
    group: 'Sound and view',
    match: plain('ArrowUp'),
    action: { type: 'volumeBy', delta: 0.05 },
  },
  {
    keys: [],
    label: 'Volume down',
    group: 'Sound and view',
    match: plain('ArrowDown'),
    action: { type: 'volumeBy', delta: -0.05 },
  },
  {
    keys: ['M'],
    label: 'Mute',
    group: 'Sound and view',
    match: plain('m', 'M'),
    action: { type: 'toggleMute' },
  },
  {
    keys: ['F'],
    label: 'Fullscreen',
    group: 'Sound and view',
    match: plain('f', 'F'),
    action: { type: 'toggleFullscreen' },
  },
  {
    keys: ['I'],
    label: 'Picture in picture',
    group: 'Sound and view',
    match: plain('i', 'I'),
    action: { type: 'togglePiP' },
  },
  {
    keys: ['C'],
    label: 'Captions on / off',
    group: 'Captions',
    match: plain('c', 'C'),
    action: { type: 'toggleCaptions' },
  },
  {
    keys: ['V'],
    label: 'Next caption track',
    group: 'Captions',
    match: plain('v', 'V'),
    action: { type: 'nextTrack' },
  },
  {
    keys: ['B'],
    label: 'Original and translation together',
    group: 'Captions',
    match: plain('b', 'B'),
    action: { type: 'toggleBilingual' },
  },
  {
    keys: ['G'],
    label: 'Captions 50 ms earlier',
    group: 'Captions',
    match: plain('g', 'G'),
    action: { type: 'captionDelay', ms: -50 },
  },
  {
    keys: ['H'],
    label: 'Captions 50 ms later',
    group: 'Captions',
    match: plain('h', 'H'),
    action: { type: 'captionDelay', ms: 50 },
  },
  {
    keys: ['A'],
    label: 'Loop: set A, then B, then off',
    group: 'More',
    match: plain('a', 'A'),
    action: { type: 'loopPoint' },
  },
  {
    keys: ['S'],
    label: 'Save a screenshot',
    group: 'More',
    match: plain('s', 'S'),
    action: { type: 'screenshot' },
  },
  {
    keys: ['N'],
    label: 'Next video in the queue',
    group: 'More',
    match: plain('n', 'N'),
    action: { type: 'queue', dir: 1 },
  },
  {
    keys: ['P'],
    label: 'Previous video in the queue',
    group: 'More',
    match: plain('p', 'P'),
    action: { type: 'queue', dir: -1 },
  },
  {
    keys: ['?'],
    label: 'This list',
    group: 'More',
    match: plain('?'),
    action: { type: 'help' },
  },
]

/** The action a key press means, or null. Alt+← goes back a caption, Alt+→ forward. */
export function actionFor(e: KeyLike): PlayerAction | null {
  const s = SHORTCUTS.find((x) => x.match(e))
  if (!s) return null
  if (s.action.type === 'jumpCue') return { type: 'jumpCue', dir: e.key === 'ArrowLeft' ? -1 : 1 }
  return s.action
}

/** Shortcuts must not fire while typing (a form field, or an editable element). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  )
}

/** The next speed in `SPEEDS`, down or up. */
export function nextSpeed(rate: number, change: 'down' | 'up' | 'reset'): number {
  if (change === 'reset') return 1
  if (change === 'up') return SPEEDS.find((s) => s > rate + 1e-9) ?? SPEEDS[SPEEDS.length - 1]!
  return [...SPEEDS].reverse().find((s) => s < rate - 1e-9) ?? SPEEDS[0]!
}

/**
 * Double-tap seeking (M06b.11): each further tap on the same side within
 * `TAP_MS` adds 10 s. Returns the running total to show (−10, −20, …).
 */
export const TAP_MS = 600
export function tapStreak(
  prev: { side: 'left' | 'right'; at: number; total: number } | null,
  side: 'left' | 'right',
  at: number,
): { side: 'left' | 'right'; at: number; total: number } {
  const step = side === 'left' ? -10 : 10
  if (prev && prev.side === side && at - prev.at <= TAP_MS)
    return { side, at, total: prev.total + step }
  return { side, at, total: step }
}
