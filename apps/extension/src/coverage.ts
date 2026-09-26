export type Range = { startMs: number; endMs: number }

/** Captions should reach this far past the playhead before playback goes on. */
export const READY_AHEAD_MS = 3000

/** Is [t, t + ahead] captioned (or up to the end of the video)? */
export function isReady(coverage: Range[], tMs: number, durationMs: number | null): boolean {
  const need = Math.min(tMs + READY_AHEAD_MS, (durationMs ?? Infinity) - 250)
  return coverage.some((r) => r.startMs <= tMs + 50 && r.endMs >= need)
}
