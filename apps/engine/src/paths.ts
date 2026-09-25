import { join } from 'node:path'
import { sublightHome } from './config'

/** On-disk layout under ~/.sublight (Spec 02 §5, Spec 06). */
export interface EnginePaths {
  home: string
  models: string
  mediaCache: string
  jobs: string
  logs: string
  bin: string
  /** pid files of supervised subprocesses. */
  run: string
}

export function enginePaths(home = sublightHome()): EnginePaths {
  return {
    home,
    models: join(home, 'models'),
    mediaCache: join(home, 'media-cache'),
    jobs: join(home, 'jobs'),
    logs: join(home, 'logs'),
    bin: join(home, 'bin'),
    run: join(home, 'run'),
  }
}
