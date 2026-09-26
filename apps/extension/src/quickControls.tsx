import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** Where the controls sit (storage.local), and whether they are open. */
export const CONTROLS_KEY = 'quickControls'
export interface ControlsPrefs {
  corner?: Corner
  expanded?: boolean
}

/** "Translate to" choices: the spoken language, or one of these. */
export const TARGETS: [string, string][] = [
  ['original', 'Original'],
  ['en', 'English'],
  ['ar', 'Arabic'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ru', 'Russian'],
  ['tr', 'Turkish'],
  ['hi', 'Hindi'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
]

export const DELAY_STEP_MS = 100
export const MAX_DELAY_MS = 30_000

export interface ControlsModel {
  visible: boolean
  /** + shows captions later, − earlier. */
  delayMs: number
  target: string
  /** Live captions can't be translated (they follow the sound as it plays). */
  canTranslate: boolean
  /** One line of state ("Translating… 40 %", "Live: ~3 s behind"). */
  note: string | null
  expanded: boolean
  corner: Corner
  /** The pointer is over the video: show the collapsed button fully. */
  near: boolean
  /** Distance from the bottom edge in bottom corners: clear of the player's control bar. */
  bottomInset?: number
  /** Distance from the top edge in top corners (vertical feeds keep buttons there). */
  topInset?: number
}

export interface ControlsActions {
  toggleVisible(): void
  setDelay(ms: number): void
  setTarget(target: string): void
  setExpanded(on: boolean): void
  setCorner(corner: Corner): void
}

export function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(-MAX_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(ms)))
}

/** The corner nearest to a point inside a box of `width` × `height`. */
export function nearestCorner(x: number, y: number, width: number, height: number): Corner {
  return `${y < height / 2 ? 'top' : 'bottom'}-${x < width / 2 ? 'left' : 'right'}` as Corner
}

const INSET = 10
const ink = '#f4f4f5'
const muted = '#a1a1aa'
const accent = '#a5b4fc'

const small: CSSProperties = {
  font: '600 12px system-ui, sans-serif',
  color: ink,
  background: 'rgba(255,255,255,0.12)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 6,
  padding: '3px 8px',
  cursor: 'pointer',
  lineHeight: '16px',
}

/**
 * Quick controls over the video (Spec 09 §4.7): a small "CC" button that opens
 * a panel with captions on/off, "Translate to" and the caption delay (±100 ms
 * or a typed number). Drag it by its handle to any corner; it snaps there and
 * stays there on every site.
 */
