import { browser } from 'wxt/browser'
import type { SubtitleTrack } from '@sublight/core'
import {
  EngineSocket,
  WS_BASE_URL,
  type JobResult,
  type JobSummary,
  type LiveAnchor,
  type ModelsResponse,
  type WsEvent,
} from '@sublight/protocol'
import { bestEffort, engineRequest, EngineRequestError, getToken } from './engine'
import type { CaptureSource, LiveState, Message } from './messages'
import { base64ToBytes, levelDb } from './pcm'
import { followJob, JobEnded, languageName, TRANSLATE_MODEL, type FollowedJob } from './translation'

export const LIVE_MODEL_KEY = 'liveModel'
export const LIVE_LANGUAGE_KEY = 'liveLanguage'
/** 'transcribe' (spoken language) or 'translate' (English, ADR-0018). */
export const LIVE_TASK_KEY = 'liveTask'
/**
 * Drafts while listening. whisper-small: base was faster but garbled too
 * much to read, and small's pass is ~2 s on the reference GPU.
 */
export const DEFAULT_LIVE_MODEL = 'whisper-small'
/** The result on stop (full context; a larger model if installed and chosen). */
export const LIVE_REFINE_KEY = 'liveRefineModel'
export const DEFAULT_REFINE_MODEL = 'whisper-small'

/** First installed model among the candidates (engine model list). */
export async function pickInstalled(
  candidates: (string | undefined)[],
): Promise<string | undefined> {
  const { models } = await engineRequest<ModelsResponse>('/v1/models').catch(() => ({
    models: [] as ModelsResponse['models'],
  }))
  const installed = new Set(models.filter((m) => m.installed && m.role === 'asr').map((m) => m.id))
  return candidates.find((c) => c && installed.has(c))
}
const OFFSCREEN_URL = 'offscreen.html'

const liveKey = (tabId: number) => `live:${tabId}`
/** The latest live track per tab (draft while listening, then final), for "Download SRT". */
export const liveTrackKey = (tabId: number) => `liveTrack:${tabId}`
export interface SavedLiveTrack {
  track: SubtitleTrack
  /** False while listening: the draft so far, before the refinement pass. */
  final: boolean
  /** The refined track translated ("Translate to"), when that is what the page shows. */
  translation?: SubtitleTrack
}
/** Tab audio silent this long while the video plays → probably muted tab or DRM. */
const TAB_SILENT_NOTICE_MS = 8000
const NO_SOUND_NOTICE =
  'No sound from this tab. Unmute the tab, or the video may be protected (DRM), which sublight can’t caption.'

/**
 * One tab's live captioning, run from the service worker (Spec 09 §3, §5):
 * creates the engine `live` job, relays audio and anchors from the page (or
 * the offscreen tabCapture document), follows the job over the engine WS,
 * forwards drafts to the page, and on stop waits for the refinement pass.
 * The refined track can then be translated (M05.6): the LLM translates it,
 * like a finished transcript of captions made ahead.
 */
class LiveController {
  state: LiveState
  private socket: EngineSocket | null = null
  /** Audio posts stay in order: each waits for the previous one. */
  private audioChain: Promise<unknown> = Promise.resolve()
  /** The page moved on: keep the result for download but don't show it there. */
  detached = false
  private playing = true
  private silentMs = 0
  /** The refined track, once the job is done. */
  private finalTrack: SubtitleTrack | null = null
  /** What the viewer asked for: 'original' or a language code. */
  private target = 'original'
  private translation: { lang: string; jobId: string; follow: FollowedJob | null } | null = null
  private translated = new Map<string, SubtitleTrack>()

  constructor(
    readonly tabId: number,
    readonly frameId: number,
    readonly jobId: string,
  ) {
    this.state = { tabId, jobId, source: null, phase: 'starting', cues: 0 }
  }

