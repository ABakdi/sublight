/** Headroom over the slowest recent draft. */
const MARGIN_MS = 250
/** Cap on the display delay. */
const MAX_DELAY_MS = 10_000
/** Drafts remembered for the estimate (a few seconds of passes). */
const WINDOW = 8
/** A new word later than this is a seek the page hasn't reported yet: ignored. */
const RESET_MS = 20_000
/** How fast the delay may change: the caption clock runs at 0.75-1.25×, never jumps. */
const SLEW = 0.25

/**
 * The display delay for live drafts (Spec 08 §5). Each draft brings words the
 * page hasn't seen (those after the previous draft's last word); the earliest
 * of them was spoken `now − its start` ago, which is the delay that draft
 * proves necessary. The target is the largest of the last few, plus headroom: every
 * word is already there when its turn comes, so words reveal at the rhythm
 * they were spoken, just shifted. The shown delay moves toward the target
 * slowly; a sudden change would move the caption clock backwards (captions
 * vanish and come back) or forwards (a burst of words).
 */
export class DisplayDelay {
  private samples: number[] = []
  /** Start of the newest word seen so far (media ms). */
  private lastStart: number | null = null
  private target = 0
  private shown: number | null = null
  private lastTick: number | null = null

  /** A draft arrived with the playhead at `nowMs`; `starts` are its word start times. */
  onDraft(nowMs: number, starts: number[]): void {
    if (starts.length === 0) return
    const prev = this.lastStart
    const fresh = prev === null ? starts : starts.filter((s) => s > prev)
    this.lastStart = Math.max(prev ?? -Infinity, ...starts)
    if (fresh.length === 0) return
    const need = nowMs - Math.min(...fresh)
    if (need < -1000 || need > RESET_MS) return // a seek the page hasn't reported yet
    this.samples.push(need)
    if (this.samples.length > WINDOW) this.samples.shift()
    this.target = Math.max(0, Math.min(MAX_DELAY_MS, Math.max(...this.samples) + MARGIN_MS))
    // Nothing shown yet: start right at the target.
    this.shown ??= this.target
  }

  /** The delay to use now (`wallMs` any monotonic clock); it only slews while playing. */
  tick(wallMs: number, playing: boolean): number {
    const dt = this.lastTick === null ? 0 : Math.max(0, wallMs - this.lastTick)
    this.lastTick = wallMs
    if (this.shown === null) return this.target
    if (playing) {
      const step = dt * SLEW
      this.shown += Math.max(-step, Math.min(step, this.target - this.shown))
    }
    return Math.round(this.shown)
  }

  /** After a seek the old measurements say nothing; the next draft starts over. */
  reset(): void {
    this.samples = []
    this.lastStart = null
    this.shown = null
    this.target = 0
  }

  get targetMs(): number {
    return this.target
  }
}
