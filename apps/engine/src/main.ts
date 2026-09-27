import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthResponse } from '@sublight/protocol'
import { autostart, currentLaunch } from './autostart'
import { loadConfig, sublightHome } from './config'
import { ENGINE_VERSION } from './health'
import { enginePaths } from './paths'
import { findPlayerDir } from './player-server'
import { enginePidFile, runServer } from './server'
import { transcribe } from './transcribe-cli'

const USAGE = `sublight-engine ${ENGINE_VERSION}: the local sublight engine

usage: sublight-engine <command>

  start [--detach]   run the engine (in the foreground, or in the background)
  stop               stop a running engine, letting jobs wind down
  status             is it running? version, uptime and jobs
  autostart <enable|disable|status>
                     start the engine when you log in
  token              print the pairing token (for pasting by hand)
  transcribe <file>  caption one file without a server (--help for options)

Data lives in ${sublightHome()} (SUBLIGHT_HOME overrides).`

/** The running engine's health, or null if nothing answers. */
async function health(): Promise<HealthResponse | null> {
  const { port, token } = loadConfig()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    })
    return res.ok ? ((await res.json()) as HealthResponse) : null
  } catch {
    return null
  }
}

const url = () => `http://127.0.0.1:${loadConfig().port}`

/** " · Player at …" when this engine serves one. */
function playerNote(): string {
  const { player } = loadConfig()
  return player.port > 0 && findPlayerDir(player.dir)
    ? ` · Player at http://127.0.0.1:${player.port}/`
    : ''
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(): number | null {
  const file = enginePidFile(enginePaths().run)
  if (!existsSync(file)) return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) return pid
  rmSync(file, { force: true }) // left behind by a crash
  return null
}

async function start(args: string[]): Promise<number | null> {
  if (await health()) {
    console.log(`the engine is already running at ${url()}${playerNote()}`)
    return 0
  }
  if (!args.includes('--detach')) {
    const { port } = await runServer()
    console.log(
      `sublight engine ${ENGINE_VERSION} at http://127.0.0.1:${port}${playerNote()} (Ctrl+C stops it)`,
    )
    return null // keep running
  }
  // Same program, same runtime flags (tsx in development), in its own session.
  const logs = enginePaths().logs
  mkdirSync(logs, { recursive: true })
  const out = openSync(join(logs, 'engine.out'), 'a')
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'start'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    if (await health()) {
      console.log(`sublight engine started at ${url()}${playerNote()} (pid ${child.pid})`)
      return 0
    }
    if (child.exitCode !== null) break
  }
  console.error(`the engine didn't start: see ${join(logs, 'engine.out')}`)
  return 1
}

async function stop(): Promise<number> {
  const pid = readPid()
  if (!pid) {
    if (!(await health())) {
      console.log('the engine is not running')
      return 0
    }
    console.error('the engine runs without a pid file here: stop it where it runs')
    return 1
  }
  process.kill(pid, 'SIGTERM')
  // The engine gives jobs up to 8 s to wind down.
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(200)
  if (alive(pid)) {
    console.error(`the engine (pid ${pid}) didn't stop`)
    return 1
  }
  console.log('the engine stopped')
  return 0
}

async function status(): Promise<number> {
  const h = await health()
  if (!h) {
    console.log('the engine is not running')
    return 3 // like `systemctl status`
  }
  const minutes = Math.round(h.engineUptimeMs / 60_000)
  console.log(
    [
      `running at ${url()}`,
      `version ${h.version}`,
      `up ${minutes} min`,
      `${h.activeJobs} running, ${h.queuedJobs ?? 0} queued`,
      h.gpu.available ? `GPU ${h.gpu.name ?? ''}`.trim() : 'CPU only',
    ].join(' · '),
  )
  return 0
}

async function main(argv: string[]): Promise<number | null> {
  const [command, ...args] = argv
  switch (command) {
    case 'start':
      return start(args)
    case 'stop':
      return stop()
    case 'status':
      return status()
    case 'autostart':
      return autostart(args, currentLaunch(join(enginePaths().logs, 'engine.out')))
    case 'token':
      console.log(loadConfig().token)
      console.error(`(from ${sublightHome()}/config.json)`)
      return 0
    case 'transcribe':
      return transcribe(args)
    case '--version':
    case 'version':
      console.log(ENGINE_VERSION)
      return 0
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return command ? 0 : 1
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`)
      return 1
  }
}

main(process.argv.slice(2)).then(
  (code) => code !== null && process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
