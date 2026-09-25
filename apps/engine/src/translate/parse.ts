const NUMBERED = /^\s*(?:[-*]\s*)?(?:\*\*)?(\d{1,3})(?:\*\*)?\s*[:.)\]-]\s*(.*)$/

function clean(text: string): string {
  let t = text
    .trim()
    .replace(/^\*\*|\*\*$/g, '')
    .trim()
  // Unwrap one pair of surrounding quotes the model sometimes adds.
  if (/^(["“«„'])(.*)(["”»'])$/su.test(t)) t = t.slice(1, -1).trim()
  return t
}

/**
 * Parse "n: text" lines (Spec 07 §2.3). Tolerates code fences, bold numbers,
 * "1." / "1)" styles and wrapped continuation lines; returns null unless
 * exactly lines 1..expected are present, each non-empty.
 */
export function parseNumbered(output: string, expected: number): string[] | null {
  const byNumber = new Map<number, string>()
  let last: number | null = null
  for (const raw of output.replace(/```[a-z]*\n?|```/gi, '').split('\n')) {
    if (!raw.trim() || /^<\/?subtitles>$/i.test(raw.trim())) continue
    const m = NUMBERED.exec(raw)
    if (m) {
      last = Number(m[1])
      byNumber.set(last, clean(m[2] ?? ''))
    } else if (last !== null) {
      byNumber.set(last, `${byNumber.get(last)} ${clean(raw)}`.trim())
    }
  }
  if (byNumber.size !== expected) return null
  const lines: string[] = []
  for (let n = 1; n <= expected; n++) {
    const line = byNumber.get(n)
    if (!line) return null
    lines.push(line)
  }
  return lines
}

/**
 * Last resort when the line count won't match (Spec 07 §2.3): join whatever
 * came back and deal it out over the source cues by duration share, at word
 * boundaries. The caller marks these cues low-confidence.
 */
export function resplitByDuration(text: string, durationsMs: number[]): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const n = durationsMs.length
  const total = durationsMs.reduce((a, b) => a + (b || 1), 0)
  const out: string[] = []
  let taken = 0
  let acc = 0
  durationsMs.forEach((d, i) => {
    acc += d || 1
    const left = n - i - 1 // cues after this one
    let until = i === n - 1 ? words.length : Math.round((words.length * acc) / total)
    // With enough words, every cue gets at least one and later cues aren't starved.
    if (words.length >= n) until = Math.min(Math.max(until, taken + 1), words.length - left)
    until = Math.max(taken, until)
    out.push(words.slice(taken, until).join(' '))
    taken = until
  })
  return out
}
