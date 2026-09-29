import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JobError } from '../jobs/queue'
import { assertPublicUrl } from './net'
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
  via: 'direct' | 'yt-dlp' | 'copy'
}

export interface RemoteDeps {
  ffmpeg: FfmpegBinaries
  /** yt-dlp executable, or null when not installed. */
  ytDlp: string | null
  /** Fetch from this computer and the local network too (`config.allowPrivateNetworks`). */
  allowPrivateNetworks?: boolean
  /** The job was cancelled: stop ffprobe and yt-dlp at once. */
  signal?: AbortSignal
}

/** The installed yt-dlp: `~/.sublight/bin/yt-dlp` (`sublight-engine setup yt-dlp`), else none. */
export function findYtDlp(binDir: string): string | null {
  const local = join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  return existsSync(local) ? local : null
}

const isHttp = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url)

export function headerArgs(headers: Record<string, string>, input?: string): string[] {
  // The engine's own copy of a page video (a relay file): local, and nothing else.
  if (input !== undefined && !isHttp(input)) return ['-protocol_whitelist', 'file']
  const lines = Object.entries(headers)
    .filter(([k]) => !/^(accept-encoding|cookie)$/i.test(k))
    // A value can't start a header of its own (security baseline A8).
    .map(([k, v]) => `${k.replace(/[^\w-]/g, '')}: ${v.replace(/[\r\n]+/g, ' ')}\r\n`)
    .join('')
  return [
    // Remote inputs stay remote: a manifest can't point ffmpeg at local files.
    '-protocol_whitelist',
    'http,https,tls,tcp,crypto,data,httpproxy',
    ...(lines ? ['-headers', lines] : []),
  ]
}

/** Duration of an input, ms, or null with ffprobe's reason when it can't read it. */
export async function probeMedia(
  bin: FfmpegBinaries,
  input: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ durationMs: number | null; error: string | null }> {
  const r = await run(
    bin.ffprobe,
    [
      '-v',
      'error',
      ...headerArgs(headers, input),
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      input,
    ],
    20_000,
    signal,
  ).catch((err: unknown) => {
    if (signal?.aborted) throw err
    return null
  })
  const seconds = Number(r?.stdout.trim())
  if (r?.code === 0 && Number.isFinite(seconds) && seconds > 0)
    return { durationMs: Math.round(seconds * 1000), error: null }
  // "https://…: Server returned 403 Forbidden": the reason, without the (signed) URL.
  const said = r?.stderr
    .trim()
    .split('\n')
    .pop()
    ?.replace(/^.*?:\s*(?=Server returned)/, '')
    .replace(/https?:\/\/\S+/g, 'the link')
  return { durationMs: null, error: said || (r ? 'no duration' : 'ffprobe failed') }
}

/** What went wrong with a page's own media URL, for the viewer. */
function directFailure(error: string): string {
  const status = /\b(401|403|404|410)\b|Forbidden|Not Found|Unauthorized/i.exec(error)
  return status
    ? `the site refused its link to this video (${error}). Some sites give links that only work while their own page plays the video: caption it on its page, or open it in the Player again from there`
    : `couldn't read this video's stream (${error})`
}

/**
 * DRM in an HLS playlist: sample encryption (FairPlay `skd://`, Widevine,
 * PlayReady). Plain AES-128 is fine: ffmpeg decrypts it.
 */
export function isDrmPlaylist(playlist: string): boolean {
  return /#EXT-X-(SESSION-)?KEY:[^\n]*METHOD=SAMPLE-AES|skd:\/\/|urn:uuid:edef8ba9|com\.microsoft\.playready/i.test(
    playlist,
  )
}

/** An HLS or DASH manifest (a playlist, not a media file). */
export function isManifest(url: string): boolean {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/** Refuse DRM-protected HLS up front: nothing can decode its audio. */
export async function assertNotProtected(
  input: string,
  headers: Record<string, string>,
): Promise<void> {
  if (!/\.m3u8(\?|$)|m3u8/i.test(input)) return
  const res = await fetch(input, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  const text = res?.ok ? await res.text().catch(() => '') : ''
  if (isDrmPlaylist(text.slice(0, 20_000)))
    throw new JobError(
      'MEDIA_PROTECTED',
      'this video is DRM-protected: its audio can’t be read, so it can’t be captioned',
      false,
      422,
    )
}

interface YtDlpInfo {
  protocol?: string
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
  /** yt-dlp format: the best audio by default (captions); `PLAYABLE_FORMAT` for the Player. */
  format = 'bestaudio/best',
): Promise<RemoteMedia & { via: 'direct' | 'yt-dlp' }> {
  const allowPrivate = deps.allowPrivateNetworks ?? false
  await assertPublicUrl(pageUrl, allowPrivate)
  /** Why the page's own media URL didn't work, when it had one. */
  let direct: string | null = null
  if (isHttp(mediaUrl)) {
    await assertPublicUrl(mediaUrl, allowPrivate)
    const headers: Record<string, string> = { Referer: pageUrl }
    if (userAgent) headers['User-Agent'] = userAgent
    const probed = await probeMedia(deps.ffmpeg, mediaUrl, headers, deps.signal)
    if (probed.durationMs)
      return { input: mediaUrl, headers, durationMs: probed.durationMs, title: null, via: 'direct' }
    direct = probed.error
  }
  if (!deps.ytDlp) {
    throw new JobError(
      'MEDIA_UNREACHABLE',
      direct
        ? directFailure(direct)
        : 'this video has no direct media URL and yt-dlp is not installed (sublight-engine setup yt-dlp)',
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
      format,
      // YouTube needs a JavaScript runtime for its signatures; use ours.
      '--js-runtimes',
      `node:${process.execPath}`,
      // Opt-in, for sites that need a login (Instagram): the user's own browser cookies.
      ...(cookiesFromBrowser ? ['--cookies-from-browser', cookiesFromBrowser] : []),
      '--',
      pageUrl,
    ],
    60_000,
    deps.signal,
  )
  if (r.code !== 0) {
    const last =
      r.stderr
        .trim()
        .split('\n')
        .pop()
        ?.replace(/^ERROR:\s*/, '') ?? 'unknown error'
    // yt-dlp doesn't know the site: the page's own URL failing is the real story.
    if (direct && /unsupported url|no suitable extractor/i.test(last))
      throw new JobError('MEDIA_UNREACHABLE', directFailure(direct), false, 422)
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
  await assertPublicUrl(input, allowPrivate)
  if (info.protocol?.includes('m3u8') || /m3u8/i.test(input))
    await assertNotProtected(input, headers)
  const durationMs =
    info.duration && info.duration > 0
      ? Math.round(info.duration * 1000)
      : (await probeMedia(deps.ffmpeg, input, headers, deps.signal)).durationMs
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
  signal?: AbortSignal,
): Promise<void> {
  const r = await run(
    bin.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      ...headerArgs(media.headers, media.input),
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
    signal,
  )
  if (r.code !== 0) {
    throw new JobError(
      'MEDIA_UNREACHABLE',
      `couldn't fetch audio at ${Math.round(startMs / 1000)} s: ${r.stderr.trim().split('\n').pop() ?? ''}`,
      true,
    )
  }
}
