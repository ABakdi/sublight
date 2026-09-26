import { browser } from 'wxt/browser'
import { cuesForMode, serializeSrt, type CaptionMode, type SubtitleTrack } from '@sublight/core'
import { WS_BASE_URL, type JobResult, type JobSummary, type WsEvent } from '@sublight/protocol'
import { engineRequest, getToken } from './engine'
import {
  describe,
  LIVE_LANGUAGE_KEY,
  LIVE_TASK_KEY,
  pickInstalled,
  stopLive,
} from './liveController'
import type { CaptionsState, Message, VideoState } from './messages'

/** Model for captions made ahead of playback (Options). */
export const CAPTION_MODEL_KEY = 'captionModel'
export const DEFAULT_CAPTION_MODEL = 'whisper-small'

const stateKey = (tabId: number) => `captions:${tabId}`
/** The latest track per tab (drafts, then final), for the overlay and downloads. */
export const captionsTrackKey = (tabId: number) => `captionsTrack:${tabId}`
export interface SavedCaptions {
  track: SubtitleTrack
  final: boolean
}

type Stored = CaptionsState & { frameId: number }

/**
 * One tab's captions made ahead of playback (ADR-0020, Spec 09 §5a): creates
 * the engine `url` job (the engine fetches the audio itself), follows it over
 * the engine WS, forwards the growing track to the page, where it shows at
 * exact media time, relays seeks, and saves the SRT on request.
 */
class CaptionsController {
  state: Stored
  private ws: WebSocket | null = null

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

  async save(patch: Partial<Stored>): Promise<void> {
    this.state = { ...this.state, ...patch }
    await browser.storage.session.set({ [stateKey(this.tabId)]: this.state })
  }

  /** The page moved on while a download waits: keep transcribing, stop showing. */
  detached = false

  toPage(msg: Message): void {
    if (this.detached) return
    void browser.tabs.sendMessage(this.tabId, msg, { frameId: this.state.frameId }).catch(() => {})
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

  private async draft(track: SubtitleTrack): Promise<void> {
    this.toPage({ type: 'captions.track', track, final: false })
    const saved: SavedCaptions = { track, final: false }
    await browser.storage.session.set({ [captionsTrackKey(this.tabId)]: saved })
    await this.save({ phase: 'captioning', coverage: track.coverage ?? [] })
  }

  private async onEvent(e: WsEvent): Promise<void> {
    if (!('jobId' in e) || e.jobId !== this.jobId) return
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
      this.toPage({ type: 'captions.track', track, final: true })
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
    if (pending && track) await saveSrt(track, pending, this.state.title)
    this.close()
  }

  async fail(message: string, suggestLive = false): Promise<void> {
    await this.save({ phase: 'error', error: message, suggestLive, pendingDownload: undefined })
    this.toPage({ type: 'captions.end' })
    this.close()
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

/** Caption the tab's video ahead of playback, starting at the playhead. */
export async function startCaptions(
  tabId: number,
  owner: { frameId: number; state: VideoState },
  pendingDownload?: CaptionMode,
): Promise<CaptionsState> {
  await stopCaptions(tabId)
  await stopLive(tabId)
  await browser.storage.session.remove(captionsTrackKey(tabId))
  const tab = await browser.tabs.get(tabId).catch(() => null)
  const prefs = await browser.storage.local.get([
    CAPTION_MODEL_KEY,
    LIVE_LANGUAGE_KEY,
    LIVE_TASK_KEY,
  ])
  const model =
    (await pickInstalled([
      prefs[CAPTION_MODEL_KEY] as string | undefined,
      DEFAULT_CAPTION_MODEL,
    ])) ?? DEFAULT_CAPTION_MODEL
  const v = owner.state
  let job: JobSummary
  try {
    job = await engineRequest<JobSummary>('/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'url',
        pageUrl: v.url,
        ...(v.primary?.src ? { mediaUrl: v.primary.src } : {}),
        userAgent: navigator.userAgent,
        model,
        priority: 'interactive',
        params: {
          language: (prefs[LIVE_LANGUAGE_KEY] as string | undefined) || null,
          ...(prefs[LIVE_TASK_KEY] === 'translate' ? { task: 'translate' } : {}),
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
  const c = new CaptionsController(tabId, owner.frameId, job.id, tab?.title || v.title)
  controllers.set(tabId, c)
  await c.save(pendingDownload ? { pendingDownload } : {})
  const reply = (await browser.tabs
    .sendMessage(tabId, { type: 'captions.begin', jobId: job.id } satisfies Message, {
      frameId: owner.frameId,
    })
    .catch(() => null)) as { ok: boolean; reason?: string } | null
  if (!reply?.ok && !pendingDownload) {
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

export async function stopCaptions(tabId: number): Promise<CaptionsState | null> {
  const c = controllers.get(tabId)
  if (!c) return captionsStatus(tabId)
  c.toPage({ type: 'captions.end' })
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
    controllers.set(tabId, c)
    await c.connect()
    return c.state
  }
  return state
}

/**
 * Download the whole video's captions: right away when they're done, else
 * once the running job finishes, else start one (from the beginning).
 */
export async function downloadCaptions(
  tabId: number,
  mode: CaptionMode,
  owner: { frameId: number; state: VideoState } | null,
): Promise<CaptionsState | null> {
  const got = await browser.storage.session.get(captionsTrackKey(tabId))
  const saved = got[captionsTrackKey(tabId)] as SavedCaptions | undefined
  const state = await captionsStatus(tabId)
  if (saved?.final) {
    await saveSrt(saved.track, mode, state?.title)
    return state
  }
  const c = controllers.get(tabId)
  if (c) {
    await c.save({ pendingDownload: mode })
    return c.state
  }
  if (!owner) return null
  return startCaptions(tabId, owner, mode)
}

/** Seeks and navigation from the page. */
export async function onCaptionsMessage(
  message: Message,
  sender: { tab?: { id?: number } },
): Promise<unknown> {
  const c = [...controllers.values()].find((x) => 'jobId' in message && x.jobId === message.jobId)
  if (!c || sender.tab?.id !== c.tabId) return { ok: false }
  if (message.type === 'captions.seek') {
    await engineRequest(`/v1/url/${c.jobId}/focus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaMs: Math.max(0, Math.round(message.mediaMs)) }),
    }).catch(() => {})
  } else if (message.type === 'captions.navigated') {
    if (c.state.pendingDownload) c.detached = true
    else await stopCaptions(c.tabId)
  }
  return { ok: true }
}
