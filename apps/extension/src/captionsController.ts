import { browser } from 'wxt/browser'
import { cuesForMode, serializeSrt, type CaptionMode, type SubtitleTrack } from '@sublight/core'
import {
  isEnglish,
  WS_BASE_URL,
  type JobResult,
  type JobSummary,
  type WsEvent,
} from '@sublight/protocol'
import { engineRequest, getToken } from './engine'
import {
  describe,
  LIVE_LANGUAGE_KEY,
  LIVE_TASK_KEY,
  pickInstalled,
  startLive,
  stopLive,
} from './liveController'
import type { CaptionsState, Message, VideoState } from './messages'
import { TARGETS } from './quickControls'
import { TARGET_KEY } from './viewerControls'

/** Model for captions made ahead of playback (Options). */
export const CAPTION_MODEL_KEY = 'captionModel'
export const DEFAULT_CAPTION_MODEL = 'whisper-small'
/** The LLM translator for targets other than English (ADR-0018/0019). */
export const TRANSLATE_MODEL = 'qwen3-4b-instruct'
/** Options: let yt-dlp use this browser's login cookies ('' = off). */
export const COOKIES_KEY = 'cookiesFromBrowser'
/** Options: when a video can't be fetched, caption it live instead (default on). */
export const AUTO_LIVE_KEY = 'autoLiveFallback'

const stateKey = (tabId: number) => `captions:${tabId}`
/** The latest track per tab (drafts, then final), for the overlay and downloads. */
export const captionsTrackKey = (tabId: number) => `captionsTrack:${tabId}`
/** The finished translation of that track, if one was asked for. */
const translatedKey = (tabId: number) => `captionsTranslated:${tabId}`
export interface SavedCaptions {
  track: SubtitleTrack
  final: boolean
}

type Stored = CaptionsState & { frameId: number; task?: 'transcribe' | 'translate' }

const languageName = (code: string) => TARGETS.find(([c]) => c === code)?.[1] ?? code
const whisperTarget = (target: string) => isEnglish(target)

/**
 * One tab's captions made ahead of playback (ADR-0020, Spec 09 §5a): creates
 * the engine `url` job (the engine fetches the audio itself), follows it over
 * the engine WS, forwards the growing track to the page, where it shows at
 * exact media time, relays seeks, translates on request, and saves the SRT.
 *
 * "Translate to" English uses Whisper on the audio (a `url` job with
 * `task: "translate"`, still ahead of playback); any other language
 * translates the finished transcript with the LLM (a `translate` job).
 */
class CaptionsController {
  state: Stored
  private ws: WebSocket | null = null
  /** The page moved on while a download waits: keep transcribing, stop showing. */
  detached = false
  /** The language the viewer wants ('original' or a code). */
  target = 'original'
  private translation: { lang: string; jobId: string | null } | null = null
  private owner: { frameId: number; state: VideoState } | null = null

  constructor(tabId: number, frameId: number, jobId: string, title?: string) {
    this.state = {
      tabId,
      frameId,
      jobId,
      phase: 'starting',
      progress: 0,
      coverage: [],
      ...(title ? { title } : {}),
    }
  }

  get tabId(): number {
    return this.state.tabId
  }
  get jobId(): string {
    return this.state.jobId
  }

  setOwner(owner: { frameId: number; state: VideoState }): void {
    this.owner = owner
  }

  async save(patch: Partial<Stored>): Promise<void> {
    this.state = { ...this.state, ...patch }
    await browser.storage.session.set({ [stateKey(this.tabId)]: this.state })
  }

  toPage(msg: Message): void {
    if (this.detached) return
    void browser.tabs.sendMessage(this.tabId, msg, { frameId: this.state.frameId }).catch(() => {})
  }

  private note(note: string | null): void {
    this.toPage({ type: 'captions.ui', note })
  }