  private async save(patch: Partial<LiveState>): Promise<void> {
    this.state = { ...this.state, ...patch }
    await browser.storage.session.set({ [liveKey(this.tabId)]: this.state })
  }

  private toPage(msg: Message): void {
    void browser.tabs.sendMessage(this.tabId, msg, { frameId: this.frameId }).catch(() => {})
  }

  async connect(): Promise<void> {
    this.socket?.close()
    // Reconnects by itself; what happened meanwhile is read back over REST (Q3).
    const socket = new EngineSocket({
      url: () => `${WS_BASE_URL}/ws`,
      token: getToken,
      onReconnect: () => void this.resync(),
      onError: (err) =>
        void this.fail(
          `Live captions stopped: ${err instanceof Error ? err.message : String(err)}`,
        ),
    })
    this.socket = socket
    socket.on((e) => this.onEvent(e))
    socket.subscribe(this.jobId)
    await socket.connect()
  }

  /** What the socket missed while it was down. */
  private async resync(): Promise<void> {
    const job = await engineRequest<JobSummary>(
      `/v1/jobs/${this.jobId}`,
      {},
      { start: false },
    ).catch(() => null)
    if (job?.state === 'done') await this.finish()
    else if (job?.state === 'failed')
      await this.fail(job.error?.message ?? 'Live captioning failed.')
  }

  private async onEvent(e: WsEvent): Promise<void> {
    if (!('jobId' in e) || e.jobId !== this.jobId) return
    if (e.type === 'job.partial') {
      if (!this.detached) this.toPage({ type: 'live.track', track: e.draft, final: false })
      const saved: SavedLiveTrack = { track: e.draft, final: false }
      await browser.storage.session.set({ [liveTrackKey(this.tabId)]: saved })
      await this.save({ cues: e.draft.cues.length })
    } else if (e.type === 'job.progress' && e.detail) {
      await this.save({
        detail: e.detail,
        ...(e.detail === 'refining' ? { phase: 'refining' } : {}),
      })
    } else if (e.type === 'job.state') {
      if (e.state === 'done') await this.finish()
      else if (e.state === 'failed') {
        const job = await engineRequest<JobSummary>(`/v1/jobs/${this.jobId}`).catch(() => null)
        await this.fail(job?.error?.message ?? 'Live captioning failed.')
      } else if (e.state === 'cancelled') await this.save({ phase: 'stopped' })
    }
  }

  private async finish(): Promise<void> {
    const result = await engineRequest<JobResult>(`/v1/jobs/${this.jobId}/result`)
    const track: SubtitleTrack | undefined = result.tracks[0]
    this.finalTrack = track ?? null
    if (track) {
      if (!this.detached) this.toPage({ type: 'live.track', track, final: true })
      const saved: SavedLiveTrack = { track, final: true }
      await browser.storage.session.set({ [liveTrackKey(this.tabId)]: saved })
    }
    await this.save({
      phase: this.detached ? 'stopped' : 'done',
      detail: this.detached
        ? 'The page moved to another video; the captions so far can be downloaded.'
        : undefined,
      notice: undefined,
      cues: track?.cues.length ?? 0,
    })
    this.socket?.close()
  }

  /** Show the refined track, or `translation` of it, and keep it for "Download SRT". */
  private async show(translation?: SubtitleTrack): Promise<void> {
    const track = this.finalTrack
    if (!track) return
    if (!this.detached)
      this.toPage(
        translation
          ? { type: 'live.track', track: translation, final: true, companion: track }
          : { type: 'live.track', track, final: true },
      )
    const saved: SavedLiveTrack = { track, final: true, ...(translation ? { translation } : {}) }
    await browser.storage.session.set({ [liveTrackKey(this.tabId)]: saved })
  }

  private note(note: string | null): void {
    if (!this.detached) this.toPage({ type: 'live.ui', note })
  }

