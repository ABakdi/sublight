import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { JobError } from '../jobs/queue'
import { headerArgs, type RemoteMedia } from './remote'

/** How long a relay handle works: longer than a film, shorter than a signed CDN URL. */
export const RELAY_TTL_MS = 6 * 60 * 60 * 1000

/** Bounds on preparing videos for the Player (baseline: relay jobs were unbounded). */
export const MAX_ACTIVE_DOWNLOADS = 2
const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000
const MAX_DOWNLOAD_BYTES = 8 * 1024 ** 3

/**
 * yt-dlp format for a pass-through relay: one file with both video and audio
 * over plain HTTP, mp4 first. YouTube lists one (format 18) but no longer
 * serves it, so sites like it fall back to downloading (`DOWNLOAD_FORMAT`).
 */
export const PLAYABLE_FORMAT =
  'best[vcodec!=none][acodec!=none][protocol^=http][ext=mp4]/best[vcodec!=none][acodec!=none][protocol^=http]'

/** Separate video (≤ 720p) + audio, merged into one mp4 the `<video>` can seek. */
export const DOWNLOAD_FORMAT =
  'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b'

/** A video being saved to the relay directory. */
export interface Download {
  path: string
  state: 'downloading' | 'ready' | 'failed'
  /** 0..1 while downloading. */
  progress: number
  error?: string
}

export type Relay =
  | {
      kind: 'stream'
      media: RemoteMedia
      /**
       * A copy saved while the page's link still works: some sites' links stop
       * working minutes after their page stops playing (the Beta-1 checkpoint,
       * B8). Served, and captioned, once ready.
       */
      copy?: Download
      expiresAt: number
    }
  | (Download & {
      kind: 'file'
      title: string | null
      durationMs: number | null
      expiresAt: number
    })

export interface RelayStatus {
  state: 'ready' | 'downloading' | 'failed'
  progress: number
  error?: string
  /** A streamed relay's saved copy. */
  copy?: { state: Download['state']; progress: number; error?: string }
}

/**
 * Relayed page videos for the Player (Spec 06 §4.1, M05b). A `<video>` can't
 * send the bearer token, so each resolved stream gets an unguessable id
 * (128 random bits) that expires; there is no way to relay an arbitrary URL.
 * Direct files are streamed through; sites that only serve separate video
 * and audio (YouTube) are downloaded and merged first ("Preparing media…").
 */
export class RelayStore {
  private relays = new Map<string, Relay>()

