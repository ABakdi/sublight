import { runServer } from './server'

// `pnpm dev` / `pnpm start`: the engine in the foreground.
runServer().catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})
