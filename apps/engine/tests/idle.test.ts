import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IdleMonitor, onBattery, type IdleDeps } from '../src/idle'
import type { EngineServices } from '../src/services'

/** Smart idle (M06b.5): unload the models, then exit, and never during work. */
function monitor(over: Partial<IdleDeps> = {}) {
  let t = 0
  const events: string[] = []
  let busy: string | null = null
  const m = new IdleMonitor({
    config: { unloadMinutes: 5, exitMinutes: 20 },
    busy: () => busy,
    unload: async () => {
      events.push('unload')
      return true
    },
    exit: (reason) => events.push(`exit: ${reason}`),
    now: () => t,
    ...over,
  })
  return {
    m,
    events,
    at: async (minutes: number) => {
      t = minutes * 60_000
      await m.tick()
    },
    setBusy: (b: string | null) => (busy = b),
  }
}

describe('smart idle', () => {
  it('unloads the models after 5 min, once, and exits after 20', async () => {
    const { m, events, at } = monitor()
    await at(4)
    expect(events).toEqual([])
    await at(5)
    await at(6)
    expect(events).toEqual(['unload'])
    expect(m.state()).toMatchObject({ unloaded: true, exitInMs: 14 * 60_000 })
    await at(20)
    await at(21)
    expect(events).toEqual(['unload', 'exit: idle for 20 min'])
  })

  it('never stops while there is work, and starts counting when it ends', async () => {
    const { events, at, setBusy } = monitor()
    setBusy('1 job')
    await at(30)
    expect(events).toEqual([])
    setBusy(null)
    await at(34)
    expect(events).toEqual([])
    await at(35)
    expect(events).toEqual(['unload'])
  })

  it('a request starts the clock again', async () => {
    const { m, events, at } = monitor()
    await at(4)
    m.touch()
    await at(8)
    expect(events).toEqual([])
    await at(9)
    expect(events).toEqual(['unload'])
  })

  it('halves the delays on battery; 0 turns a stage off; no exit unless allowed', async () => {
    const battery = monitor({ onBattery: () => true })
    await battery.at(2.5)
    await battery.at(10)
    expect(battery.events).toEqual(['unload', 'exit: idle for 10 min'])

    const keep = monitor({ config: { unloadMinutes: 5, exitMinutes: 0 } })
    await keep.at(600)
    expect(keep.events).toEqual(['unload'])
    expect(keep.m.state().exitInMs).toBeNull()

    // An engine run in a terminal: nothing ever asked it to exit.
    const terminal = monitor({ exit: undefined })
    await terminal.at(600)
    expect(terminal.events).toEqual(['unload'])
  })
})

describe('on battery (Linux power_supply)', () => {
  const supply = (entries: Record<string, Record<string, string>>) => {
    const root = mkdtempSync(join(tmpdir(), 'sublight-power-'))
    for (const [name, files] of Object.entries(entries)) {
      mkdirSync(join(root, name))
      for (const [f, v] of Object.entries(files)) writeFileSync(join(root, name, f), `${v}\n`)
    }
    return root
  }
  it('is a battery with no mains or USB power online', () => {
    const laptop = (online: string) =>
      supply({ BAT0: { type: 'Battery', present: '1' }, AC: { type: 'Mains', online } })
    expect(onBattery(laptop('0'))).toBe(true)
    expect(onBattery(laptop('1'))).toBe(false)
    expect(onBattery(supply({ AC: { type: 'Mains', online: '1' } }))).toBe(false) // a desktop
    expect(onBattery('/nonexistent')).toBe(false)
  })
})

describe('what counts as activity', () => {
  it('requests do; status reads a forgotten page polls do not', async () => {
    const { createApp } = await import('../src/app')
    const { loadConfig } = await import('../src/config')
    process.env.SUBLIGHT_HOME = mkdtempSync(join(tmpdir(), 'sublight-idle-'))
    const config = { ...loadConfig(), token: 'a'.repeat(64), port: 17421 }
    let touched = 0
    const idle = { touch: () => touched++ }
    const app = createApp(config, {
      services: { idle } as unknown as EngineServices,
    })
    const call = async (method: string, path: string) =>
      await app.request(path, {
        method,
        headers: { host: '127.0.0.1:17421', authorization: `Bearer ${config.token}` },
      })
    for (const p of [
      '/v1/health',
      '/v1/version',
      '/v1/models',
      `/v1/media/relay/${'a'.repeat(32)}`,
    ])
      await call('GET', p).catch(() => null)
    expect(touched).toBe(0)
    await call('GET', `/v1/relay/${'a'.repeat(32)}`).catch(() => null) // watching a relayed video
    await call('POST', '/v1/jobs').catch(() => null)
    expect(touched).toBe(2)
  })
})
