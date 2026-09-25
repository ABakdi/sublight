import type { WsEvent } from '@sublight/protocol'

type Listener = (event: WsEvent) => void

/** In-process fan-out of engine events; the WS server is one subscriber (Spec 03 §4). */
export class EventBus {
  private listeners = new Set<Listener>()

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: WsEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch (err) {
        console.error('[engine] event listener failed', err)
      }
    }
  }
}
