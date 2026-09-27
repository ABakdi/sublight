import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { loadConfig } from './config'
import { createApp } from './app'
import { allowedOrigins } from './auth'
import { Logger } from './logger'
import { enginePaths } from './paths'
import { createServices } from './services'
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

  attachWebSocket(server, {
    port: config.port,
    token: config.token,
    origins: allowedOrigins(config.allowedOrigins),
    bus: services.bus,
  })
  services.jobs.start()

  let shuttingDown = false
  async function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`${signal}: interrupting running jobs and exiting`)
    // Hard-exit guard if anything hangs.
    setTimeout(() => process.exit(1), 8000).unref()
    await services.jobs.shutdown()
    await services.whisper.stop()
    await services.llama.stop()
    rmSync(pidFile, { force: true })
    server.close(() => process.exit(0))
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  return listening
}

/** Where a running engine records its pid. */
export const enginePidFile = (runDir: string) => join(runDir, 'engine.pid')
