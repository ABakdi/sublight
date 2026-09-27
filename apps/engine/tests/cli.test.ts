import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('sublight-engine command (M06.2)', () => {
  const home = mkdtempSync(join(tmpdir(), 'sublight-cli-'))
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
      env: { ...process.env, SUBLIGHT_HOME: home },
      encoding: 'utf8',
      timeout: 30_000,
    })
  afterAll(() => run('stop'))

  it('starts in the background, reports status, and stops', async () => {
    const [port, whisper, llama] = [await freePort(), await freePort(), await freePort()]
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        port,
        whisper: { port: whisper, gpu: 'off', threads: 1 },
        llama: { port: llama, gpu: 'off', threads: 1, contextTokens: 1024 },
        player: { port: 0 },
      }),
    )
    expect(run('status').status).toBe(3)

    const started = run('start', '--detach')
    expect(started.stdout).toContain(`started at http://127.0.0.1:${port}`)
    expect(existsSync(join(home, 'run', 'engine.pid'))).toBe(true)

    const status = run('status')
    expect(status.status).toBe(0)
    expect(status.stdout).toMatch(/running at .* version \d/)
    expect(run('start', '--detach').stdout).toContain('already running')
    expect(run('token').stdout.trim()).toBe('a'.repeat(64))
    // Rotating through the running engine: the old token stops working.
    expect(run('token', '--rotate').stdout).toContain('pair again')
    const next = run('token').stdout.trim()
    expect(next).toMatch(/^[0-9a-f]{64}$/)
    expect(next).not.toBe('a'.repeat(64))
    expect(run('status').status).toBe(0) // status reads the new token

    expect(run('stop').stdout).toContain('stopped')
    expect(existsSync(join(home, 'run', 'engine.pid'))).toBe(false)
    expect(run('status').status).toBe(3)
  }, 60_000)

  it('explains itself', () => {
    expect(run('--help').stdout).toContain('start [--detach]')
    expect(run('frobnicate').status).toBe(1)
  })
})