  async connect(): Promise<void> {
    const token = await getToken()
    const ws = new WebSocket(`${WS_BASE_URL}/ws`)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }))
      ws.send(JSON.stringify({ type: 'subscribe', jobIds: [this.jobId] }))
    }
    ws.onmessage = (m) => void this.onEvent(JSON.parse(String(m.data)) as WsEvent)
    // Missed events (SW restart, or a job that finished before we subscribed).
    const job = await engineRequest<JobSummary>(`/v1/jobs/${this.jobId}`).catch(() => null)
    if (job?.state === 'done') await this.finish()
    else if (job?.partial) await this.draft(job.partial)
  }

  private subscribe(jobId: string): void {
    const send = () => this.ws?.send(JSON.stringify({ type: 'subscribe', jobIds: [jobId] }))
    if (this.ws?.readyState === WebSocket.OPEN) send()
    else this.ws?.addEventListener('open', send, { once: true })
  }

  private async draft(track: SubtitleTrack): Promise<void> {
    // While a translation is shown, the transcript keeps growing underneath.
    if (!this.translationShown()) this.toPage({ type: 'captions.track', track, final: false })
    const saved: SavedCaptions = { track, final: false }
    await browser.storage.session.set({ [captionsTrackKey(this.tabId)]: saved })
    await this.save({ phase: 'captioning', coverage: track.coverage ?? [] })
    if (this.pendingTranslation())
      this.note(
        `Translating to ${languageName(this.target)} once the video is transcribed (${Math.round(this.state.progress * 100)} %).`,
      )
  }

  private translationShown(): boolean {
    return !!this.translation && this.translation.lang === this.target && !this.pendingTranslation()
  }

  private pendingTranslation(): boolean {
    return this.target !== 'original' && !whisperTarget(this.target) && this.state.phase !== 'done'
  }

  private async onEvent(e: WsEvent): Promise<void> {
    if (!('jobId' in e)) return
    if (this.translation?.jobId && e.jobId === this.translation.jobId) {
      await this.onTranslationEvent(e)
      return
    }
    if (e.jobId !== this.jobId) return
    if (e.type === 'job.partial') await this.draft(e.draft)
    else if (e.type === 'job.progress') {
      await this.save({
        progress: e.progress,
        ...(e.detail ? { detail: e.detail } : {}),
        ...(this.state.phase === 'starting' && e.detail?.startsWith('captioning')
          ? { phase: 'captioning' as const }
          : {}),
      })
    } else if (e.type === 'job.state') {
      if (e.state === 'done') await this.finish()
      else if (e.state === 'failed') {
        const job = await engineRequest<JobSummary>(`/v1/jobs/${this.jobId}`).catch(() => null)
        await this.fail(
          job?.error?.message ?? 'Captioning failed.',
          job?.error?.code === 'MEDIA_UNREACHABLE',
        )
      } else if (e.state === 'cancelled') {
        await this.save({ phase: 'stopped' })
        this.close()
      }
    }
  }

  private async finish(): Promise<void> {
    if (this.state.phase === 'done') return
    const result = await engineRequest<JobResult>(`/v1/jobs/${this.jobId}/result`)
    const track = result.tracks[0]
    if (track) {
      const saved: SavedCaptions = { track, final: true }
      await browser.storage.session.set({ [captionsTrackKey(this.tabId)]: saved })
    }
    const pending = this.state.pendingDownload
    await this.save({
      phase: 'done',
      progress: 1,
      detail: undefined,
      pendingDownload: undefined,
      coverage: [{ startMs: 0, endMs: Number.MAX_SAFE_INTEGER }],
    })
    if (track) {
      if (this.target !== 'original' && !whisperTarget(this.target)) {
        // Keep the transcript on screen until the translation arrives.
        this.toPage({ type: 'captions.track', track, final: true })
        await this.translate(track, this.target)
      } else this.toPage({ type: 'captions.track', track, final: true })
    }
    if (track && track.cues.length === 0) this.note('No speech found in this video.')
    if (pending && track) await saveSrt(await this.shownTrack(track), pending, this.state.title)
    if (!this.translation?.jobId) this.close()
  }

  /** The track the viewer sees: the translation when one is chosen and ready. */
  async shownTrack(original: SubtitleTrack): Promise<SubtitleTrack> {
    const got = await browser.storage.session.get(translatedKey(this.tabId))
    const t = got[translatedKey(this.tabId)] as { lang: string; track: SubtitleTrack } | undefined
    return t && t.lang === this.target ? t.track : original
  }

  private async translate(track: SubtitleTrack, lang: string): Promise<void> {
    if (track.language === lang || track.cues.length === 0) {
      this.note(null)
      return
    }
    const cached = await browser.storage.session.get(translatedKey(this.tabId))
    const done = cached[translatedKey(this.tabId)] as
      { lang: string; track: SubtitleTrack } | undefined
    if (done?.lang === lang) {
      this.translation = { lang, jobId: null }
      this.toPage({ type: 'captions.track', track: done.track, final: true })
      this.note(null)
      return
    }
    this.note(`Translating to ${languageName(lang)}…`)
    try {
      const job = await engineRequest<JobSummary>('/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'translate',
          track,
          model: TRANSLATE_MODEL,
          targetLang: lang,
          glossary: [],
          style: 'neutral',
          priority: 'interactive',
        }),
      })
      this.translation = { lang, jobId: job.id }
      this.subscribe(job.id)
      if (job.state === 'done') await this.translationDone(job.id, lang)
    } catch (err) {
      this.translation = null
      this.note(
        describe(err).includes('not installed')
          ? `Translating to ${languageName(lang)} needs the translation model (2.5 GB): install it in sublight’s Options.`
          : `Couldn’t translate: ${describe(err)}`,
      )
    }
  }

  private async onTranslationEvent(e: WsEvent): Promise<void> {
    const t = this.translation!
    if (e.type === 'job.partial' && t.lang === this.target)
      this.toPage({ type: 'captions.track', track: e.draft, final: true })
    else if (e.type === 'job.progress' && t.lang === this.target)
      this.note(`Translating to ${languageName(t.lang)}… ${Math.round(e.progress * 100)} %`)
    else if (e.type === 'job.state') {
      if (e.state === 'done') await this.translationDone(t.jobId!, t.lang)
      else if (e.state === 'failed' || e.state === 'cancelled') {
        const job = await engineRequest<JobSummary>(`/v1/jobs/${t.jobId}`).catch(() => null)
        this.translation = null
        if (e.state === 'failed')
          this.note(`Couldn’t translate: ${job?.error?.message ?? 'failed'}`)
        if (this.state.phase === 'done') this.close()
      }
    }
  }

  private async translationDone(jobId: string, lang: string): Promise<void> {
    const result = await engineRequest<JobResult>(`/v1/jobs/${jobId}/result`)
    const track = result.tracks[0]
    this.translation = { lang, jobId: null }
    if (!track) return
    await browser.storage.session.set({ [translatedKey(this.tabId)]: { lang, track } })
    if (lang === this.target) {
      this.toPage({ type: 'captions.track', track, final: true })
      this.note(null)
    }
    if (this.state.phase === 'done') this.close()
  }

  /** The viewer picked another language in the quick controls. */
  async retarget(target: string): Promise<void> {
    this.target = target
    if (this.translation?.jobId && this.translation.lang !== target) await this.cancelTranslation()
    const saved = (await browser.storage.session.get(captionsTrackKey(this.tabId)))[
      captionsTrackKey(this.tabId)
    ] as SavedCaptions | undefined
    const spoken = saved?.track.derivedFrom?.sourceLanguage ?? saved?.track.language
    const wantWhisper = whisperTarget(target) && !(spoken && isEnglish(spoken))
    const isWhisper = this.state.task === 'translate'
    // Whisper translation and the transcript are different engine runs.
    if (wantWhisper !== isWhisper && this.owner) {
      await startCaptions(this.tabId, await latest(this.tabId, this.owner), { quiet: true, target })
      return
    }
    if (target === 'original' || whisperTarget(target)) {
      if (saved) this.toPage({ type: 'captions.track', track: saved.track, final: saved.final })
      this.note(null)
      return
    }
    if (saved?.final) await this.translate(saved.track, target)
    else
      this.note(
        `Translating to ${languageName(target)} once the video is transcribed (${Math.round(this.state.progress * 100)} %).`,
      )
  }

  async fail(message: string, suggestLive = false): Promise<void> {
    await this.save({ phase: 'error', error: message, suggestLive, pendingDownload: undefined })
    this.close()
    const prefs = await browser.storage.local.get(AUTO_LIVE_KEY)
    if (suggestLive && prefs[AUTO_LIVE_KEY] !== false && !this.detached) {
      // Can't fetch it (DRM, login wall, live stream): follow the sound instead.
      await startLive(this.tabId, this.state.frameId)
      await this.save({
        error: `${message} Captioning it live instead (about 3 s behind the speech).`,
      })
      return
    }
    this.toPage({ type: 'captions.end' })
  }

  /** Stop a translation still running (the viewer moved on): it would hold the GPU. */
  async cancelTranslation(): Promise<void> {
    const id = this.translation?.jobId
    this.translation = null
    if (id) await engineRequest(`/v1/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {})
  }

  close(): void {
    this.ws?.close()
    this.ws = null
    if (controllers.get(this.tabId) === this) controllers.delete(this.tabId)
  }
}

const controllers = new Map<number, CaptionsController>()

/** Save captions as SRT in the chosen mode, named after the video. */
export async function saveSrt(
  track: SubtitleTrack,
  mode: CaptionMode,
  title?: string,
): Promise<void> {
  const srt = serializeSrt(cuesForMode(track.cues, mode))
  const name =
    (title ?? track.title ?? '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'sublight'
  await browser.downloads.download({
    // No object URLs in a service worker: a data URL carries the file.
    url: `data:application/x-subrip;charset=utf-8,${encodeURIComponent(srt)}`,
    filename: `${name}.${track.language}${mode === 'words' ? '.word-by-word' : ''}.srt`,
  })
}

/** The frame's latest video report (its playhead has moved since `owner` was taken). */
async function latest(
  tabId: number,
  owner: { frameId: number; state: VideoState },
): Promise<{ frameId: number; state: VideoState }> {
  const got = await browser.storage.session.get(`tab:${tabId}`)
  const frames = got[`tab:${tabId}`] as Record<string, VideoState> | undefined
  const state = frames?.[String(owner.frameId)]
  return state?.primary ? { frameId: owner.frameId, state } : owner
}

/** The frame that owns the tab's primary video (a playing one if any). */
export function ownerFrame(
  frames: Record<string, VideoState>,
): { frameId: number; state: VideoState } | null {
  const entries = Object.entries(frames).filter(([, f]) => f.primary)
  const owner = entries.find(([, f]) => f.primary!.isPlaying) ?? entries[0]
  return owner ? { frameId: Number(owner[0]), state: owner[1] } : null
}

function playhead(v: VideoState): number {
  const p = v.primary!
  return p.isPlaying
    ? p.currentTimeMs + (Date.now() - v.reportedAt) * p.playbackRate
    : p.currentTimeMs
}

/**
 * Caption the tab's video ahead of playback, starting at the playhead.
 * `quiet`: replacing the tab's captions (next video in a feed, another
 * language), so the page keeps its session instead of being told to stop.
 */
export async function startCaptions(
  tabId: number,
  owner: { frameId: number; state: VideoState },
  opts: { pendingDownload?: CaptionMode; quiet?: boolean; target?: string } = {},
): Promise<CaptionsState> {
  await stopCaptions(tabId, { quiet: opts.quiet ?? false })
  await stopLive(tabId)
  await browser.storage.session.remove([captionsTrackKey(tabId), translatedKey(tabId)])
  const tab = await browser.tabs.get(tabId).catch(() => null)
  const prefs = await browser.storage.local.get([
    CAPTION_MODEL_KEY,
    LIVE_LANGUAGE_KEY,
    LIVE_TASK_KEY,
    TARGET_KEY,
    COOKIES_KEY,
  ])
  const target =
    opts.target ??
    (prefs[TARGET_KEY] as string | undefined) ??
    (prefs[LIVE_TASK_KEY] === 'translate' ? 'en' : 'original')
  const model =
    (await pickInstalled([
      prefs[CAPTION_MODEL_KEY] as string | undefined,
      DEFAULT_CAPTION_MODEL,
    ])) ?? DEFAULT_CAPTION_MODEL
  const v = owner.state
  const task = whisperTarget(target) ? 'translate' : 'transcribe'
  const cookies = prefs[COOKIES_KEY] as string | undefined
  let job: JobSummary
  try {
    job = await engineRequest<JobSummary>('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'url',
        pageUrl: v.primary?.pageUrl ?? v.url,
        ...(v.primary?.src ? { mediaUrl: v.primary.src } : {}),
        userAgent: navigator.userAgent,
        ...(cookies ? { cookiesFromBrowser: cookies } : {}),
        model,
        priority: 'interactive',
        params: {
          language: (prefs[LIVE_LANGUAGE_KEY] as string | undefined) || null,
          ...(task === 'translate' ? { task } : {}),
          fromMs: Math.round(playhead(v)),
        },
      }),
    })
  } catch (err) {
    const failed: Stored = {
      tabId,
      frameId: owner.frameId,
      jobId: '',
      phase: 'error',
      error: describe(err),
      progress: 0,
      coverage: [],
    }
    await browser.storage.session.set({ [stateKey(tabId)]: failed })
    return failed
  }
  const c = new CaptionsController(tabId, owner.frameId, job.id, v.title || tab?.title)
  c.target = target
  c.setOwner(owner)
  controllers.set(tabId, c)
  await c.save({ task, ...(opts.pendingDownload ? { pendingDownload: opts.pendingDownload } : {}) })
  const reply = (await browser.tabs
    .sendMessage(tabId, { type: 'captions.begin', jobId: job.id } satisfies Message, {
      frameId: owner.frameId,
    })
    .catch(() => null)) as { ok: boolean; reason?: string } | null
  if (!reply?.ok && !opts.pendingDownload) {
    await engineRequest(`/v1/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {})
    await c.fail(
      reply?.reason === 'player'
        ? 'This is the Sublight Player: use its Caption tab instead.'
        : 'The page didn’t answer. Reload it and try again.',
    )
    return c.state
  }
  await c.connect()
  return c.state
}

