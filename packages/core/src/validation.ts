import type { SubtitleCue, SubtitleProject, SubtitleTrack } from './types'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

const MIN_CUE_DURATION_MS = 200

/** Spec 02 §2 invariants for a single cue. */
export function validateCues(cues: SubtitleCue[]): ValidationResult {
  const errors: string[] = []
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs)
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i]!
    if (!cue.id) errors.push(`cue#${i}: missing id`)
    if (!Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs))
      errors.push(`cue#${i}: times must be integer ms`)
    if (cue.endMs <= cue.startMs) errors.push(`cue#${i}: endMs must be > startMs`)
    else if (cue.endMs - cue.startMs < MIN_CUE_DURATION_MS)
      errors.push(`cue#${i}: duration must be >= ${MIN_CUE_DURATION_MS} ms`)
    if (!cue.text.trim()) errors.push(`cue#${i}: text is empty`)
    if (cue.words) {
      for (const w of cue.words) {
        if (w.startMs < cue.startMs || w.endMs > cue.endMs)
          errors.push(`cue#${i}: word '${w.word}' lies outside cue [start,end]`)
        if (w.endMs <= w.startMs) errors.push(`cue#${i}: word '${w.word}' has endMs <= startMs`)
      }
    }
    if (i > 0) {
      const prev = sorted[i - 1]!
      if (cue.startMs < prev.endMs)
        errors.push(`cue#${i}: overlaps previous cue (${prev.startMs}-${prev.endMs})`)
    }
  }
  return { valid: errors.length === 0, errors }
}

export function validateTrack(track: SubtitleTrack): ValidationResult {
  const errors: string[] = []
  if (!track.id) errors.push('track: missing id')
  if (!track.projectId) errors.push('track: missing projectId')
  if (!track.language) errors.push('track: missing language')
  if (track.draft && track.cues.length === 0) errors.push('track: draft must have at least one cue')
  const cues = validateCues(track.cues)
  if (!cues.valid) errors.push(...cues.errors.map((e) => `track ${track.id}: ${e}`))
  return { valid: errors.length === 0, errors }
}

export function validateProject(project: SubtitleProject): ValidationResult {
  const errors: string[] = []
  if (!project.id) errors.push('project: missing id')
  if (!project.title) errors.push('project: missing title')
  if (!project.media.kind) errors.push('project.media: missing kind')
  for (const track of project.tracks) {
    const r = validateTrack(track)
    if (!r.valid) errors.push(...r.errors)
  }
  return { valid: errors.length === 0, errors }
}
