import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { LiveSession } from './session'

/**
 * Live sessions by job id. Audio can arrive before the queue starts the job
 * (another GPU job still finishing), so sessions open on first use from
 * either the HTTP routes or the runner.
 */
export class LiveHub {
  private sessions = new Map<string, LiveSession>()

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  get(jobId: string): LiveSession {
    let s = this.sessions.get(jobId)
    if (!s) {
      s = new LiveSession(join(this.dir, `${jobId}.pcm`))
      this.sessions.set(jobId, s)
    }
    return s
  }

  has(jobId: string): boolean {
    return this.sessions.has(jobId)
  }

  close(jobId: string): void {
    this.sessions.get(jobId)?.close()
    this.sessions.delete(jobId)
  }
}