export async function stopCaptions(
  tabId: number,
  opts: { quiet?: boolean } = {},
): Promise<CaptionsState | null> {
  const c = controllers.get(tabId)
  if (!c) return captionsStatus(tabId)
  if (!opts.quiet) c.toPage({ type: 'captions.end' })
  await c.cancelTranslation()
  await engineRequest(`/v1/jobs/${c.jobId}/cancel`, { method: 'POST' }).catch(() => {})
  await c.save({ phase: 'stopped', pendingDownload: undefined })
  c.close()
  return c.state
}

/** State for the popup; re-attaches to a running job after a service-worker restart. */
export async function captionsStatus(tabId: number): Promise<CaptionsState | null> {
  const got = await browser.storage.session.get(stateKey(tabId))
  const state = (got[stateKey(tabId)] as Stored | undefined) ?? null
  if (
    state &&
    (state.phase === 'starting' || state.phase === 'captioning') &&
    !controllers.has(tabId)
  ) {
    const c = new CaptionsController(tabId, state.frameId, state.jobId, state.title)
    c.state = state
    const prefs = await browser.storage.local.get(TARGET_KEY)
    c.target = (prefs[TARGET_KEY] as string | undefined) ?? 'original'
    controllers.set(tabId, c)
    await c.connect()
    return c.state
  }
  return state
}

