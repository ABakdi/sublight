import { browser } from 'wxt/browser'
import { startPcmCapture, type PcmCapture } from '../../src/capture'
import { isMessage, type Message } from '../../src/messages'
import { pcmToBase64 } from '../../src/pcm'

/**
 * Offscreen document for tabCapture (MV3, Spec 09 §5): a tab stream id from
 * the SW becomes a MediaStream here. Capturing a tab mutes it for the user,
 * so the audio is also played back (`monitor`).
 */
let capture: PcmCapture | null = null

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isMessage(message)) return undefined
  if (message.type === 'offscreen.start') {
    void start(message.jobId, message.streamId).then(
      () => sendResponse({ ok: true }),
      (err: unknown) => sendResponse({ ok: false, error: String(err) }),
    )
    return true
  }
  if (message.type === 'offscreen.stop') {
    capture?.stop()
    capture = null
    sendResponse({ ok: true })
  }
  return undefined
})

async function start(jobId: string, streamId: string): Promise<void> {
  capture?.stop()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    } as unknown as MediaTrackConstraints,
    video: false,
  })
  capture = startPcmCapture(stream, {
    monitor: true,
    chunkMs: 500,
    onChunk: (pcm, wallMs) => {
      const msg: Message = { type: 'live.audio', jobId, wallMs, pcm: pcmToBase64(pcm) }
      void browser.runtime.sendMessage(msg).catch(() => {})
    },
  })
}
