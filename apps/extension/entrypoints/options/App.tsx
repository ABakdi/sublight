import { useEffect, useState } from 'react'
import { ENGINE_BASE_URL } from '@sublight/protocol'
import { browser } from 'wxt/browser'
import { EngineBadge } from '../../src/EngineBadge'
import { engineRequest, getToken, probeEngine, setToken } from '../../src/engine'
import {
  DEFAULT_LIVE_MODEL,
  LIVE_LANGUAGE_KEY,
  LIVE_MODEL_KEY,
  LIVE_TASK_KEY,
} from '../../src/liveController'
import type { ModelsResponse } from '@sublight/protocol'
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

      <LiveSettings online={status?.state === 'online'} />

      <p style={{ color: colors.muted, fontSize: 12, marginTop: 20 }}>
        Style presets, default models and languages, cache controls and one-click pairing arrive in
        M06.
      </p>
    </main>
  )
}

const LANGUAGES: [string, string][] = [
  ['', 'Detect automatically'],
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
  ['ar', 'Arabic'],
  ['ja', 'Japanese'],
  ['zh', 'Chinese'],
]

/** Live-caption defaults (M05): speech model and spoken language. */
function LiveSettings({ online }: { online: boolean }) {
  const [models, setModels] = useState<ModelsResponse['models']>([])
  const [model, setModel] = useState(DEFAULT_LIVE_MODEL)
  const [language, setLanguage] = useState('')
  const [task, setTask] = useState('transcribe')

  useEffect(() => {
    void browser.storage.local
      .get([LIVE_MODEL_KEY, LIVE_LANGUAGE_KEY, LIVE_TASK_KEY])
      .then((got) => {
        setTask((got[LIVE_TASK_KEY] as string | undefined) || 'transcribe')
        setModel((got[LIVE_MODEL_KEY] as string | undefined) || DEFAULT_LIVE_MODEL)
        setLanguage((got[LIVE_LANGUAGE_KEY] as string | undefined) ?? '')
      })
  }, [])
  useEffect(() => {
    if (!online) return
    void engineRequest<ModelsResponse>('/v1/models').then(
      (r) => setModels(r.models.filter((m) => m.role === 'asr')),
      () => {},
    )
  }, [online])

  const save = (patch: Record<string, string>) => void browser.storage.local.set(patch)
  const field = {
    font: '13px system-ui',
    padding: '6px 8px',
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
  }

  return (
    <section
      style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 16, marginTop: 16 }}
    >
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Live captions</h2>
      <p style={{ fontSize: 13, color: colors.muted, margin: '0 0 12px', lineHeight: 1.5 }}>
        Used by “Caption live” in the popup. Faster models show captions sooner; they are refined
        when you stop.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Speech model
          <select
            data-testid="live-model"
            style={field}
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              save({ [LIVE_MODEL_KEY]: e.target.value })
            }}
          >
            {(models.length ? models : [{ id: model, name: model, installed: true }]).map((m) => (
              <option key={m.id} value={m.id} disabled={!m.installed}>
                {m.name}
                {m.installed ? '' : ' (not installed)'}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Spoken language
          <select
            data-testid="live-language"
            style={field}
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value)
              save({ [LIVE_LANGUAGE_KEY]: e.target.value })
            }}
          >
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Subtitles in
          <select
            data-testid="live-task"
            style={field}
            value={task}
            onChange={(e) => {
              setTask(e.target.value)
              save({ [LIVE_TASK_KEY]: e.target.value })
            }}
          >
            <option value="transcribe">The spoken language</option>
            <option value="translate">English (translated)</option>
          </select>
        </label>
      </div>
    </section>
  )
}
