import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { UploadResult } from '@sublight/protocol'
import { meanVolumeDb, normalizeToWav, probe, type FfmpegBinaries } from './ffmpeg'

/** Mean volume below this is treated as silence (Spec 06 §4). */
export const SILENCE_DB = -60
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const HASH_RE = /^sha256:([0-9a-f]{64})$/

export class MediaError extends Error {
  constructor(
    readonly code:
      'MEDIA_TOO_LARGE' | 'AUDIO_EMPTY' | 'AUDIO_UNSUPPORTED' | 'JOB_INVALID' | 'NOT_FOUND',
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export interface MediaMeta {
  mediaHash: string
  durationMs: number
  normalizedBytes: number
  sourceName: string | null
  createdAt: number
  lastUsedAt: number
}

export interface MediaStoreOptions {
  ffmpeg: FfmpegBinaries
  /** Upload cap in bytes (Protocol §7, default 20 GB). */
  maxUploadBytes: number
  /** Total normalized-audio cache budget; oldest-used entries evicted past it. */
  cacheLimitBytes: number
}

/**
 * Normalized-audio cache (Spec 06 §4): `media-cache/<sha256>.wav` + `.json`
 * sidecar. The hash is of the normalized WAV, so the same audio uploaded twice
 * (even in another container) dedupes, and it is the transcription cache key.
 * Client media ids are aliases in `ids/`.
 */
export class MediaStore {
  private readonly tmp: string
  private readonly ids: string

  constructor(
    private readonly dir: string,
    private readonly opts: MediaStoreOptions,
  ) {
    this.tmp = join(dir, 'tmp')
    this.ids = join(dir, 'ids')
    mkdirSync(this.tmp, { recursive: true })
    mkdirSync(this.ids, { recursive: true })
    // Leftovers from a crash mid-upload.
    for (const f of readdirSync(this.tmp)) rmSync(join(this.tmp, f), { force: true })
  }

  /** Stream an upload in, normalize it, and register it under `mediaId`. */
  async ingest(mediaId: string, body: Readable, sourceName: string | null): Promise<UploadResult> {
    if (!MEDIA_ID_RE.test(mediaId))
      throw new MediaError('JOB_INVALID', 'mediaId must be 1-128 chars of [A-Za-z0-9_-]')
    const raw = join(this.tmp, `${randomUUID()}.upload`)
    const wav = join(this.tmp, `${randomUUID()}.wav`)
    try {
      let received = 0
      const cap = new Transform({
        transform: (chunk: Buffer, _e, cb) => {
          received += chunk.length
          if (received > this.opts.maxUploadBytes) {
            cb(
              new MediaError(
                'MEDIA_TOO_LARGE',
                `upload exceeds ${this.opts.maxUploadBytes} bytes`,
                413,
              ),
            )
          } else cb(null, chunk)
        },
      })
      await pipeline(body, cap, createWriteStream(raw))
      if (received === 0) throw new MediaError('AUDIO_UNSUPPORTED', 'empty upload')

      const info = await probe(this.opts.ffmpeg, raw)
      if (!info.hasAudio)
        throw new MediaError('AUDIO_UNSUPPORTED', 'no audio stream found in the upload')
      // ~2x realtime is a very safe floor for a single-pass audio decode.
      const timeout = Math.max(120_000, (info.durationMs ?? 0) * 2)
      await normalizeToWav(this.opts.ffmpeg, raw, wav, timeout)
      if ((await meanVolumeDb(this.opts.ffmpeg, wav)) < SILENCE_DB) {
        throw new MediaError('AUDIO_EMPTY', 'the audio is silent')
      }

      const hex = await sha256File(wav)
      const mediaHash = `sha256:${hex}`
      const target = join(this.dir, `${hex}.wav`)
      const normalizedBytes = statSync(wav).size
      const wavInfo = await probe(this.opts.ffmpeg, wav)
      const now = Date.now()
      if (existsSync(target)) rmSync(wav, { force: true })
      else renameSync(wav, target)
      const prev = this.meta(mediaHash)
      const meta: MediaMeta = {
        mediaHash,
        durationMs: wavInfo.durationMs ?? info.durationMs ?? 0,
        normalizedBytes,
        sourceName: sourceName ?? prev?.sourceName ?? null,
        createdAt: prev?.createdAt ?? now,
        lastUsedAt: now,
      }
      this.writeMeta(meta)
      writeFileSync(join(this.ids, mediaId), mediaHash)
      this.evict(mediaHash)
      return { mediaHash, durationMs: meta.durationMs, normalizedBytes }
    } finally {
      rmSync(raw, { force: true })
      rmSync(wav, { force: true })
    }
  }

  /** `sha256:<hex>` or an uploaded mediaId → canonical hash, if present. */
  resolve(ref: string): string | null {
    if (HASH_RE.test(ref)) return this.meta(ref) ? ref : null
    if (!MEDIA_ID_RE.test(ref)) return null
    const alias = join(this.ids, ref)
    if (!existsSync(alias)) return null
    const hash = readFileSync(alias, 'utf8').trim()
    return this.meta(hash) ? hash : null
  }

  /** Path of the normalized WAV; marks the entry used (LRU). */
  wavPath(mediaHash: string): string {
    const meta = this.meta(mediaHash)
    if (!meta) throw new MediaError('NOT_FOUND', `unknown media ${mediaHash}`, 404)
    meta.lastUsedAt = Date.now()
    this.writeMeta(meta)
    return join(this.dir, `${hexOf(mediaHash)}.wav`)
  }

  meta(mediaHash: string): MediaMeta | null {
    const m = HASH_RE.exec(mediaHash)
    if (!m) return null
    const file = join(this.dir, `${m[1]}.json`)
    if (!existsSync(file) || !existsSync(join(this.dir, `${m[1]}.wav`))) return null
    return JSON.parse(readFileSync(file, 'utf8')) as MediaMeta
  }

  private writeMeta(meta: MediaMeta): void {
    writeFileSync(join(this.dir, `${hexOf(meta.mediaHash)}.json`), JSON.stringify(meta) + '\n')
  }

  delete(mediaHash: string): boolean {
    const hex = HASH_RE.exec(mediaHash)?.[1]
    if (!hex || !this.meta(mediaHash)) return false
    rmSync(join(this.dir, `${hex}.wav`), { force: true })
    rmSync(join(this.dir, `${hex}.json`), { force: true })
    for (const id of readdirSync(this.ids)) {
      if (readFileSync(join(this.ids, id), 'utf8').trim() === mediaHash) rmSync(join(this.ids, id))
    }
    return true
  }

  all(): MediaMeta[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.meta(`sha256:${f.slice(0, -5)}`))
      .filter((m): m is MediaMeta => m !== null)
  }

  /** LRU eviction down to the cache budget; never evicts `keep`. */
  evict(keep?: string): number {
    const entries = this.all().sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    let total = entries.reduce((n, e) => n + e.normalizedBytes, 0)
    let freed = 0
    for (const e of entries) {
      if (total <= this.opts.cacheLimitBytes) break
      if (e.mediaHash === keep) continue
      this.delete(e.mediaHash)
      total -= e.normalizedBytes
      freed += e.normalizedBytes
    }
    return freed
  }
}

function hexOf(mediaHash: string): string {
  return mediaHash.replace(/^sha256:/, '')
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}
