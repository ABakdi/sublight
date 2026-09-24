import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { E2E_ENGINE_URL, E2E_ENGINE_HEALTH_URL, E2E_ENGINE_PORT, E2E_TOKEN } from './constants'

const repoRoot = `${resolve(process.cwd(), '..')}`
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

export default async function globalSetup(): Promise<() => void> {
  const home = mkdtempSync(join(tmpdir(), 'sublight-e2e-'))
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify(
      {
        token: E2E_TOKEN,
        port: E2E_ENGINE_PORT,
        defaults: { asrModel: 'whisper-small', translateModel: 'qwen2.5-3b-instruct' },
        autoRetry: true,
        cacheLimits: { mediaBytes: 20 * 1024 ** 3 },
      },
      null,
      2,
    ) + '\n',
  )

  const engine: ChildProcess = spawn(pnpm, ['--filter', '@sublight/engine', 'start'], {
    cwd: repoRoot,
    env: { ...process.env, SUBLIGHT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  engine.stdout?.on('data', (d) => process.stdout.write(`[e2e:engine] ${d}`))
  engine.stderr?.on('data', (d) => process.stderr.write(`[e2e:engine] ${d}`))

  const deadline = Date.now() + 15_000
  let ok = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(E2E_ENGINE_HEALTH_URL, {
        headers: { authorization: `Bearer ${E2E_TOKEN}` },
        signal: AbortSignal.timeout(2000),
      })
      if (res.status === 200) {
        ok = true
        break
      }
    } catch {
      // engine booting
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!ok) {
    engine.kill('SIGTERM')
    throw new Error(
      `engine did not become healthy at ${E2E_ENGINE_URL} within 15s — is the port already in use by an unrelated instance?`,
    )
  }

  if (process.env.EXTENSION_TESTS) {
    const build = spawnSync(pnpm, ['--filter', '@sublight/extension', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    if (build.status !== 0) throw new Error('extension build failed (required for EXTENSION_TESTS)')
  }

  return () => {
    engine.kill('SIGTERM')
  }
}
