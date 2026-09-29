import type { ModelInfo, ModelsResponse } from '@sublight/protocol'
import { loadConfig } from './config'
import { EventBus } from './events'
import { ModelError, ModelManager } from './models/manager'
import { enginePaths } from './paths'

/**
 * `sublight-engine model list | install <id> | remove <id>`. Through the
 * running engine when there is one (it owns the models while it runs), else
 * directly on ~/.sublight/models, so install.sh can fetch the default model
 * before the engine ever starts.
 */
export const MODEL_USAGE = `usage: sublight-engine model <list | install <id> | remove <id>>`

const gb = (bytes: number | null) => (bytes === null ? '?' : `${(bytes / 1024 ** 3).toFixed(1)} GB`)

async function api<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const { port, token } = loadConfig()
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      throw new ModelError('MODEL_INSTALL_FAILED', body?.message ?? `HTTP ${res.status}`)
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof ModelError) throw err
    return null // not running
  }
}

function printList(r: ModelsResponse): void {
  for (const m of r.models)
    console.log(
      `${m.installed ? '●' : '○'} ${m.id.padEnd(26)} ${gb(m.sizeBytes).padStart(7)}  ${m.name}`,
    )
  console.log(`\n${gb(r.diskUsedBytes)} used · ${gb(r.diskFreeBytes)} free`)
}

function progressLine(id: string, p: number): void {
  process.stdout.write(`\r${id}: ${Math.round(p * 100)} %   `)
}

async function installThroughEngine(id: string): Promise<boolean> {
  const started = await api(`/v1/models/${encodeURIComponent(id)}/install`, { method: 'POST' })
  if (started === null) return false
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    const list = await api<ModelsResponse>('/v1/models')
    const m: ModelInfo | undefined = list?.models.find((x) => x.id === id)
    if (!m) throw new ModelError('MODEL_INSTALL_FAILED', 'the engine stopped')
    if (m.installed) break
    if (m.state === 'error') throw new ModelError('MODEL_INSTALL_FAILED', m.error ?? 'failed')
    progressLine(id, m.progress ?? 0)
  }
  return true
}

export async function modelCli(args: string[]): Promise<number> {
  const [command, id] = args
  try {
    if (command === 'list') {
      const r =
        (await api<ModelsResponse>('/v1/models')) ??
        new ModelManager(enginePaths().models, new EventBus()).list()
      printList(r)
      return 0
    }
    if ((command === 'install' || command === 'remove') && id) {
      if (command === 'remove') {
        const r = await api<{ freedBytes: number }>(`/v1/models/${encodeURIComponent(id)}/remove`, {
          method: 'POST',
        })
        const freed =
          r?.freedBytes ?? new ModelManager(enginePaths().models, new EventBus()).remove(id)
        console.log(`${id} removed (${gb(freed)} freed)`)
        return 0
      }
      if (!(await installThroughEngine(id))) {
        const bus = new EventBus()
        bus.on((e) => {
          if (e.type === 'model.install.progress' && e.modelId === id) progressLine(id, e.progress)
        })
        const models = new ModelManager(enginePaths().models, bus)
        models.assertRoom(id)
        await models.install(id)
      }
      process.stdout.write('\n')
      console.log(`${id} installed`)
      return 0
    }
  } catch (err) {
    if (err instanceof ModelError) {
      process.stdout.write('\n')
      console.error(`model: ${err.message}`)
      return 1
    }
    throw err
  }
  console.error(MODEL_USAGE)
  return 1
}
