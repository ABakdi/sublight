import { describe, expect, it } from 'vitest'
import { launchAgent, systemdUnit, type Launch } from '../src/autostart'

const launch: Launch = {
  command: ['/usr/bin/node', '/opt/sublight/sublight-engine.mjs'],
  env: { PATH: '/usr/local/bin:/usr/bin', SUBLIGHT_HOME: '/home/me/my sublight' },
  logFile: '/home/me/.sublight/logs/engine.out',
}

describe('autostart files (M06.4)', () => {
  it('writes a systemd user unit that restarts only on failure', () => {
    const unit = systemdUnit(launch)
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/sublight/sublight-engine.mjs start\n')
    expect(unit).toContain('Environment="SUBLIGHT_HOME=/home/me/my sublight"')
    expect(unit).toContain('Environment=PATH=/usr/local/bin:/usr/bin')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('writes a LaunchAgent that runs at login and keeps a crashed engine alive', () => {
    const plist = launchAgent({ ...launch, command: ['/usr/bin/node', '/a&b/engine.mjs'] })
    expect(plist).toContain('<string>/a&amp;b/engine.mjs</string>\n    <string>start</string>')
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toContain('<string>/home/me/.sublight/logs/engine.out</string>')
  })
})
