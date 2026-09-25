import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { loadConfig } from './config'
import { createApp } from './app'
import { allowedOrigins } from './auth'
import { Logger } from './logger'
import { enginePaths } from './paths'
import { createServices } from './services'
import { attachWebSocket } from './ws'

const config = loadConfig()
const paths = enginePaths()
const log = new Logger(paths.logs)
const services = createServices(config, paths)
const app = createApp(config, { services })

// Job lifecycle and model installs go to the JSONL log (Spec 06 §8).
services.bus.on((e) => {
  if (e.type === 'job.state') log.info('job state', { jobId: e.jobId, state: e.state })
  else if (e.type === 'job.log') log.log(e.level, e.message, { jobId: e.jobId })
  else if (e.type === 'model.state') log.info('model state', { modelId: e.modelId, state: e.state })
})

const server = serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.port,
  },
  (info) => log.info(`engine listening on http://127.0.0.1:${info.port}`, { home: paths.home }),
) as Server

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
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