/**
 * Download the whole video's captions (in the language shown): right away
 * when they're done, else once the running job finishes, else start one.
 */
export async function downloadCaptions(
  tabId: number,
  mode: CaptionMode,
  owner: { frameId: number; state: VideoState } | null,
): Promise<CaptionsState | null> {
  const got = await browser.storage.session.get(captionsTrackKey(tabId))
  const saved = got[captionsTrackKey(tabId)] as SavedCaptions | undefined
  const state = await captionsStatus(tabId)
  const c = controllers.get(tabId)
  if (saved?.final) {
    await saveSrt(c ? await c.shownTrack(saved.track) : saved.track, mode, state?.title)
    return state
  }
  if (c) {
    await c.save({ pendingDownload: mode })
    return c.state
  }
  if (!owner) return null
  return startCaptions(tabId, owner, { pendingDownload: mode })
}

/** Seeks, language changes, feed scrolls and navigation from the page. */
export async function onCaptionsMessage(
  message: Message,
  sender: { tab?: { id?: number }; frameId?: number },
): Promise<unknown> {
  const tabId = sender.tab?.id
  if (tabId === undefined) return { ok: false }
  if (message.type === 'captions.next') {
    const current = controllers.get(tabId)
    // A download of the previous video is still running: finish it first.
    if (current?.state.pendingDownload) return { ok: false, reason: 'download' }
    return startCaptions(
      tabId,
      { frameId: sender.frameId ?? 0, state: message.state },
      { quiet: true },
    )
  }
  const c = [...controllers.values()].find((x) => 'jobId' in message && x.jobId === message.jobId)
  if (!c || c.tabId !== tabId) return { ok: false }
  if (message.type === 'captions.seek') {
    await engineRequest(`/v1/url/${c.jobId}/focus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaMs: Math.max(0, Math.round(message.mediaMs)) }),
    }).catch(() => {})
  } else if (message.type === 'captions.translate') {
    await c.retarget(message.target)
  } else if (message.type === 'captions.navigated') {
    if (c.state.pendingDownload) c.detached = true
    // The page stays in charge: it captions the next video it plays.
    else await stopCaptions(c.tabId, { quiet: true })
  }
  return { ok: true }
}
