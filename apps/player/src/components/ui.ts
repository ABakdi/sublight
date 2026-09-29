/** Shared class strings and data for the side panels (dark zinc theme). */
export const BTN =
  'rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700'
export const PRIMARY =
  'rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40'
export const FIELD =
  'w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100'

/** The shared list (`@sublight/protocol`). */
export { LANGUAGES } from '@sublight/protocol'

export function mb(bytes: number | null): string {
  return bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : ''
}
