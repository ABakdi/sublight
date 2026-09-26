import { browser } from 'wxt/browser'
import type { SubtitleTrack } from '@sublight/core'
import {
  WS_BASE_URL,
  type JobResult,
  type JobSummary,
  type LiveAnchor,
  type ModelsResponse,
  type WsEvent,
} from '@sublight/protocol'
import { engineRequest, EngineRequestError, getToken } from './engine'
import type { CaptureSource, LiveState, Message } from './messages'
import { base64ToBytes, levelDb } from './pcm'

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
 */
class LiveController {
  state: LiveState
  private ws: WebSocket | null = null
  /** Audio posts stay in order: each waits for the previous one. */
  private audioChain: Promise<unknown> = Promise.resolve()
  /** The page moved on: keep the result for download but don't show it there. */
  detached = false
  private playing = true
  private silentMs = 0

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
    const token = await getToken()
    const ws = new WebSocket(`${WS_BASE_URL}/ws`)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }))
      ws.send(JSON.stringify({ type: 'subscribe', jobIds: [this.jobId] }))
    }
    ws.onmessage = (m) => void this.onEvent(JSON.parse(String(m.data)) as WsEvent)
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
    this.ws?.close()
  }

  async fail(message: string): Promise<void> {
    await this.save({ phase: 'error', error: message })
    this.toPage({ type: 'live.end' })
    await stopOffscreen()
    this.ws?.close()
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
    await engineRequest(`/v1/live/${this.jobId}/stop`, { method: 'POST' }).catch(() => {})
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
    await engineRequest(`/v1/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {})
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
  for (const id of jobIds) {
    finishing.delete(id)
    await engineRequest(`/v1/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {})
  }
  if (c || state?.phase === 'listening' || state?.phase === 'starting') await stopOffscreen()
  await browser.storage.session.remove([liveKey(tabId), liveTrackKey(tabId)])
}

/** Stopped controllers still waiting for their refinement result. */
const finishing = new Map<string, LiveController>()

export async function liveStatus(tabId: number): Promise<LiveState | null> {
  const got = await browser.storage.session.get(liveKey(tabId))
  return (got[liveKey(tabId)] as LiveState | undefined) ?? null
}

/** Audio/anchors/fallback from the page or the offscreen document. */
export async function onLiveMessage(
  message: Message,
  sender: { tab?: { id?: number } },
): Promise<unknown> {
  const find = (jobId: string) => [...controllers.values()].find((c) => c.jobId === jobId)
  switch (message.type) {
    case 'live.audio':
      find(message.jobId)?.audio(message.wallMs, message.pcm)
      return { ok: true }
    case 'live.anchor':
      ;(find(message.jobId) ?? finishing.get(message.jobId))?.anchor(message.anchor)
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
