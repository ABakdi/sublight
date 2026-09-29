import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Smart idle (M06b.5): an engine nobody uses gives its memory back, then goes
 * away, and the extension starts it again when it's needed (M06b.4).
 *
 * - **Work** (an open job, a live session, a relay download, a model install)
 *   keeps it fully awake, however long it takes.
 * - **Activity** (requests; not status probes or open WebSockets, which an
 *   idle Player tab would hold forever) resets the clock.
 * - After `unloadMinutes` idle the model servers stop, freeing VRAM and RAM;
 *   the next job loads its model again.
 * - After `exitMinutes` idle the engine exits, only when it was started in the
 *   background (by the extension or `start --detach`): an engine run in a
 *   terminal, or by autostart, stays.
 * - On battery both delays are halved. 0 turns a stage off.
 */
export interface IdleConfig {
  unloadMinutes: number
  exitMinutes: number
}

export interface IdleDeps {
  config: IdleConfig
  /** Why the engine can't be idle right now, or null. */
  busy(): string | null
  /** Stop the model servers; true when one was running. */
  unload(): Promise<boolean>
  /** Called once, when it is time to exit. */
  exit?(reason: string): void
  onBattery?(): boolean
  now?(): number
  log?(message: string): void
}

export interface IdleState {
  /** How long nothing has happened, ms (0 while busy). */
  idleMs: number
  /** The models were unloaded for idleness and nothing has loaded one since. */
  unloaded: boolean
  /** When the engine exits if nothing happens, ms from now; null when it won't. */
  exitInMs: number | null
}

export class IdleMonitor {
  private last: number
  private unloaded = false
  private exiting = false
  private readonly now: () => number

  constructor(private readonly deps: IdleDeps) {
    this.now = deps.now ?? Date.now
    this.last = this.now()
  }

  /** Let idleness end the engine (only one started in the background). */
  exitWith(exit: (reason: string) => void): void {
    this.deps.exit = exit
  }

  /** Something happened: the clock starts again. */
  touch(): void {
    this.last = this.now()
    this.unloaded = false
  }

  /** The delays in effect (halved on battery), ms; 0 = never. */
  private delays(): { unload: number; exit: number } {
    const f = this.deps.onBattery?.() ? 0.5 : 1
    const { unloadMinutes, exitMinutes } = this.deps.config
    return {
      unload: Math.max(0, unloadMinutes) * 60_000 * f,
      exit: this.deps.exit ? Math.max(0, exitMinutes) * 60_000 * f : 0,
    }
  }

  state(): IdleState {
    const busy = this.deps.busy() !== null
    const idleMs = busy ? 0 : this.now() - this.last
    const { exit } = this.delays()
    return {
      idleMs,
      unloaded: this.unloaded,
      exitInMs: exit > 0 ? Math.max(0, exit - idleMs) : null,
    }
  }

  /** Check the clock; run it every half minute or so. */
  async tick(): Promise<void> {
    if (this.exiting) return
    if (this.deps.busy() !== null) {
      this.touch()
      return
    }
    const idle = this.now() - this.last
    const { unload, exit } = this.delays()
    if (unload > 0 && idle >= unload && !this.unloaded) {
      this.unloaded = true
      if (await this.deps.unload())
        this.deps.log?.(`idle for ${Math.round(idle / 60_000)} min: models unloaded`)
    }
    if (exit > 0 && idle >= exit) {
      this.exiting = true
      this.deps.exit?.(`idle for ${Math.max(1, Math.round(idle / 60_000))} min`)
    }
  }
}

/**
 * On battery power (Linux): a battery is present and no mains or USB supply
 * is online. Desktops (no battery) and unknown systems are never "on battery".
 */
export function onBattery(root = '/sys/class/power_supply'): boolean {
  if (!existsSync(root)) return false
  let battery = false
  let external = false
  for (const name of readdirSync(root)) {
    const read = (f: string) => {
      try {
        return readFileSync(join(root, name, f), 'utf8').trim()
      } catch {
        return ''
      }
    }
    const type = read('type')
    if (type === 'Battery' && read('present') !== '0') battery = true
    if ((type === 'Mains' || type === 'USB') && read('online') === '1') external = true
  }
  return battery && !external
}
