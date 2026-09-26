import { useEffect, useState } from 'react'
import { ENGINE_BASE_URL } from '@sublight/protocol'
import { browser } from 'wxt/browser'
import {
  AUTO_LIVE_KEY,
  CAPTION_MODEL_KEY,
  COOKIES_KEY,
  DEFAULT_CAPTION_MODEL,
  TRANSLATE_MODEL,
} from '../../src/captionsController'
import { EngineBadge } from '../../src/EngineBadge'
import { engineRequest, getToken, probeEngine, setToken } from '../../src/engine'
import {
  DEFAULT_LIVE_MODEL,
  LIVE_LANGUAGE_KEY,
  DEFAULT_REFINE_MODEL,
  LIVE_MODEL_KEY,
  LIVE_REFINE_KEY,
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
      <FetchSettings />
      <TranslationModel online={status?.state === 'online'} />
      <Shortcuts />

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
  const [refine, setRefine] = useState(DEFAULT_REFINE_MODEL)
  const [captionModel, setCaptionModel] = useState(DEFAULT_CAPTION_MODEL)

  useEffect(() => {
    void browser.storage.local
      .get([LIVE_MODEL_KEY, LIVE_REFINE_KEY, LIVE_LANGUAGE_KEY, LIVE_TASK_KEY, CAPTION_MODEL_KEY])
      .then((got) => {
        setCaptionModel((got[CAPTION_MODEL_KEY] as string | undefined) || DEFAULT_CAPTION_MODEL)
        setTask((got[LIVE_TASK_KEY] as string | undefined) || 'transcribe')
        setRefine((got[LIVE_REFINE_KEY] as string | undefined) || DEFAULT_REFINE_MODEL)
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
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Captions</h2>
      <p style={{ fontSize: 13, color: colors.muted, margin: '0 0 12px', lineHeight: 1.5 }}>
        “Caption this video” and “Download SRT” transcribe ahead of playback with the captions
        model: a larger model is more accurate and still runs ahead. Live captions (under “More” in
        the popup) use the live models and are refined when you stop.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Captions model
          <select
            data-testid="caption-model-select"
            style={field}
            value={captionModel}
            onChange={(e) => {
              setCaptionModel(e.target.value)
              save({ [CAPTION_MODEL_KEY]: e.target.value })
            }}
          >
            {(models.length
              ? models
              : [{ id: captionModel, name: captionModel, installed: true }]
            ).map((m) => (
              <option key={m.id} value={m.id} disabled={!m.installed}>
                {m.name}
                {m.installed ? '' : ' (not installed)'}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Live drafts
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
          Final captions (on stop)
          <select
            data-testid="live-refine-model"
            style={field}
            value={refine}
            onChange={(e) => {
              setRefine(e.target.value)
              save({ [LIVE_REFINE_KEY]: e.target.value })
            }}
          >
            {(models.length ? models : [{ id: refine, name: refine, installed: true }]).map((m) => (
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

const sectionStyle = {
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
}
const hint = { fontSize: 13, color: colors.muted, margin: '0 0 12px', lineHeight: 1.5 }

const COOKIE_CHOICES: [string, string][] = [
  ['', 'Off'],
  ['brave', 'Brave'],
  ['chrome', 'Chrome'],
  ['chromium', 'Chromium'],
  ['edge', 'Edge'],
  ['firefox', 'Firefox'],
  ['opera', 'Opera'],
  ['vivaldi', 'Vivaldi'],
]

/** How the engine gets a page's video (ADR-0020). */
function FetchSettings() {
  const [cookies, setCookies] = useState('')
  const [autoLive, setAutoLive] = useState(true)
  useEffect(() => {
    void browser.storage.local.get([COOKIES_KEY, AUTO_LIVE_KEY]).then((got) => {
      setCookies((got[COOKIES_KEY] as string | undefined) ?? '')
      setAutoLive(got[AUTO_LIVE_KEY] !== false)
    })
  }, [])
  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Getting the video</h2>
      <p style={hint}>
        The engine fetches a video’s audio itself to caption it ahead of playback. Some sites
        (Instagram, private or age-restricted videos) only allow that when logged in.
      </p>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600, maxWidth: 360 }}>
        Use my browser login
        <select
          data-testid="cookies-browser"
          style={{
            font: '13px system-ui',
            padding: '6px 8px',
            borderRadius: 6,
            border: `1px solid ${colors.border}`,
          }}
          value={cookies}
          onChange={(e) => {
            setCookies(e.target.value)
            void browser.storage.local.set({ [COOKIES_KEY]: e.target.value })
          }}
        >
          {COOKIE_CHOICES.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <span style={{ fontWeight: 400, color: colors.muted, lineHeight: 1.4 }}>
          The engine (on this computer) reads that browser’s cookies with yt-dlp when it fetches a
          video. Nothing leaves your machine except the normal request to the site.
        </span>
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 12 }}>
        <input
          type="checkbox"
          data-testid="auto-live"
          checked={autoLive}
          onChange={(e) => {
            setAutoLive(e.target.checked)
            void browser.storage.local.set({ [AUTO_LIVE_KEY]: e.target.checked })
          }}
        />
        When a video can’t be fetched, caption it live instead (about 3 s behind)
      </label>
    </section>
  )
}

/** The LLM for "Translate to" languages other than English (installed on demand, ADR-0018). */
function TranslationModel({ online }: { online: boolean }) {
  const [info, setInfo] = useState<ModelsResponse['models'][number] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!online) return
    const load = () =>
      engineRequest<ModelsResponse>('/v1/models').then(
        (r) => setInfo(r.models.find((m) => m.id === TRANSLATE_MODEL) ?? null),
        () => {},
      )
    void load()
    const id = setInterval(() => void load(), 2000)
    return () => clearInterval(id)
  }, [online])
  const install = async () => {
    setError(null)
    try {
      await engineRequest(`/v1/models/${TRANSLATE_MODEL}/install`, { method: 'POST' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const gb = info?.sizeBytes ? `${(info.sizeBytes / 1e9).toFixed(1)} GB` : '2.5 GB'
  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Translation</h2>
      <p style={hint}>
        “Translate to” English works from the audio with the speech model. Other languages need the
        translation model ({info?.name ?? 'Qwen3-4B-Instruct'}, {gb}).
      </p>
      {!online ? (
        <span style={{ fontSize: 13, color: colors.muted }}>Connect the engine first.</span>
      ) : info?.installed ? (
        <span data-testid="translate-model-state" style={{ fontSize: 13, color: colors.ok }}>
          Installed
        </span>
      ) : info?.state === 'downloading' ? (
        <span data-testid="translate-model-state" style={{ fontSize: 13 }}>
          Downloading… {Math.round((info.progress ?? 0) * 100)} %
        </span>
      ) : (
        <button
          data-testid="translate-model-install"
          style={primaryButton}
          onClick={() => void install()}
        >
          Install ({gb})
        </button>
      )}
      {(error ?? info?.error) && (
        <div style={{ fontSize: 12, color: colors.bad, marginTop: 8 }}>{error ?? info?.error}</div>
      )}
    </section>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Alt+Shift+C', 'Caption this video / stop'],
  ['Alt+Shift+V', 'Captions on / off'],
  ['Alt+Shift+.', 'Delay +100 ms (captions later)'],
  ['Alt+Shift+,', 'Delay −100 ms (captions earlier)'],
  ['Alt+Shift+0', 'No delay'],
  ['Alt+Shift+T', 'Translate on / off (the last language used)'],
  ['Alt+Shift+K', 'Open / close the quick controls'],
  ['Alt+Shift+L', 'Live captions (live streams)'],
]

function Shortcuts() {
  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>Keyboard shortcuts</h2>
      <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td style={{ padding: '3px 16px 3px 0' }}>
                <kbd
                  style={{
                    font: '12px ui-monospace, monospace',
                    background: '#f2f4f7',
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}
                >
                  {keys}
                </kbd>
              </td>
              <td style={{ padding: '3px 0', color: colors.text }}>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ ...hint, marginTop: 10, marginBottom: 0 }}>
        Alt+Shift+C and Alt+Shift+L can be changed at brave://extensions/shortcuts (or
        chrome://extensions/shortcuts). The others work on a page with captions on.
      </p>
    </section>
  )
}
