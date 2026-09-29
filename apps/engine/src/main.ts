import { join } from 'node:path'
import { autostart, currentLaunch } from './autostart'
import { loadConfig, rotateToken, sublightHome } from './config'
import { ENGINE_VERSION } from './health'
import { enginePaths } from './paths'
import { findPlayerDir } from './player-server'
import { health, startDetached, stopEngine } from './lifecycle'
import { nativeHost } from './native-host'
import { runServer } from './server'
import { modelCli } from './model-cli'
import { setup } from './setup'
import { transcribe } from './transcribe-cli'

const USAGE = `sublight-engine ${ENGINE_VERSION}: the local sublight engine

usage: sublight-engine <command>

  start [--detach]   run the engine (in the foreground, or in the background)
  stop               stop a running engine, letting jobs wind down
  status             is it running? version, uptime and jobs
  autostart <enable|disable|status>
                     start the engine when you log in
  token [--rotate]   print the pairing token (for pasting by hand), or
                     replace it: every app must pair again
  transcribe <file>  caption one file without a server (--help for options)
  setup <whisper|llama|yt-dlp|status>
                     install the programs the engine runs (--help for options)
  model <list|install <id>|remove <id>>
                     the speech and translation models

Data lives in ${sublightHome()} (SUBLIGHT_HOME overrides).`

const url = () => `http://127.0.0.1:${loadConfig().port}`

/** " · Player at …" when this engine serves one. */
function playerNote(): string {
  const { player } = loadConfig()
  return player.port > 0 && findPlayerDir(player.dir)
    ? ` · Player at http://127.0.0.1:${player.port}/`
    : ''
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
  const r = await startDetached()
  if (!r.ok) {
    console.error(`${r.error}: see ${r.log}`)
    return 1
  }
  console.log(`sublight engine started at ${url()}${playerNote()} (pid ${r.pid ?? '?'})`)
  return 0
}

async function stop(): Promise<number> {
  const r = await stopEngine()
  if (!r.ok) {
    console.error(r.error)
    return 1
  }
  console.log(r.wasRunning ? 'the engine stopped' : 'the engine is not running')
  return 0
}

/** A new token, through the running engine if there is one (it drops old connections). */
async function rotate(): Promise<number> {
  const config = loadConfig()
  if (await health()) {
    const res = await fetch(`http://127.0.0.1:${config.port}/v1/token/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}` },
    })
    if (!res.ok) {
      console.error(`the engine refused: HTTP ${res.status}`)
      return 1
    }
  } else rotateToken(config)
  console.log('new token saved: the extension and the Player must pair again')
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
  for (const b of h.binaries ?? [])
    if (b.state !== 'ok')
      console.log(`warning: the ${b.name} binary is ${b.state}: rerun its setup script`)
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
      if (args.includes('--rotate')) return rotate()
      console.log(loadConfig().token)
      console.error(`(from ${sublightHome()}/config.json)`)
      return 0
    case 'transcribe':
      return transcribe(args)
    case 'setup':
      return setup(args)
    case 'model':
    case 'models':
      return modelCli(args)
    case 'native-host':
      return nativeHost(args)
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
