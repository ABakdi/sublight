import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JobError } from '../jobs/queue'
import { run, type FfmpegBinaries } from './ffmpeg'

/**
 * A page video's audio, readable by ffmpeg with Range requests, so any
 * stretch can be fetched without downloading the rest (ADR-0020).
 */
export interface RemoteMedia {
  /** http(s) URL of the media (a file or an HLS playlist). */
  input: string
  /** Request headers ffmpeg must send (User-Agent, Referer, …). */
  headers: Record<string, string>
  durationMs: number
  title: string | null
  via: 'direct' | 'yt-dlp'
}

export interface RemoteDeps {
  ffmpeg: FfmpegBinaries
  /** yt-dlp executable, or null when not installed. */
  ytDlp: string | null
}

/** The installed yt-dlp: `~/.sublight/bin/yt-dlp` (pnpm engine:setup-ytdlp), else none. */
export function findYtDlp(binDir: string): string | null {
  const local = join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  return existsSync(local) ? local : null
}

const isHttp = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url)

function headerArgs(headers: Record<string, string>): string[] {
  const lines = Object.entries(headers)
    .filter(([k]) => !/^(accept-encoding|cookie)$/i.test(k))
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('')
  return lines ? ['-headers', lines] : []
}

/** Duration of a remote input, ms, or null when ffprobe can't read it. */
async function probeDuration(
  bin: FfmpegBinaries,
  input: string,
  headers: Record<string, string>,
): Promise<number | null> {
  const r = await run(
    bin.ffprobe,
    [
      '-v',
      'error',
      ...headerArgs(headers),
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      input,
    ],
    20_000,
  ).catch(() => null)
  const seconds = Number(r?.stdout.trim())
  return r?.code === 0 && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : null
}

interface YtDlpInfo {
  url?: string
  duration?: number
  title?: string
  is_live?: boolean
  live_status?: string
  http_headers?: Record<string, string>
  requested_formats?: { url?: string; vcodec?: string; http_headers?: Record<string, string> }[]
}

/**
 * Find the audio of the video on `pageUrl` (ADR-0020): the page's own media
 * URL when it is a plain http(s) file or playlist ffprobe can read, else
 * yt-dlp's best audio format (YouTube, Vimeo and other MSE players).
 */
export async function resolveRemote(
  deps: RemoteDeps,
  pageUrl: string,
  mediaUrl?: string,
  userAgent?: string,
  cookiesFromBrowser?: string,
): Promise<RemoteMedia> {
  if (isHttp(mediaUrl)) {
    const headers: Record<string, string> = { Referer: pageUrl }
    if (userAgent) headers['User-Agent'] = userAgent
    const durationMs = await probeDuration(deps.ffmpeg, mediaUrl, headers)
    if (durationMs) return { input: mediaUrl, headers, durationMs, title: null, via: 'direct' }
  }
  if (!deps.ytDlp) {
    throw new JobError(
      'MEDIA_UNREACHABLE',
      'this video has no direct media URL and yt-dlp is not installed (pnpm engine:setup-ytdlp)',
      false,
      422,
    )
  }
  const r = await run(
    deps.ytDlp,
    [
      '-J',
      '--no-playlist',
      '--no-warnings',
      '-f',
      'bestaudio/best',
      // YouTube needs a JavaScript runtime for its signatures; use ours.
      '--js-runtimes',
      `node:${process.execPath}`,
      // Opt-in, for sites that need a login (Instagram): the user's own browser cookies.
      ...(cookiesFromBrowser ? ['--cookies-from-browser', cookiesFromBrowser] : []),
      pageUrl,
    ],
    60_000,
  )
  if (r.code !== 0) {
    const last =
      r.stderr
        .trim()
        .split('\n')
        .pop()
        ?.replace(/^ERROR:\s*/, '') ?? 'unknown error'
    const needsLogin = /log(ged)?[- ]?in|cookies|empty media response|private/i.test(last)
    const reason =
      needsLogin && !cookiesFromBrowser
        ? `${last} (this site may need your login: turn on “Use my browser login” in sublight’s Options)`
        : last
    throw new JobError(
      'MEDIA_UNREACHABLE',
      `couldn't get this video's audio: ${reason}`,
      false,
      422,
    )
  }
  const info = JSON.parse(r.stdout) as YtDlpInfo
  if (info.is_live || info.live_status === 'is_live') {
    throw new JobError(
      'MEDIA_UNREACHABLE',
      'this is a live stream: there is no audio ahead of playback to caption',
      false,
      422,
    )
  }
  const audio =
    info.requested_formats?.find((f) => f.vcodec === 'none') ?? info.requested_formats?.[0]
  const input = info.url ?? audio?.url
  const headers = info.http_headers ?? audio?.http_headers ?? {}
  if (!isHttp(input))
    throw new JobError('MEDIA_UNREACHABLE', 'yt-dlp found no audio URL', false, 422)
  const durationMs =
    info.duration && info.duration > 0
      ? Math.round(info.duration * 1000)
      : await probeDuration(deps.ffmpeg, input, headers)
  if (!durationMs)
    throw new JobError('MEDIA_UNREACHABLE', "couldn't read the video's duration", false, 422)
  return { input, headers, durationMs, title: info.title ?? null, via: 'yt-dlp' }
}

/** Fetch `durationMs` of audio from `startMs` as 16 kHz mono WAV (Range requests, no full download). */
export async function sliceRemote(
  bin: FfmpegBinaries,
  media: RemoteMedia,
  output: string,
  startMs: number,
  durationMs: number,
): Promise<void> {
  const r = await run(
    bin.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      ...headerArgs(media.headers),
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      media.input,
      '-vn',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      output,
    ],
    180_000,
  )
  if (r.code !== 0) {
    throw new JobError(
      'MEDIA_UNREACHABLE',
      `couldn't fetch audio at ${Math.round(startMs / 1000)} s: ${r.stderr.trim().split('\n').pop() ?? ''}`,
      true,
    )
  }
}
