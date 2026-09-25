import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { ModelInfo, ModelsResponse, ModelState } from '@sublight/protocol'
import type { EventBus } from '../events'
import { downloadUrl, MODEL_MANIFEST, type ManifestEntry } from './manifest'

interface Registry {
  [id: string]: { sha256: string; file: string; installedAt: string }
}

export interface ModelManagerOptions {
  manifest?: readonly ManifestEntry[]
  /** Override the download URL (tests serve fixtures locally). */
  urlFor?: (entry: ManifestEntry) => string
  fetchImpl?: typeof fetch
}

export class ModelError extends Error {
  constructor(
    readonly code: 'MODEL_NOT_INSTALLED' | 'MODEL_INSTALL_FAILED' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Model manager (Spec 06 §3, ADR-0016): installs pinned artifacts into
 * ~/.sublight/models. Download streams to `<file>.part` while hashing; only a
 * size + SHA-256 match is renamed into place (atomic), otherwise the part file
 * is deleted and the model goes to `error`. Downloaded files are never executed.
 */
export class ModelManager {
  private readonly manifest: readonly ManifestEntry[]
  private readonly urlFor: (entry: ManifestEntry) => string
  private readonly fetchImpl: typeof fetch
  private readonly registryFile: string
  private registry: Registry
  private progress = new Map<string, number>()
  private errors = new Map<string, string>()
  private inflight = new Map<string, Promise<void>>()

  constructor(
    private readonly dir: string,
    private readonly bus: EventBus,
    opts: ModelManagerOptions = {},
  ) {
    this.manifest = opts.manifest ?? MODEL_MANIFEST
    this.urlFor = opts.urlFor ?? downloadUrl
    this.fetchImpl = opts.fetchImpl ?? fetch
    mkdirSync(dir, { recursive: true })
    this.registryFile = join(dir, 'installed.json')
    this.registry = this.readRegistry()
  }

  private readRegistry(): Registry {
    try {
      return JSON.parse(readFileSync(this.registryFile, 'utf8')) as Registry
    } catch {
      return {}
    }
  }

  private writeRegistry(): void {
    writeFileSync(this.registryFile, JSON.stringify(this.registry, null, 2) + '\n')
  }

  entry(id: string): ManifestEntry {
    const entry = this.manifest.find((m) => m.id === id)
    if (!entry) throw new ModelError('NOT_FOUND', `Unknown model '${id}'`)
    return entry
  }

  /** Installed = registered with the manifest's hash and the file still present at full size. */
  isInstalled(id: string): boolean {
    const entry = this.manifest.find((m) => m.id === id)
    const reg = this.registry[id]
    if (!entry || !reg || reg.sha256 !== entry.sha256) return false
    const file = join(this.dir, entry.file)
    return existsSync(file) && statSync(file).size === entry.sizeBytes
  }

  /** Absolute path of an installed model, or MODEL_NOT_INSTALLED. */
  pathOf(id: string): string {
    const entry = this.entry(id)
    if (!this.isInstalled(id)) {
      throw new ModelError('MODEL_NOT_INSTALLED', `Model '${id}' is not installed`)
    }
    return join(this.dir, entry.file)
  }

  private stateOf(id: string): ModelState {
    if (this.inflight.has(id)) return 'downloading'
    if (this.isInstalled(id)) return 'installed'
    if (this.errors.has(id)) return 'error'
    return 'not-installed'
  }

  info(id: string): ModelInfo {
    const e = this.entry(id)
    const installed = this.isInstalled(id)
    const state = this.stateOf(id)
    return {
      id: e.id,
      role: e.role,
      name: e.name,
      sizeBytes: e.sizeBytes,
      vramClass: e.vramClass,
      license: e.license,
      ...(e.tasks ? { tasks: e.tasks } : {}),
      installed,
      state,
      progress: state === 'downloading' ? (this.progress.get(id) ?? 0) : null,
      ...(installed ? { diskUsedBytes: e.sizeBytes } : {}),
      ...(state === 'error' ? { error: this.errors.get(id) } : {}),
    }
  }

  list(): ModelsResponse {
    const models = this.manifest.map((m) => this.info(m.id))
    const diskUsedBytes = models.reduce((n, m) => n + (m.diskUsedBytes ?? 0), 0)
    return { models, diskUsedBytes }
  }

  /** Start (or join) an install. Resolves when the model is installed; rejects on failure. */
  install(id: string): Promise<void> {
    const entry = this.entry(id)
    if (this.isInstalled(id)) return Promise.resolve()
    const running = this.inflight.get(id)
    if (running) return running
    this.errors.delete(id)
    this.progress.set(id, 0)
    const task = this.download(entry)
      .then(() => {
        this.registry[id] = {
          sha256: entry.sha256,
          file: entry.file,
          installedAt: new Date().toISOString(),
        }
        this.writeRegistry()
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.errors.set(id, message)
        throw new ModelError('MODEL_INSTALL_FAILED', message)
      })
      .finally(() => {
        this.inflight.delete(id)
        this.progress.delete(id)
        this.bus.emit({ type: 'model.state', modelId: id, state: this.stateOf(id) })
      })
    this.inflight.set(id, task)
    this.bus.emit({ type: 'model.state', modelId: id, state: 'downloading' })
    return task
  }

  private async download(entry: ManifestEntry): Promise<void> {
    const target = join(this.dir, entry.file)
    const part = `${target}.part`
    rmSync(part, { force: true })
    const res = await this.fetchImpl(this.urlFor(entry), { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)

    const hash = createHash('sha256')
    let received = 0
    let lastPct = -1
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        hash.update(chunk)
        received += chunk.length
        if (received > entry.sizeBytes) {
          cb(new Error(`download exceeds the pinned size (${entry.sizeBytes} bytes)`))
          return
        }
        const pct = Math.floor((received / entry.sizeBytes) * 100)
        if (pct !== lastPct) {
          lastPct = pct
          this.progress.set(entry.id, received / entry.sizeBytes)
          this.bus.emit({
            type: 'model.install.progress',
            modelId: entry.id,
            progress: received / entry.sizeBytes,
          })
        }
        cb(null, chunk)
      },
    })
    try {
      await pipeline(Readable.fromWeb(res.body as NodeWebStream), meter, createWriteStream(part))
      const digest = hash.digest('hex')
      if (received !== entry.sizeBytes) {
        throw new Error(`size mismatch: got ${received} bytes, pinned ${entry.sizeBytes}`)
      }
      if (digest !== entry.sha256) {
        throw new Error(`checksum mismatch: got ${digest}, pinned ${entry.sha256}`)
      }
      renameSync(part, target)
    } catch (err) {
      rmSync(part, { force: true })
      throw err
    }
  }

  /** Delete the artifact; returns bytes freed. */
  remove(id: string): number {
    const entry = this.entry(id)
    if (this.inflight.has(id))
      throw new ModelError('MODEL_INSTALL_FAILED', `Model '${id}' is downloading`)
    const file = join(this.dir, entry.file)
    const freed = existsSync(file) ? statSync(file).size : 0
    rmSync(file, { force: true })
    delete this.registry[id]
    this.writeRegistry()
    this.errors.delete(id)
    this.bus.emit({ type: 'model.state', modelId: id, state: 'not-installed' })
    return freed
  }
}
