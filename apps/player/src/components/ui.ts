/** Shared class strings and data for the side panels (dark zinc theme). */
export const BTN =
  'rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700'
export const PRIMARY =
  'rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40'
export const FIELD =
  'w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100'

/** Common languages first; whisper detects ~100 and the LLM covers 100+. */
export const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ru', 'Russian'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese'],
  ['ko', 'Korean'],
  ['hi', 'Hindi'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
]

export function mb(bytes: number | null): string {
  return bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : ''
}
