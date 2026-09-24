import type { SubtitleStyle } from '@sublight/core'
import { ALL_ANCHORS } from '@sublight/overlay'
import { type StylePatch, usePlayerStore } from '../store/player'

const FONT_FAMILIES: Array<[string, string]> = [
  ['Roboto, Helvetica Neue, Arial, sans-serif', 'System (Roboto)'],
  ['Georgia, Times New Roman, serif', 'Serif'],
  ['Courier New, monospace', 'Monospace'],
]

const FIELD_CLASS =
  'block w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </label>
  )
}

export function StylePanel() {
  const project = usePlayerStore((s) => s.project)
  const updateStyle = usePlayerStore((s) => s.updateStyle)
  if (!project) return null
  const style = project.settings.style

  const set = (patch: StylePatch) => void updateStyle(patch)

  return (
    <div className="flex flex-col gap-3">
      <Row label="Text color">
        <input
          type="color"
          data-testid="style-color"
          value={style.color}
          onChange={(e) => set({ color: e.target.value })}
        />
      </Row>
      <Row label="Background">
        <input
          type="color"
          data-testid="style-bg-color"
          value={style.bgColor}
          onChange={(e) => set({ bgColor: e.target.value })}
        />
        <input
          type="range"
          aria-label="Background opacity"
          min={0}
          max={1}
          step={0.05}
          value={style.bgOpacity}
          onChange={(e) => set({ bgOpacity: Number(e.target.value) })}
        />
      </Row>
      <Row label={`Font size ${style.fontSize}px`}>
        <input
          type="range"
          data-testid="style-font-size"
          min={16}
          max={72}
          step={1}
          value={style.fontSize}
          onChange={(e) => set({ fontSize: Number(e.target.value) })}
        />
      </Row>
      <Row label="Font family">
        <select
          className={FIELD_CLASS}
          value={style.fontFamily}
          onChange={(e) => set({ fontFamily: e.target.value })}
        >
          {FONT_FAMILIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Weight">
        <select
          className={FIELD_CLASS}
          value={String(style.fontWeight)}
          onChange={(e) => set({ fontWeight: e.target.value === 'normal' ? 'normal' : 'bold' })}
        >
          <option value="normal">normal</option>
          <option value="bold">bold</option>
        </select>
      </Row>
      <Row label="Align">
        <select
          className={FIELD_CLASS}
          value={style.align}
          onChange={(e) => set({ align: e.target.value as SubtitleStyle['align'] })}
        >
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
      </Row>
      <Row label="Position">
        <select
          className={FIELD_CLASS}
          data-testid="style-anchor"
          value={style.position.anchor}
          onChange={(e) =>
            set({ position: { anchor: e.target.value as SubtitleStyle['position']['anchor'] } })
          }
        >
          {ALL_ANCHORS.map((anchor) => (
            <option key={anchor} value={anchor}>
              {anchor}
            </option>
          ))}
        </select>
      </Row>
      <Row label={`Margin ${style.position.marginPx}px`}>
        <input
          type="range"
          min={0}
          max={160}
          step={4}
          value={style.position.marginPx}
          onChange={(e) => set({ position: { marginPx: Number(e.target.value) } })}
        />
      </Row>
      <Row label="Max lines">
        <select
          className={FIELD_CLASS}
          value={style.maxLines}
          onChange={(e) => set({ maxLines: Number(e.target.value) as SubtitleStyle['maxLines'] })}
        >
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Casing">
        <select
          className={FIELD_CLASS}
          value={style.casing}
          onChange={(e) => set({ casing: e.target.value as SubtitleStyle['casing'] })}
        >
          <option value="normal">normal</option>
          <option value="uppercase">upper</option>
          <option value="title">title</option>
        </select>
      </Row>
      <Row label="Edge">
        <select
          className={FIELD_CLASS}
          value={style.edgeStyle}
          onChange={(e) => set({ edgeStyle: e.target.value as SubtitleStyle['edgeStyle'] })}
        >
          <option value="none">none</option>
          <option value="outline">outline</option>
          <option value="shadow">shadow</option>
          <option value="raised">raised</option>
        </select>
      </Row>
      <Row label="Text shadow">
        <input
          type="checkbox"
          checked={style.textShadow}
          onChange={(e) => set({ textShadow: e.target.checked })}
        />
      </Row>
    </div>
  )
}
