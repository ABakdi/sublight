import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WsEvent } from '@sublight/protocol'
import { EventBus } from '../src/events'
import { ModelError, ModelManager } from '../src/models/manager'
import { MODEL_MANIFEST, type ManifestEntry } from '../src/models/manifest'

const good = randomBytes(300_000)
const corrupt = Buffer.from(good)
corrupt[1234] = corrupt[1234]! ^ 0xff
const sha = createHash('sha256').update(good).digest('hex')

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = req.url === '/corrupt.bin' ? corrupt : req.url === '/good.bin' ? good : null
    if (!body) return res.writeHead(404).end()
    res.writeHead(200, { 'content-length': body.length }).end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const entry = (id: string, file: string): ManifestEntry => ({
  id,
  role: 'asr',
  name: id,
  repo: 'test/repo',
  revision: 'r1',
  file,
  sha256: sha,
  sizeBytes: good.length,
  vramClass: '-',
  license: 'MIT',
  tasks: ['transcribe'],
})

function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'sublight-models-'))
  const bus = new EventBus()
  const events: WsEvent[] = []
  bus.on((e) => events.push(e))
  const models = new ModelManager(dir, bus, {
    manifest: [entry('good', 'good.bin'), entry('corrupt', 'corrupt.bin')],
    urlFor: (e) => `${base}/${e.file}`,
  })
  return { dir, models, events }
}

describe('model manager (Spec 06 §3, ADR-0016)', () => {
  it('installs a pinned artifact after verifying its SHA-256, with progress events', async () => {
    const { models, events, dir } = manager()
    expect(models.info('good').state).toBe('not-installed')
    await models.install('good')
    expect(models.info('good')).toMatchObject({ installed: true, state: 'installed' })
    expect(models.pathOf('good')).toBe(join(dir, 'good.bin'))
    expect(events.some((e) => e.type === 'model.install.progress' && e.progress === 1)).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'model.state', modelId: 'good', state: 'installed' })
  })

  it('refuses a corrupted artifact and leaves nothing behind', async () => {
    const { models, dir } = manager()
    await expect(models.install('corrupt')).rejects.toThrow(/checksum mismatch/)
    expect(models.info('corrupt')).toMatchObject({ installed: false, state: 'error' })
    expect(readdirSync(dir).filter((f) => f.startsWith('corrupt'))).toEqual([])
    expect(() => models.pathOf('corrupt')).toThrow(ModelError)
  })

  it('survives a restart and removes artifacts', async () => {
    const { models, dir } = manager()
    await models.install('good')
    const again = new ModelManager(dir, new EventBus(), {
      manifest: [entry('good', 'good.bin')],
      urlFor: (e) => `${base}/${e.file}`,
    })
    expect(again.isInstalled('good')).toBe(true)
    expect(again.remove('good')).toBe(good.length)
    expect(existsSync(join(dir, 'good.bin'))).toBe(false)
    expect(again.info('good').state).toBe('not-installed')
  })

  it('joins concurrent installs of the same model', async () => {
    const { models } = manager()
    const [a, b] = [models.install('good'), models.install('good')]
    expect(a).toBe(b)
    await a
  })

  it('pins every shipped model to a revision, a SHA-256 and a size', () => {
    for (const m of MODEL_MANIFEST) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.sizeBytes).toBeGreaterThan(0)
      if (m.role === 'asr') expect(m.tasks).toContain('transcribe')
    }
    // Turbo can't translate (ADR-0018); the default can.
    expect(MODEL_MANIFEST.find((m) => m.id === 'whisper-large-v3-turbo-q5')!.tasks).toEqual([
      'transcribe',
    ])
    expect(MODEL_MANIFEST.find((m) => m.id === 'whisper-small')!.tasks).toContain('translate')
  })
})
