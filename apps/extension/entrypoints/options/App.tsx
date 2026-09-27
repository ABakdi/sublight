import { useEffect, useState, type ReactNode } from 'react'
import { resolveStyle, type SubtitleCue } from '@sublight/core'
import { SubtitleOverlay } from '@sublight/overlay'
import { ENGINE_BASE_URL } from '@sublight/protocol'
import { browser } from 'wxt/browser'
import {
  AUTO_LIVE_KEY,
  CAPTION_MODEL_KEY,
  COOKIES_KEY,
  DEFAULT_CAPTION_MODEL,
  ENGLISH_VIA_KEY,
  TRANSLATE_MODEL,
} from '../../src/captionsController'
import { EngineBadge } from '../../src/EngineBadge'
import { PairButton } from '../../src/PairButton'
import { HIDE_SITE_CAPTIONS_KEY } from '../../src/siteCaptions'
import {
  appearanceFrom,
  CAPTION_STYLE_KEY,
  FONT_CHOICES,
  type CaptionAppearance,
} from '../../src/captionStyle'
import { DEFAULT_PLAYER_URL, PLAYER_URL_KEY } from '../../src/openInPlayer'
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
 * "Unpair every app" (M06.3): the engine makes a new token, so this browser,
 * the Player and anything else paired must pair again. Asks first.
 */
function UnpairAll({ onDone }: { onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unpair = async () => {
    setError(null)
    try {
      await engineRequest('/v1/token/rotate', { method: 'POST' })
      await setToken('')
      setConfirming(false)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div style={{ marginTop: 14, fontSize: 12, color: colors.muted, lineHeight: 1.5 }}>
      {confirming ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: colors.text }}>
            Every browser and Player paired with this engine will have to pair again.
          </span>
          <button data-testid="unpair-all-yes" style={button} onClick={() => void unpair()}>
            Unpair all
          </button>
          <button style={button} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          Lost a device, or shared the token by mistake?{' '}
          <button data-testid="unpair-all" style={button} onClick={() => setConfirming(true)}>
            Unpair every app
          </button>
        </>
      )}
      {error && <div style={{ color: colors.bad, marginTop: 6 }}>{error}</div>}
    </div>
  )
}

/**
 * Options (Spec 09 §7): engine pairing (one click, ADR-0022, or paste the
 * token from `sublight-engine token`), captions, caption style, fetching,
 * translation, shortcuts.
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
          The engine runs on this machine at <code>{ENGINE_BASE_URL}</code>. Pair once: the engine
          opens a page where you approve, and the token is stored only in this browser profile (web
          pages never see it).
        </p>
        <PairButton
          onPaired={() =>
            void getToken().then((t) => {
              setTokenInput(t ?? '')
              void probeEngine(t ?? undefined).then(setStatus)
            })
          }
        />
        <p style={{ fontSize: 12, color: colors.muted, margin: '14px 0 8px' }}>
          Or paste the token printed by <code>sublight-engine token</code>:
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
        {status?.state === 'online' && (
          <UnpairAll
            onDone={() => {
              setTokenInput('')
              void probeEngine().then(setStatus)
            }}
          />
        )}
      </section>

      <LiveSettings online={status?.state === 'online'} />
      <CaptionStyleSettings />
      <FetchSettings />
      <TranslationModel online={status?.state === 'online'} />
      <Shortcuts />

      <p style={{ color: colors.muted, fontSize: 12, marginTop: 20 }}>
        Models and cached audio are managed in the Sublight Player (Models tab). Finished jobs are
        forgotten after 30 days.
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

const PREVIEW_CUES: SubtitleCue[] = [
  { id: 'preview', startMs: 0, endMs: 60_000, text: 'Ask not what your country can do for you' },
]

function StyleRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 13,
      }}
    >
      <span>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{children}</span>
    </label>
  )
}

/**
 * How captions look on every site (M05.7, Spec 09 §7): the appearance half of
 * the style schema, with a live preview drawn by the same overlay the pages
 * use. Open pages update at once.
 */
