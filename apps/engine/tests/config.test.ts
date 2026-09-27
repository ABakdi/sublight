import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, rotateToken, sublightHome } from '../src/config'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'sublight-cfg-'))
}

afterEach(() => {
  // Assigning `undefined` would store the string "undefined"; delete instead.
  delete process.env.SUBLIGHT_HOME
  delete process.env.SUBLIGHT_PORT
})

describe('engine config (Spec 06 §1)', () => {
  it('generates and persists a token on first run', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    const cfg = loadConfig()
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(sublightHome(), 'config.json'))).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(sublightHome(), 'config.json'), 'utf8'))
    expect(onDisk.token).toBe(cfg.token)
    expect(statSync(join(sublightHome(), 'config.json')).mode & 0o777).toBe(0o600) // it holds the token
  })

  it('makes an older, world-readable config private', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    const file = join(sublightHome(), 'config.json')
    writeFileSync(file, JSON.stringify({ token: 'c'.repeat(64) }), { mode: 0o644 })
    expect(loadConfig().token).toBe('c'.repeat(64))
    expect(statSync(file).mode & 0o777).toBe(0o600)
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

  it('persists a generated token when the config file has none', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    const file = join(sublightHome(), 'config.json')
    writeFileSync(file, JSON.stringify({ port: 17421 }))
    const first = loadConfig()
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    expect(loadConfig().token).toBe(first.token)
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe(first.token)
  })

  it('sets a corrupt config aside and writes a fresh one with a stable token', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    writeFileSync(join(sublightHome(), 'config.json'), '{ not json')
    const first = loadConfig()
    expect(loadConfig().token).toBe(first.token)
    expect(readdirSync(sublightHome()).some((f) => f.startsWith('config.json.corrupt-'))).toBe(true)
  })

  it('ignores a non-numeric SUBLIGHT_PORT', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    process.env.SUBLIGHT_PORT = 'undefined'
    expect(loadConfig().port).toBe(17421)
  })

  it('rotates the token in the file, and nothing else', () => {
    process.env.SUBLIGHT_HOME = tempHome()
    process.env.SUBLIGHT_PORT = '18000'
    const config = loadConfig()
    const old = config.token
    const next = rotateToken(config)
    expect(next).toMatch(/^[0-9a-f]{64}$/)
    expect(next).not.toBe(old)
    expect(config.token).toBe(next)
    const saved = JSON.parse(readFileSync(join(sublightHome(), 'config.json'), 'utf8'))
    expect(saved.token).toBe(next)
    expect(saved.port).toBe(17421) // the env override stays out of the file
    expect(statSync(join(sublightHome(), 'config.json')).mode & 0o777).toBe(0o600)
    delete process.env.SUBLIGHT_PORT
  })
})