export function QuickControls({
  model,
  actions,
}: {
  model: ControlsModel
  actions: ControlsActions
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)
  const [draftDelay, setDraftDelay] = useState(String(model.delayMs))
  useEffect(() => setDraftDelay(String(model.delayMs)), [model.delayMs])

  const [v, h] = model.corner.split('-') as ['top' | 'bottom', 'left' | 'right']
  const place: CSSProperties = {
    position: 'absolute',
    [v]: v === 'bottom' ? (model.bottomInset ?? INSET) : (model.topInset ?? INSET),
    [h]: INSET,
    pointerEvents: 'auto',
    transform: offset ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
    transition: offset ? 'none' : 'opacity 0.2s',
    opacity: model.expanded || model.near || offset ? 1 : 0.4,
    zIndex: 2,
  }

  const onDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.stopPropagation()
  }
  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    setOffset({ x: dx, y: dy })
  }
  /** Returns whether it was a drag (so the click that follows is ignored). */
  const onUp = (e: PointerEvent): boolean => {
    const d = drag.current
    drag.current = null
    setOffset(null)
    if (!d?.moved) return false
    const frame = boxRef.current?.offsetParent as HTMLElement | null
    const box = boxRef.current?.getBoundingClientRect()
    const area = frame?.getBoundingClientRect()
    if (box && area) {
      const cx = box.left + box.width / 2 - area.left
      const cy = box.top + box.height / 2 - area.top
      actions.setCorner(nearestCorner(cx, cy, area.width, area.height))
    }
    e.stopPropagation()
    return true
  }

  if (!model.expanded) {
    return (
      <div ref={boxRef} style={place}>
        <button
          data-testid="qc-open"
          title="sublight: captions, translation, delay (Alt+Shift+K)"
          style={{
            ...small,
            width: 34,
            height: 34,
            padding: 0,
            borderRadius: 17,
            background: 'rgba(20,20,24,0.78)',
            color: model.visible ? accent : muted,
            font: '800 11px system-ui, sans-serif',
            touchAction: 'none',
          }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={(e) => {
            if (!onUp(e)) actions.setExpanded(true)
          }}
        >
          CC
        </button>
      </div>
    )
  }

  const commitDelay = () => actions.setDelay(clampDelay(Number(draftDelay)))
  const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
  return (
    <div
      ref={boxRef}
      data-testid="qc-panel"
      style={{
        ...place,
        width: 224,
        padding: 10,
        borderRadius: 12,
        background: 'rgba(20,20,24,0.88)',
        color: ink,
        font: '13px system-ui, sans-serif',
        display: 'grid',
        gap: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span
          title="Drag to another corner"
          style={{ cursor: 'grab', color: muted, userSelect: 'none', touchAction: 'none', flex: 1 }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          ⠿ <b style={{ color: ink }}>sublight</b>
        </span>
        <button
          data-testid="qc-close"
          title="Collapse (Alt+Shift+K)"
          style={{ ...small, padding: '0 8px' }}
          onClick={() => actions.setExpanded(false)}
        >
          –
        </button>
      </div>

      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span>Captions</span>
        <button
          data-testid="qc-visible"
          data-on={model.visible}
          title="Alt+Shift+V"
          style={{
            ...small,
            minWidth: 52,
            background: model.visible ? '#4f46e5' : 'rgba(255,255,255,0.12)',
          }}
          onClick={actions.toggleVisible}
        >
          {model.visible ? 'On' : 'Off'}
        </button>
      </div>

      <label style={{ ...row, justifyContent: 'space-between' }}>
        <span>Translate to</span>
        <select
          data-testid="qc-target"
          value={model.target}
          disabled={!model.canTranslate}
          title={model.canTranslate ? 'Alt+Shift+T toggles it' : 'Not for live captions'}
          style={{ ...small, fontWeight: 400, maxWidth: 120 }}
          onChange={(e) => actions.setTarget(e.target.value)}
        >
          {TARGETS.map(([code, name]) => (
            <option key={code} value={code} style={{ color: '#111' }}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span title="+ shows captions later, − earlier">Delay</span>
        <div style={row}>
          <button
            data-testid="qc-earlier"
            title="100 ms earlier (Alt+Shift+,)"
            style={small}
            onClick={() => actions.setDelay(clampDelay(model.delayMs - DELAY_STEP_MS))}
          >
            −
          </button>
          <input
            data-testid="qc-delay"
            inputMode="numeric"
            value={draftDelay}
            style={{ ...small, width: 56, textAlign: 'right', cursor: 'text', fontWeight: 400 }}
            onChange={(e) => setDraftDelay(e.target.value.replace(/[^\d-]/g, ''))}
            onBlur={commitDelay}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDelay()
              if (e.key === 'Escape') setDraftDelay(String(model.delayMs))
            }}
          />
          <span style={{ color: muted, fontSize: 12 }}>ms</span>
          <button
            data-testid="qc-later"
            title="100 ms later (Alt+Shift+.)"
            style={small}
            onClick={() => actions.setDelay(clampDelay(model.delayMs + DELAY_STEP_MS))}
          >
            +
          </button>
        </div>
      </div>
      {model.delayMs !== 0 && (
        <button
          data-testid="qc-reset"
          title="Alt+Shift+0"
          style={{ ...small, justifySelf: 'end', fontWeight: 400 }}
          onClick={() => actions.setDelay(0)}
        >
          Reset delay
        </button>
      )}

      {model.note && (
        <div data-testid="qc-note" style={{ color: muted, fontSize: 12, lineHeight: 1.35 }}>
          {model.note}
        </div>
      )}
    </div>
  )
}
