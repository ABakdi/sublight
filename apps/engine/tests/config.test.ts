import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, sublightHome } from '../src/config'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'sublight-cfg-'))
}

afterEach(() => {
  process.env.SUBLIGHT_HOME = undefined
  process.env.SUBLIGHT_PORT = undefined
})

describe('engine config (Spec 06 §1)', () => {
  it('generates and persists a token on first run', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    const cfg = loadConfig()
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(sublightHome(), 'config.json'))).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(sublightHome(), 'config.json'), 'utf8'))
    expect(onDisk.token).toBe(cfg.token)
  })

  it('reuses an existing token across runs', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    const first = loadConfig()
    const second = loadConfig()
    expect(second.token).toBe(first.token)
  })

  it('honors the SUBLIGHT_PORT override without persisting it', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    process.env.SUBLIGHT_PORT = '18421'
    const cfg = loadConfig()
    expect(cfg.port).toBe(18421)
    const onDisk = JSON.parse(readFileSync(join(sublightHome(), 'config.json'), 'utf8'))
    expect(onDisk.port).toBe(17421) // persisted default only
  })
})
