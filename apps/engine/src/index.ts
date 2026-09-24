import { serve } from '@hono/node-server'
import { loadConfig } from './config'
import { createApp } from './app'

const config = loadConfig()
const app = createApp(config)

const server = serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.port,
  },
  (info) => {
    console.log(`[sublight] engine listening on http://127.0.0.1:${info.port}`)
  },
)

function shutdown(signal: string) {
  console.log(`[sublight] ${signal} — flushing jobs and exiting`)
  server.close(() => process.exit(0))
  // Hard-exit guard if the handler hangs.
  setTimeout(() => process.exit(1), 3000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