  constructor(private readonly dir?: string) {
    if (dir) {
      mkdirSync(dir, { recursive: true })
      // Files from a previous run: their ids died with it.
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true, recursive: true })
    }
  }

  /**
   * Stream `media` straight through. With `copyWith` (ffmpeg), also save a
   * copy in the background, when there is room for another download.
   */
  add(media: RemoteMedia, now = Date.now(), opts: { copyWith?: string } = {}): string {
    this.prune(now)
    const id = randomBytes(16).toString('hex')
    const relay: Relay = { kind: 'stream', media, expiresAt: now + RELAY_TTL_MS }
    if (opts.copyWith && this.dir && this.active() < MAX_ACTIVE_DOWNLOADS) {
      relay.copy = { path: join(this.dir, `${id}.mp4`), state: 'downloading', progress: 0 }
      this.ffmpegCopy(media, opts.copyWith, relay.copy)
    }
    this.relays.set(id, relay)
    return id
  }

  /** The relay's video on this computer (a download, a remux or a copy), if it has one. */
  localCopy(id: string): Download | null {
    const r = this.get(id)
    if (!r) return null
    return r.kind === 'file' ? r : (r.copy ?? null)
  }

  /** Download and merge with yt-dlp; the relay serves the file once it's ready. */
  download(
    pageUrl: string,
    opts: {
      ytDlp: string
      ffmpeg: string
      cookiesFromBrowser?: string
      title: string | null
      durationMs: number | null
    },
    now = Date.now(),
  ): string {
    if (!this.dir) throw new Error('relay downloads need a cache directory')
    this.prune(now)
    this.assertRoom()
    const id = randomBytes(16).toString('hex')
    const path = join(this.dir, `${id}.mp4`)
    const relay: Relay = {
      kind: 'file',
      path,
      state: 'downloading',
      progress: 0,
      title: opts.title,
      durationMs: opts.durationMs,
      expiresAt: now + RELAY_TTL_MS,
    }
    this.relays.set(id, relay)
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--js-runtimes',
      `node:${process.execPath}`,
      // A bare name ("ffmpeg") would be taken as a directory: let yt-dlp use PATH then.
      ...(opts.ffmpeg.includes('/') ? ['--ffmpeg-location', opts.ffmpeg] : []),
      '-f',
      DOWNLOAD_FORMAT,
      '--merge-output-format',
      'mp4',
      // moov first, so playback can start without reading the whole file.
      '--postprocessor-args',
      'Merger+ffmpeg:-movflags +faststart',
      ...(opts.cookiesFromBrowser ? ['--cookies-from-browser', opts.cookiesFromBrowser] : []),
      '--max-filesize',
      String(MAX_DOWNLOAD_BYTES),
      '-o',
      path,
      '--',
      pageUrl,
    ]
    const child = spawn(opts.ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timedOut = this.deadline(child)
    // Two downloads (video, then audio): count them as halves of the whole.
    let part = 0
    let last = 0
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (/Destination:/.test(line) && last > 0) part = Math.min(1, part + 1)
        const m = /\[download\]\s+([\d.]+)%/.exec(line)
        if (m) {
          last = Number(m[1]) / 100
          relay.progress = Math.min(0.99, (part + last) / 2)
        }
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    child.on('close', (code) => {
      clearTimeout(timedOut.timer)
      // yt-dlp can exit 0 without merging (no ffmpeg): only a real file is ready.
      if (timedOut.fired) {
        relay.state = 'failed'
        relay.error = 'preparing this video took too long'
      } else if (code === 0 && existsSync(path)) {
        relay.state = 'ready'
        relay.progress = 1
      } else if (code === 0) {
        relay.state = 'failed'
        relay.error =
          'the video and audio were downloaded but could not be merged (is ffmpeg installed?)'
      } else {
        relay.state = 'failed'
        relay.error =
          stderr
            .trim()
            .split('\n')
            .pop()
            ?.replace(/^ERROR:\s*/, '') ?? `yt-dlp exited ${code}`
      }
    })
    return id
  }

  /**
   * An HLS/DASH manifest can't be relayed as-is (its segments are relative
   * to it): copy the stream into one seekable mp4 with ffmpeg (no re-encode).
   */
  remux(media: RemoteMedia, ffmpeg: string, now = Date.now()): string {
    if (!this.dir) throw new Error('relay downloads need a cache directory')
    this.prune(now)
    this.assertRoom()
    const id = randomBytes(16).toString('hex')
    const path = join(this.dir, `${id}.mp4`)
    const relay: Relay = {
      kind: 'file',
      path,
      state: 'downloading',
      progress: 0,
      title: media.title,
      durationMs: media.durationMs,
      expiresAt: now + RELAY_TTL_MS,
    }
    this.relays.set(id, relay)
    this.ffmpegCopy(media, ffmpeg, relay)
    return id
  }

  /** Copy `media` into `into.path` with ffmpeg (no re-encode), seekable from the start. */
  private ffmpegCopy(media: RemoteMedia, ffmpeg: string, into: Download): void {
    const child = spawn(
      ffmpeg,
      [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-progress',
        'pipe:1',
        ...headerArgs(media.headers, media.input),
        '-i',
        media.input,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-fs',
        String(MAX_DOWNLOAD_BYTES),
        into.path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const timedOut = this.deadline(child)
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString())
      if (m && media.durationMs)
        into.progress = Math.min(0.99, Number(m[1]) / 1000 / media.durationMs)
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    child.on('error', (err) => {
      clearTimeout(timedOut.timer)
      into.state = 'failed'
      into.error = err.message
    })
    child.on('close', (code) => {
      clearTimeout(timedOut.timer)
      if (into.state === 'failed') return
      if (timedOut.fired) {
        into.state = 'failed'
        into.error = 'preparing this video took too long'
      } else if (code === 0 && existsSync(into.path)) {
        into.state = 'ready'
        into.progress = 1
      } else {
        into.state = 'failed'
        into.error = stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`
      }
    })
  }

  /** Videos being saved right now. */
  active(): number {
    return [...this.relays.values()].filter((r) =>
      r.kind === 'file' ? r.state === 'downloading' : r.copy?.state === 'downloading',
    ).length
  }

  /** At most `MAX_ACTIVE_DOWNLOADS` videos being prepared at once. */
  private assertRoom(): void {
    const active = this.active()
    if (active >= MAX_ACTIVE_DOWNLOADS)
      throw new JobError(
        'MEDIA_UNREACHABLE',
        `${active} videos are already being prepared for the Player: try again when one is ready`,
        true,
        429,
      )
  }

  /** Kill a download that runs past `DOWNLOAD_TIMEOUT_MS`. */
  private deadline(child: ReturnType<typeof spawn>): { timer: NodeJS.Timeout; fired: boolean } {
    const d = { fired: false, timer: undefined as unknown as NodeJS.Timeout }
    d.timer = setTimeout(() => {
      d.fired = true
      child.kill('SIGKILL')
    }, DOWNLOAD_TIMEOUT_MS)
    d.timer.unref()
    return d
  }

  get(id: string, now = Date.now()): Relay | null {
    const r = this.relays.get(id)
    if (!r) return null
    if (r.expiresAt <= now) {
      this.drop(id, r)
      return null
    }
    return r
  }

  status(id: string): RelayStatus | null {
    const r = this.get(id)
    if (!r) return null
    if (r.kind === 'stream') {
      const c = r.copy
      return {
        state: 'ready',
        progress: 1,
        ...(c
          ? {
              copy: {
                state: c.state,
                progress: c.progress,
                ...(c.error ? { error: c.error } : {}),
              },
            }
          : {}),
      }
    }
    return { state: r.state, progress: r.progress, ...(r.error ? { error: r.error } : {}) }
  }

  private drop(id: string, r: Relay): void {
    this.relays.delete(id)
    if ((r.kind !== 'file' && !r.copy) || !this.dir) return
    // The merged file and any parts yt-dlp left (id.f140.m4a, …).
    for (const f of readdirSync(this.dir))
      if (f.startsWith(id)) rmSync(join(this.dir, f), { force: true })
  }

  private prune(now: number): void {
    for (const [id, r] of this.relays) if (r.expiresAt <= now) this.drop(id, r)
  }
}

/** Response headers passed through from the upstream media server. */
export const RELAY_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
] as const

/** Serve a downloaded file with Range support (seeking). */
function fileResponse(path: string, request: Request): Response {
  const size = statSync(path).size
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
  const headers = new Headers({
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  })
  if (!m || (m[1] === '' && m[2] === '')) {
    headers.set('content-length', String(size))
    const body =
      request.method === 'HEAD' ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream)
    return new Response(body, { status: 200, headers })
  }
  // "bytes=-N" is the last N bytes.
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1])
  const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || start > end) {
    headers.set('content-range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  headers.set('content-range', `bytes ${start}-${end}/${size}`)
  headers.set('content-length', String(end - start + 1))
  const body =
    request.method === 'HEAD'
      ? null
      : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream)
  return new Response(body, { status: 206, headers })
}

/** Stream the relayed media, honoring the player's Range request (seeking). */
export async function relayResponse(relay: Relay, request: Request): Promise<Response> {
  if (relay.kind === 'file') {
    if (relay.state !== 'ready')
      return new Response(null, { status: 503, headers: { 'retry-after': '2' } })
    return fileResponse(relay.path, request)
  }
  // The saved copy, once there: it works after the page's own link stops.
  if (relay.copy?.state === 'ready') return fileResponse(relay.copy.path, request)
  const headers: Record<string, string> = { ...relay.media.headers }
  const range = request.headers.get('range')
  if (range) headers.Range = range
  const upstream = await fetch(relay.media.input, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    signal: request.signal,
  })
  const out = new Headers()
  for (const name of RELAY_HEADERS) {
    const v = upstream.headers.get(name)
    if (v) out.set(name, v)
  }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes')
  out.set('cache-control', 'no-store')
  // Media, never a page: the relay shares the origin that approves pairings (baseline A5).
  if (!/^(video|audio)\//i.test(out.get('content-type') ?? ''))
    out.set('content-type', 'application/octet-stream') // downloaded, never rendered
  out.set('content-security-policy', 'sandbox')
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  })
}
