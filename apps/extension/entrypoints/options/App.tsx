import { useEffect, useState } from 'react'
import { ENGINE_BASE_URL } from '@sublight/protocol'
import { browser } from 'wxt/browser'
import { EngineBadge } from '../../src/EngineBadge'
import { getToken, probeEngine, setToken } from '../../src/engine'
import type { EngineStatus } from '../../src/messages'
import { button, colors, primaryButton } from '../../src/ui'

/**
 * Options (Spec 09 §7): manual engine pairing for now: paste the token from
 * `pnpm engine:token`. The one-click `sublight://pair` flow, style editor,
 * defaults and cache controls land in M06.
 */
export function OptionsApp() {
  const [token, setTokenInput] = useState('')
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void getToken().then((t) => {
      setTokenInput(t ?? '')
      void probeEngine(t ?? undefined).then(setStatus)
    })
  }, [])

  const test = async () => {
    setStatus(null)
    setStatus(await probeEngine(token.trim() || undefined))
  }

  const save = async () => {
    await setToken(token)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    await test()
  }

  return (
    <main
      style={{
        maxWidth: 560,
        margin: '40px auto',
        padding: '0 24px',
        fontFamily: 'system-ui, sans-serif',
        color: colors.text,
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 4 }}>sublight options</h1>
      <p style={{ color: colors.muted, fontSize: 13, marginTop: 0 }}>
        Extension ID <code data-testid="extension-id">{browser.runtime.id}</code>
      </p>

      <section
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 16,
          marginTop: 20,
        }}
      >
        <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Engine pairing</h2>
        <p style={{ fontSize: 13, color: colors.muted, margin: '0 0 12px', lineHeight: 1.5 }}>
          The engine runs on this machine at <code>{ENGINE_BASE_URL}</code>. Print its token with{' '}
          <code>pnpm engine:token</code> in the sublight repo and paste it here. It is stored only
          in this browser profile, and web pages never see it.
        </p>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Engine token
          <input
            data-testid="token-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="64 hex characters"
            style={{
              font: '13px ui-monospace, monospace',
              padding: '7px 9px',
              borderRadius: 6,
              border: `1px solid ${colors.border}`,
            }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <button data-testid="token-save" style={primaryButton} onClick={() => void save()}>
            Save
          </button>
          <button style={button} onClick={() => void test()}>
            Test connection
          </button>
          {saved && <span style={{ fontSize: 12, color: colors.ok }}>Saved</span>}
        </div>
        <div style={{ marginTop: 14 }}>
          <EngineBadge status={status} />
        </div>
      </section>

      <p style={{ color: colors.muted, fontSize: 12, marginTop: 20 }}>
        Style presets, default models and languages, cache controls and one-click pairing arrive in
        M06.
      </p>
    </main>
  )
}
