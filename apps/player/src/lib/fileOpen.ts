/**
 * Local media opening (Spec 04 §4, ADR-0011). Prefers the File System Access
 * API (`showOpenFilePicker`) so the app keeps a `FileSystemFileHandle` for
 * re-opening projects after a reload; falls back to a plain `<input type=file>`
 * drag & drop in browsers without FSA (Firefox, and any automated harness).
 */

const PICKER_TYPES = [
  {
    description: 'Video files',
    accept: {
      'video/*': ['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv', '.ogm'],
    },
  },
]

/** Minimal structural types — TS DOM/lib doesn't ship FSA types yet. */
export interface FileSystemFileHandleLike {
  getFile(): Promise<File>
  requestPermission?(opts?: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>
}

interface ShowOpenFilePickerWindow extends Window {
  showOpenFilePicker?(opts?: {
    types?: Array<{ description: string; accept: Record<string, string[]> }>
    multiple?: boolean
  }): Promise<FileSystemFileHandleLike[]>
}

export function hasFileSystemAccess(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as ShowOpenFilePickerWindow).showOpenFilePicker === 'function'
  )
}

export interface OpenedLocalMedia {
  file: File
  /** Present when opened via FSA — persistable for project re-open. */
  handle?: FileSystemFileHandleLike
  name: string
}

function isUserAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'SecurityError')
}

/** FSA open; returns `null` when the user cancels or FSA is unavailable. */
export async function pickVideoFile(): Promise<OpenedLocalMedia | null> {
  const w = window as ShowOpenFilePickerWindow
  if (typeof w.showOpenFilePicker !== 'function') return null
  try {
    const [handle] = await w.showOpenFilePicker({ types: PICKER_TYPES, multiple: false })
    if (!handle) return null
    const file = await handle.getFile()
    return { file, handle, name: file.name }
  } catch (err) {
    if (isUserAbort(err)) return null
    throw err
  }
}

/** Re-resolve a saved FSA handle (permission prompt may be required again). */
export async function reopenLocalMedia(
  handle: FileSystemFileHandleLike,
): Promise<OpenedLocalMedia | null> {
  const perm = handle.requestPermission
    ? await handle.requestPermission({ mode: 'read' })
    : 'granted'
  if (perm !== 'granted') return null
  const file = await handle.getFile()
  return { file, handle, name: file.name }
}

/** Video/handle persistence key pair for a project. */
export const mediaHandleKey = (projectId: string) => `file-handle:${projectId}`

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv|ogv|ogm)$/i.test(file.name)
}
