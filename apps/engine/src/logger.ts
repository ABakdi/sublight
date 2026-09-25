import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 10 * 1024 * 1024
const KEEP = 5

/**
 * JSONL engine log (Spec 06 §8): ~/.sublight/logs/engine.log, rotated at
 * 10 MB × 5 files. Lines are mirrored to the console for `pnpm dev:engine`.
 */
export class Logger {
  private readonly file: string

  constructor(
    dir: string,
    private readonly echo = true,
  ) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'engine.log')
  }

  private rotate(): void {
    if (!existsSync(this.file) || statSync(this.file).size < MAX_BYTES) return
    rmSync(`${this.file}.${KEEP}`, { force: true })
    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`)
    }
    renameSync(this.file, `${this.file}.1`)
  }

  log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
    try {
      this.rotate()
      appendFileSync(
        this.file,
        JSON.stringify({ t: new Date().toISOString(), level, message, ...fields }) + '\n',
      )
    } catch {
      // Logging must never take the engine down.
    }
    if (this.echo) {
      const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''
      ;(level === 'error' ? console.error : console.log)(`[sublight] ${message}${extra}`)
    }
  }

  info(message: string, fields?: Record<string, unknown>) {
    this.log('info', message, fields)
  }
  warn(message: string, fields?: Record<string, unknown>) {
    this.log('warn', message, fields)
  }
  error(message: string, fields?: Record<string, unknown>) {
    this.log('error', message, fields)
  }
}
