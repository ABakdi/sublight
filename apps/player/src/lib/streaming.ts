/** A page video's adaptive stream (Spec 04 §9.2, M05b.4). */
export type StreamKind = 'hls' | 'dash'

/**
 * Play an HLS or DASH manifest in a `<video>`: natively where the browser
 * can (HLS in Safari), else with hls.js / dash.js, loaded only when needed.
 * `onFatal` fires when the stream can't be played here (most often the
 * server refusing cross-site requests), so the caller can fall back to the
 * engine. Returns a function that detaches the player. Nothing attaches once
 * `signal` is aborted: a player torn down while its library was still loading
 * must not grab the `<video>` (React runs effects twice in development).
 */
/** Which attachment currently owns each `<video>`: an old cleanup must not undo a newer one. */
const owners = new WeakMap<HTMLVideoElement, symbol>()

export async function attachStream(
  video: HTMLVideoElement,
  url: string,
  kind: StreamKind,
  onFatal: (reason: string) => void,
  signal?: AbortSignal,
): Promise<() => void> {
  const noop = () => {}
  const token = Symbol('stream')
  owners.set(video, token)
  const mine = () => owners.get(video) === token
  if (kind === 'hls') {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari, recent Chromium): no library, no CORS needed.
      video.src = url
      return () => {
        if (!mine()) return
        owners.delete(video)
        video.removeAttribute('src')
      }
    }
    const { default: Hls } = await import('hls.js')
    if (signal?.aborted || !mine()) return noop
    if (!Hls.isSupported()) {
      onFatal('this browser can’t play HLS')
      return noop
    }
    const hls = new Hls({ enableWorker: true })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatal(`${data.type}: ${data.details}`)
    })
    hls.loadSource(url)
    hls.attachMedia(video)
    return () => hls.destroy()
  }
  const dashjs = await import('dashjs')
  if (signal?.aborted || !mine()) return noop
  const player = dashjs.MediaPlayer().create()
  player.on('error', (e: unknown) => {
    const err = (e as { error?: { message?: string } }).error
    onFatal(err?.message ?? 'the DASH stream failed')
  })
  player.initialize(video, url, false)
  return () => player.reset()
}
