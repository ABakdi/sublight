import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { loadConfig } from './config'
import { createApp } from './app'
import { clientOrigins } from './auth'
import { findPlayerDir, servePlayer } from './player-server'
import { Logger } from './logger'
import { enginePaths } from './paths'
import { createServices } from './services'
import { verifyBinaries } from './workers/verify'
import { attachWebSocket } from './ws'

/**
 * Run the engine in this process until SIGINT/SIGTERM (Spec 06): HTTP and
 * WebSocket on 127.0.0.1, the job queue, and a pid file in `run/` so
 * `sublight-engine stop` can find it. Resolves once it's listening.
 */
export function runServer(): Promise<{ port: number }> {
  const config = loadConfig()
  const paths = enginePaths()
  const log = new Logger(paths.logs)
  const services = createServices(config, paths)
  const app = createApp(config, {
    services,
    onPairingRequest: (req, url) =>
      log.info(`pairing request from ${req.origin}, code ${req.code}: approve at ${url}`),
    onTokenRotated: () => {
      log.info('token rotated: every client must pair again')
      for (const client of wss.clients) client.close(4401, 'UNAUTHORIZED')
    },
  })

  // Job lifecycle and model installs go to the JSONL log (Spec 06 §8).
  services.bus.on((e) => {
    if (e.type === 'job.state') log.info('job state', { jobId: e.jobId, state: e.state })
    else if (e.type === 'job.log') log.log(e.level, e.message, { jobId: e.jobId })
    else if (e.type === 'model.state')
      log.info('model state', { modelId: e.modelId, state: e.state })
  })

  const pidFile = enginePidFile(paths.run)
  let resolveListening!: (v: { port: number }) => void
  let rejectListening!: (err: Error) => void
  const listening = new Promise<{ port: number }>((res, rej) => {
    resolveListening = res
    rejectListening = rej
  })
  const server = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: config.port,
    },
    (info) => {
      mkdirSync(paths.run, { recursive: true })
      writeFileSync(pidFile, `${process.pid}\n`)
      log.info(`engine listening on http://127.0.0.1:${info.port}`, { home: paths.home })
      resolveListening({ port: info.port })
    },
  ) as Server
  server.on('error', (err: NodeJS.ErrnoException) => {
    const message =
      err.code === 'EADDRINUSE'
        ? `port ${config.port} is in use: is the engine already running? (sublight-engine status)`
        : err.message
    log.error(message)
    rejectListening(new Error(message))
  })

  // onTokenRotated (above) only runs once this exists.
  const wss = attachWebSocket(server, {
    port: config.port,
    token: () => config.token,
    origins: clientOrigins(config),
    bus: services.bus,
  })
  services.jobs.start()

  // Are the worker binaries still the ones setup built? Warn if not (baseline E2).
  void verifyBinaries(paths.bin).then((checks) => {
    services.binaries = checks
    for (const b of checks)
      if (b.state !== 'ok')
        log.warn(
          `${b.name} binary is ${b.state} (expected ${b.tag ?? 'a recorded build'}): rerun its setup script`,
        )
  })

  // The Player, when it's built (Spec 06 §1): a missing build or a busy port
  // costs the Player only, never the engine.
  let player: Server | null = null
  const playerDir = config.player.port > 0 ? findPlayerDir(config.player.dir) : null
  if (config.player.port > 0 && !playerDir)
    log.info('no Player build found (pnpm build, or player.dir in config.json)')
  if (playerDir)
    void servePlayer(playerDir, config.player.port).then(
      (s) => {
        player = s
        log.info(`Player at http://127.0.0.1:${config.player.port}/`, { dir: playerDir })
      },
      (err: NodeJS.ErrnoException) =>
        log.error(`the Player can't use port ${config.player.port}: ${err.code ?? err.message}`),
    )

  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    log.info(
      signal.startsWith('idle')
        ? `${signal}: exiting (the extension starts it again when needed)`
        : `${signal}: interrupting running jobs and exiting`,
    )
    services.idle.touch()
    // Hard-exit guard if anything hangs.
    setTimeout(() => process.exit(1), 8000).unref()
    await services.jobs.shutdown()
    await services.whisper.stop()
    await services.llama.stop()
    rmSync(pidFile, { force: true })
    player?.close()
    server.close(() => process.exit(0))
  }

  // Smart idle (M06b.5): an engine started in the background (by the extension
  // or `start --detach`) exits when idle; one run in a terminal stays.
  if (process.env.SUBLIGHT_IDLE_EXIT === '1')
    services.idle.exitWith((reason) => void shutdown(reason))
  setInterval(() => void services.idle.tick(), 30_000).unref()

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  return listening
}

/** Where a running engine records its pid. */
export const enginePidFile = (runDir: string) => join(runDir, 'engine.pid')
