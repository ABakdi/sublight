/** Anything holding a model in VRAM that can be told to let go. */
export interface Resident {
  stop(): Promise<void>
  readonly residentModel: string | null
}

/**
 * One resident model at a time on the 4 GB GPU (Spec 06 §2): before a job
 * uses a worker, every other worker unloads. Jobs are already serialized on
 * the single GPU slot, so swaps happen between jobs, never mid-job.
 */
export class GpuResidency {
  constructor(private readonly workers: Record<string, Resident>) {}

  async use(kind: string): Promise<void> {
    for (const [name, worker] of Object.entries(this.workers)) {
      if (name !== kind && worker.residentModel) await worker.stop()
    }
  }

  /** "whisper-small" / "qwen3-4b-instruct" / null. */
  get resident(): string | null {
    for (const w of Object.values(this.workers)) if (w.residentModel) return w.residentModel
    return null
  }
}