function CaptionStyleSettings() {
  const [look, setLook] = useState<CaptionAppearance>({})
  useEffect(() => {
    void browser.storage.local
      .get(CAPTION_STYLE_KEY)
      .then((got) => setLook(appearanceFrom(got[CAPTION_STYLE_KEY])))
  }, [])
  const update = (patch: CaptionAppearance) => {
    const next = appearanceFrom({ ...look, ...patch })
    setLook(next)
    void browser.storage.local.set({ [CAPTION_STYLE_KEY]: next })
  }
  const reset = () => {
    setLook({})
    void browser.storage.local.remove(CAPTION_STYLE_KEY)
  }
  const s = resolveStyle(look)
  const field = {
    padding: '4px 6px',
    borderRadius: 6,
    border: `1px solid ${colors.border}`,
    fontSize: 13,
  }
  return (
    <section style={sectionStyle} data-testid="caption-style">
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Caption style</h2>
      <p style={hint}>
        How captions look on every site. Size and position are in the popup (Display), and follow
        the video’s shape.
      </p>
      <div
        data-testid="style-preview"
        style={{
          position: 'relative',
          aspectRatio: '16 / 9',
          borderRadius: 6,
          overflow: 'hidden',
          marginBottom: 12,
          background: 'linear-gradient(135deg, #3b4252 0%, #88a0b8 55%, #e5e9f0 100%)',
        }}
      >
        <SubtitleOverlay cues={PREVIEW_CUES} currentMs={1000} style={look} />
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <StyleRow label="Text color">
          <input
            type="color"
            data-testid="style-color"
            value={s.color}
            onChange={(e) => update({ color: e.target.value })}
          />
        </StyleRow>
        <StyleRow label="Background">
          <input
            type="color"
            data-testid="style-bg-color"
            value={s.bgColor}
            onChange={(e) => update({ bgColor: e.target.value })}
          />
          <input
            type="range"
            aria-label="Background opacity"
            data-testid="style-bg-opacity"
            min={0}
            max={1}
            step={0.05}
            value={s.bgOpacity}
            onChange={(e) => update({ bgOpacity: Number(e.target.value) })}
          />
        </StyleRow>
        <StyleRow label="Font">
          <select
            data-testid="style-font"
            style={field}
            value={
              FONT_CHOICES.some(([v]) => v === s.fontFamily) ? s.fontFamily : FONT_CHOICES[0]![0]
            }
            onChange={(e) => update({ fontFamily: e.target.value })}
          >
            {FONT_CHOICES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            data-testid="style-weight"
            style={field}
            value={s.fontWeight === 'bold' || Number(s.fontWeight) >= 600 ? 'bold' : 'normal'}
            onChange={(e) => update({ fontWeight: e.target.value as 'normal' | 'bold' })}
          >
            <option value="normal">Regular</option>
            <option value="bold">Bold</option>
          </select>
        </StyleRow>
        <StyleRow label="Edge">
          <select
            data-testid="style-edge"
            style={field}
            value={s.edgeStyle}
            onChange={(e) => update({ edgeStyle: e.target.value as typeof s.edgeStyle })}
          >
            <option value="none">None</option>
            <option value="outline">Outline</option>
            <option value="shadow">Drop shadow</option>
            <option value="raised">Raised</option>
          </select>
        </StyleRow>
        <StyleRow label="Letters">
          <select
            data-testid="style-casing"
            style={field}
            value={s.casing}
            onChange={(e) => update({ casing: e.target.value as typeof s.casing })}
          >
            <option value="normal">As spoken</option>
            <option value="uppercase">UPPERCASE</option>
            <option value="title">Title Case</option>
          </select>
        </StyleRow>
        <StyleRow label="Align">
          <select
            data-testid="style-align"
            style={field}
            value={s.align}
            onChange={(e) => update({ align: e.target.value as typeof s.align })}
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </StyleRow>
        <StyleRow label={`Opacity ${Math.round(s.opacity * 100)} %`}>
          <input
            type="range"
            aria-label="Caption opacity"
            data-testid="style-opacity"
            min={0.3}
            max={1}
            step={0.05}
            value={s.opacity}
            onChange={(e) => update({ opacity: Number(e.target.value) })}
          />
        </StyleRow>
      </div>
      <button data-testid="style-reset" style={{ ...button, marginTop: 12 }} onClick={reset}>
        Reset to default
      </button>
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
  const [hideSite, setHideSite] = useState(true)
  const [playerUrl, setPlayerUrl] = useState(DEFAULT_PLAYER_URL)
  useEffect(() => {
    void browser.storage.local
      .get([COOKIES_KEY, AUTO_LIVE_KEY, HIDE_SITE_CAPTIONS_KEY, PLAYER_URL_KEY])
      .then((got) => {
        setPlayerUrl((got[PLAYER_URL_KEY] as string | undefined) || DEFAULT_PLAYER_URL)
        setCookies((got[COOKIES_KEY] as string | undefined) ?? '')
        setAutoLive(got[AUTO_LIVE_KEY] !== false)
        setHideSite(got[HIDE_SITE_CAPTIONS_KEY] !== false)
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
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 8 }}>
        <input
          type="checkbox"
          data-testid="hide-site-captions"
          checked={hideSite}
          onChange={(e) => {
            setHideSite(e.target.checked)
            void browser.storage.local.set({ [HIDE_SITE_CAPTIONS_KEY]: e.target.checked })
          }}
        />
        Hide the site’s own captions (YouTube CC and others) while sublight’s are on
      </label>
      <label
        style={{
          display: 'grid',
          gap: 4,
          fontSize: 12,
          fontWeight: 600,
          marginTop: 12,
          maxWidth: 360,
        }}
      >
        Sublight Player address (for “Open in Sublight Player”)
        <input
          data-testid="player-url"
          style={{
            font: '13px system-ui',
            padding: '6px 8px',
            borderRadius: 6,
            border: `1px solid ${colors.border}`,
          }}
          value={playerUrl}
          onChange={(e) => setPlayerUrl(e.target.value)}
          onBlur={() =>
            void browser.storage.local.set({
              [PLAYER_URL_KEY]: playerUrl.trim() || DEFAULT_PLAYER_URL,
            })
          }
        />
      </label>
    </section>
  )
}

/** The LLM for "Translate to" languages other than English (installed on demand, ADR-0018). */
function TranslationModel({ online }: { online: boolean }) {
  const [info, setInfo] = useState<ModelsResponse['models'][number] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [englishVia, setEnglishVia] = useState<'whisper' | 'llm'>('whisper')
  useEffect(() => {
    void browser.storage.local
      .get(ENGLISH_VIA_KEY)
      .then((got) => setEnglishVia(got[ENGLISH_VIA_KEY] === 'llm' ? 'llm' : 'whisper'))
  }, [])
  const chooseEnglish = (via: 'whisper' | 'llm') => {
    setEnglishVia(via)
    void browser.storage.local.set({ [ENGLISH_VIA_KEY]: via })
  }
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
      <fieldset style={{ border: 'none', padding: 0, margin: '14px 0 0', display: 'grid', gap: 6 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
          English translation
        </legend>
        <label style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.4 }}>
          <input
            type="radio"
            name="english"
            data-testid="english-whisper"
            checked={englishVia === 'whisper'}
            onChange={() => chooseEnglish('whisper')}
          />
          <span>
            <b>Fast</b>: from the audio with the speech model, ready ahead of playback like the
            original captions.
          </span>
        </label>
        <label style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.4 }}>
          <input
            type="radio"
            name="english"
            data-testid="english-llm"
            checked={englishVia === 'llm'}
            onChange={() => chooseEnglish('llm')}
          />
          <span>
            <b>Better</b>: the translation model translates the transcript: more accurate wording
            and one English line per original line (best with “Show both”). It starts once the whole
            video is transcribed and is slower than watching on a 4 GB GPU: an 11-minute video took
            about 1.5 min to transcribe, then 9 min to translate (the original shows meanwhile).
            Needs the model above.
          </span>
        </label>
      </fieldset>
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
  ['Alt+Shift+B', 'Show the original and the translation together'],
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