  /** "Translate to" on the refined captions: the LLM translates them, from the playhead on. */
  async retarget(target: string, mediaMs: number): Promise<void> {
    this.target = target
    const track = this.finalTrack
    if (!track) return
    if (this.translation && this.translation.lang !== target) await this.cancelTranslation()
    if (target === 'original' || track.language === target || track.cues.length === 0) {
      await this.show()
      this.note(null)
      return
    }
    const done = this.translated.get(target)
    if (done) {
      await this.show(done)
      this.note(null)
      return
    }
    if (this.translation?.lang === target) return
    const name = languageName(target)
    this.note(`Translating to ${name}…`)
    try {
      const job = await engineRequest<JobSummary>('/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'translate',
          track,
          model: TRANSLATE_MODEL,
          targetLang: target,
          glossary: [],
          style: 'neutral',
          priority: 'interactive',
          lease: true,
          fromMs: Math.max(0, Math.round(mediaMs)),
        }),
      })
      const translation = { lang: target, jobId: job.id, follow: null as FollowedJob | null }
      this.translation = translation
      translation.follow = followJob(job.id, {
        partial: (t) => {
          if (this.target === target && !this.detached)
            this.toPage({ type: 'live.track', track: t, final: true, companion: track })
        },
        progress: (p) => {
          if (this.target === target) this.note(`Translating to ${name}… ${Math.round(p * 100)} %`)
        },
      })
      const result = await translation.follow.done
      if (this.translation === translation) this.translation = null
      const out = result.tracks[0]
      if (!out) return
      this.translated.set(target, out)
      if (this.target === target) {
        await this.show(out)
        this.note(null)
      }
    } catch (err) {
      if (this.translation?.lang === target) this.translation = null
      if (err instanceof JobEnded && err.state === 'cancelled') return
      if (this.target !== target) return
      const message = describe(err)
      this.note(
        message.includes('not installed')
          ? `Translating to ${name} needs the translation model (2.5 GB): install it in sublight’s Options.`
          : `Couldn’t translate: ${message}`,
      )
    }
  }

  /** Stop a translation still running: it would hold the GPU. */
  async cancelTranslation(): Promise<void> {
    const t = this.translation
    this.translation = null
    if (!t) return
    t.follow?.close()
    await engineRequest(`/v1/jobs/${t.jobId}/cancel`, { method: 'POST' }).catch(
      bestEffort('cancel'),
    )
  }

  async fail(message: string): Promise<void> {
    await this.save({ phase: 'error', error: message })
    this.toPage({ type: 'live.end' })
    await stopOffscreen()
    this.socket?.close()
  }

  audio(wallMs: number, pcm: string): void {
    const body = base64ToBytes(pcm)
    if (this.state.source === 'tab') this.trackSilence(body)
    this.audioChain = this.audioChain
      .then(() =>
        engineRequest(`/v1/live/${this.jobId}/audio?wallMs=${Math.round(wallMs)}`, {
          method: 'POST',
          body,
        }),
      )
      .catch(() => {})
  }

  /** Spec 08 §7: tab audio silent while the video plays → muted tab or DRM; say so. */
  private trackSilence(bytes: Uint8Array<ArrayBuffer>): void {
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
    if (this.playing && levelDb(pcm) < -60) this.silentMs += (pcm.length / 16000) * 1000
    else this.silentMs = 0
    const notice = this.silentMs >= TAB_SILENT_NOTICE_MS ? NO_SOUND_NOTICE : undefined
    if (notice !== this.state.notice) void this.save({ notice })
  }

  hint(message: string | null): void {
    void this.save({ notice: message ?? undefined })
  }

  anchor(a: LiveAnchor): void {
    this.playing = a.playing
    void engineRequest(`/v1/live/${this.jobId}/anchor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a),
    }).catch(() => {})
  }

  async useSource(source: CaptureSource): Promise<void> {
    await this.save({ source, phase: 'listening' })
  }

  async stop(): Promise<void> {
    this.toPage({ type: 'live.end' })
    await stopOffscreen()
    await this.audioChain
    await engineRequest(`/v1/live/${this.jobId}/stop`, { method: 'POST' }).catch(bestEffort('stop'))
    await this.save({ phase: 'refining', detail: 'refining' })
  }
}

const controllers = new Map<number, LiveController>()

async function hasOffscreen(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  return contexts.length > 0
}

async function stopOffscreen(): Promise<void> {
  if (!(await hasOffscreen())) return
  await browser.runtime.sendMessage({ type: 'offscreen.stop' } satisfies Message).catch(() => {})
  await browser.offscreen.closeDocument().catch(() => {})
}

/** tabCapture for the whole tab (Spec 08 §1 row 2), consumed in an offscreen document (MV3). */
async function startTabCapture(c: LiveController): Promise<void> {
  const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: c.tabId })
  if (!(await hasOffscreen())) {
    await browser.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture the tab’s audio for local live captions',
    })
  }
  await browser.runtime.sendMessage({
    type: 'offscreen.start',
    jobId: c.jobId,
    streamId,
  } satisfies Message)
  await c.useSource('tab')
}

export function describe(err: unknown): string {
  if (err instanceof EngineRequestError) {
    if (err.code === 'MODEL_NOT_INSTALLED')
      return 'The speech model isn’t installed. Install it from the Sublight Player (Caption tab) or the engine API.'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** Start live captions on the tab's primary video (frame from its video reports). */
export async function startLive(tabId: number, frameId: number): Promise<LiveState> {
  await stopLive(tabId)
  await dropFinished(tabId)
  await browser.storage.session.remove(liveTrackKey(tabId))
  const prefs = await browser.storage.local.get([
    LIVE_MODEL_KEY,
    LIVE_REFINE_KEY,
    LIVE_LANGUAGE_KEY,
    LIVE_TASK_KEY,
  ])
  const liveModel =
    (await pickInstalled([
      prefs[LIVE_MODEL_KEY] as string | undefined,
      DEFAULT_LIVE_MODEL,
      DEFAULT_REFINE_MODEL,
    ])) ?? DEFAULT_LIVE_MODEL
  const refineModel = await pickInstalled([
    prefs[LIVE_REFINE_KEY] as string | undefined,
    DEFAULT_REFINE_MODEL,
    liveModel,
  ])
  let job: JobSummary
  try {
    job = await engineRequest<JobSummary>('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'live',
        model: liveModel,
        params: {
          language: (prefs[LIVE_LANGUAGE_KEY] as string | undefined) || null,
          ...(prefs[LIVE_TASK_KEY] === 'translate' ? { task: 'translate' } : {}),
          ...(refineModel && refineModel !== liveModel ? { refineModel } : {}),
        },
        priority: 'interactive',
      }),
    })
  } catch (err) {
    const state: LiveState = {
      tabId,
      jobId: '',
      source: null,
      phase: 'error',
      error: describe(err),
      cues: 0,
    }
    await browser.storage.session.set({ [liveKey(tabId)]: state })
    return state
  }
  const c = new LiveController(tabId, frameId, job.id)
  controllers.set(tabId, c)
  await c.connect()
  try {
    const reply = (await browser.tabs.sendMessage(
      tabId,
      { type: 'live.begin', jobId: job.id, captureElement: true } satisfies Message,
      { frameId },
    )) as { ok: boolean; captured?: boolean; reason?: string } | undefined
    if (!reply?.ok) {
      throw new Error(
        reply?.reason === 'no-video'
          ? 'No video on this page.'
          : reply?.reason === 'player'
            ? 'This is the Sublight Player: use its Caption tab instead.'
            : 'The page didn’t answer.',
      )
    }
    if (reply.captured) await c.useSource('element')
    else await startTabCapture(c)
  } catch (err) {
    await engineRequest(`/v1/jobs/${job.id}/cancel`, { method: 'POST' }).catch(bestEffort('cancel'))
    await c.fail(describe(err))
    controllers.delete(tabId)
  }
  return c.state
}

export async function stopLive(tabId: number): Promise<LiveState | null> {
  const c = controllers.get(tabId)
  if (!c) return null
  controllers.delete(tabId)
  await c.stop()
  // Keep following the job until refinement is done.
  finishing.set(c.jobId, c)
  return c.state
}

/**
 * The tab is gone (closed, reloaded, navigated away): cancel its live job
 * outright. No refinement pass: nobody is left to see it.
 */
export async function cancelLive(tabId: number): Promise<void> {
  const c = controllers.get(tabId)
  controllers.delete(tabId)
  const state = c?.state ?? (await liveStatus(tabId))
  const jobIds = new Set(
    [
      state?.jobId,
      ...[...finishing.values()].filter((f) => f.tabId === tabId).map((f) => f.jobId),
    ].filter((id): id is string => !!id),
  )
  await dropFinished(tabId)
  for (const id of jobIds) {
    finishing.delete(id)
    await engineRequest(`/v1/jobs/${id}/cancel`, { method: 'POST' }).catch(bestEffort('cancel'))
  }
  if (c || state?.phase === 'listening' || state?.phase === 'starting') await stopOffscreen()
  await browser.storage.session.remove([liveKey(tabId), liveTrackKey(tabId)])
}

/**
 * Stopped controllers: waiting for their refinement result, then kept while
 * the page may still ask to translate it.
 */
const finishing = new Map<string, LiveController>()

/** A new session or a closed tab: forget the tab's finished ones and their translations. */
async function dropFinished(tabId: number): Promise<void> {
  for (const [id, c] of finishing) {
    if (c.tabId !== tabId) continue
    finishing.delete(id)
    c.detached = true // a refinement still due mustn't replace the next session's captions
    await c.cancelTranslation()
  }
}

export async function liveStatus(tabId: number): Promise<LiveState | null> {
  const got = await browser.storage.session.get(liveKey(tabId))
  return (got[liveKey(tabId)] as LiveState | undefined) ?? null
}

/** Audio/anchors/fallback from the page or the offscreen document. */
export async function onLiveMessage(
  message: Message,
  sender: { tab?: { id?: number } },
): Promise<unknown> {
  // From a page, only its own tab's session (the offscreen document has no tab).
  const tabId = sender.tab?.id
  const find = (jobId: string) =>
    [...controllers.values()].find(
      (c) => c.jobId === jobId && (tabId === undefined || c.tabId === tabId),
    )
  switch (message.type) {
    case 'live.audio':
      find(message.jobId)?.audio(message.wallMs, message.pcm)
      return { ok: true }
    case 'live.anchor':
      {
        // A finishing session still takes anchors, but only from its own tab (S6).
        const done = finishing.get(message.jobId)
        const own = done && (tabId === undefined || done.tabId === tabId) ? done : undefined
        ;(find(message.jobId) ?? own)?.anchor(message.anchor)
      }
      return { ok: true }
    case 'live.hint':
      find(message.jobId)?.hint(message.message)
      return { ok: true }
    case 'live.navigated': {
      const c = find(message.jobId)
      if (c && sender.tab?.id === c.tabId) {
        c.detached = true
        await stopLive(c.tabId)
      }
      return { ok: true }
    }
    case 'live.translate': {
      const c = finishing.get(message.jobId)
      // Not awaited: a translation takes minutes, the page only needs the ack.
      if (c && sender.tab?.id === c.tabId) void c.retarget(message.target, message.mediaMs)
      return { ok: true }
    }
    case 'live.fallback': {
      const c = find(message.jobId)
      if (c && sender.tab?.id === c.tabId) {
        try {
          await startTabCapture(c)
        } catch (err) {
          await c.fail(`Couldn’t capture the tab: ${describe(err)}`)
        }
      }
      return { ok: true }
    }
    default:
      return undefined
  }
}
