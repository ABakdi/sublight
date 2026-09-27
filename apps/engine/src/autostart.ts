import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Start the engine when the user logs in (M06.4, Spec 06 §1): a systemd user
 * unit on Linux, a LaunchAgent on macOS. Windows has written instructions
 * only. Both restart the engine if it crashes, not after `sublight-engine stop`.
 */

export const UNIT_NAME = 'sublight-engine.service'
export const AGENT_LABEL = 'com.sublight.engine'

export interface Launch {
  /** The runtime, then its flags and the script: how this process was started. */
  command: string[]
  /** Kept so ffmpeg, yt-dlp and the workers are found the same way. */
  env: Record<string, string>
  logFile: string
}

const quoteUnit = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/["\\]/g, '\\$&')}"` : s)

export function systemdUnit(l: Launch): string {
  return `[Unit]
Description=sublight engine (local captions and translation)
After=network.target

[Service]
ExecStart=${l.command.map(quoteUnit).join(' ')} start
${Object.entries(l.env)
  .map(([k, v]) => `Environment=${quoteUnit(`${k}=${v}`)}`)
  .join('\n')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

const xml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function launchAgent(l: Launch): string {
  const strings = (xs: string[]) => xs.map((x) => `    <string>${xml(x)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([...l.command, 'start'])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(l.env)
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(l.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(l.logFile)}</string>
</dict>
</plist>
`
}

export const WINDOWS_STEPS = `Autostart on Windows isn't automatic yet. To start the engine at login:
  1. Open Task Scheduler → Create Task…
  2. Triggers: "At log on" (your user).
  3. Actions: Start a program: node, with arguments: "<path to sublight-engine.mjs>" start
  4. Settings: "If the task fails, restart every 1 minute".`

/** How to start this same program again, from this process. */
export function currentLaunch(logFile: string): Launch {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  if (process.env.SUBLIGHT_HOME) env.SUBLIGHT_HOME = process.env.SUBLIGHT_HOME
  return { command: [process.execPath, ...process.execArgv, process.argv[1]!], env, logFile }
}

type Os = 'linux' | 'darwin' | 'other'
const os = (): Os =>
  platform() === 'linux' ? 'linux' : platform() === 'darwin' ? 'darwin' : 'other'

function target(): { os: Os; file: string | null } {
  const o = os()
  if (o === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    return { os: o, file: join(config, 'systemd', 'user', UNIT_NAME) }
  }
  if (o === 'darwin')
    return { os: o, file: join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`) }
  return { os: o, file: null }
}

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

/** `sublight-engine autostart <enable|disable|status> [--print]`. */
export function autostart(args: string[], launch: Launch): number {
  const [action = 'status'] = args
  const { os: o, file } = target()
  if (!file) {
    console.log(WINDOWS_STEPS)
    return action === 'status' ? 3 : 1
  }
  const contents = o === 'linux' ? systemdUnit(launch) : launchAgent(launch)
  const uid = String(process.getuid?.() ?? '')
  try {
    switch (action) {
      case 'enable':
        if (args.includes('--print')) {
          console.log(`# ${file}\n${contents}`)
          return 0
        }
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, contents)
        if (o === 'linux') {
          run('systemctl', ['--user', 'daemon-reload'])
          run('systemctl', ['--user', 'enable', UNIT_NAME])
        } else {
          try {
            run('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`])
          } catch {
            // not loaded yet
          }
          run('launchctl', ['bootstrap', `gui/${uid}`, file])
        }
        console.log(`the engine will start when you log in (${file})`)
        return 0
      case 'disable':
        if (!existsSync(file)) {
          console.log('autostart is not enabled')
          return 0
        }
        if (o === 'linux') run('systemctl', ['--user', 'disable', UNIT_NAME])
        else
          try {
            run('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`])
          } catch {
            // already unloaded
          }
        rmSync(file, { force: true })
        if (o === 'linux') run('systemctl', ['--user', 'daemon-reload'])
        console.log('autostart disabled (a running engine keeps running: sublight-engine stop)')
        return 0
      case 'status':
        console.log(
          existsSync(file) ? `autostart is enabled (${file})` : 'autostart is not enabled',
        )
        return existsSync(file) ? 0 : 3
      default:
        console.error('usage: sublight-engine autostart <enable [--print] | disable | status>')
        return 1
    }
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    console.error(`autostart ${action} failed: ${(e.stderr || e.message).trim()}`)
    return 1
  }
}
