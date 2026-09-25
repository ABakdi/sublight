import { JobError } from '../jobs/queue'
import type { ChatMessage } from '../translate/prompt'
import { ServerProcess } from '../workers/server-process'

export interface LlamaWorkerOptions {
  binary: string
  host?: string
  port: number
  /** false = CPU-only (`-ngl 0`). */
  useGpu: boolean
  /** Context window; paragraphs + prompt fit comfortably in 4k. */
  contextTokens?: number
  threads?: number
  logDir: string
  runDir?: string
  loadTimeoutMs?: number
}

export interface ChatResult {
  text: string
  completionTokens: number
  /** Generation speed reported by llama-server, tokens/s. */
  tokensPerSecond: number | null
}

/**
 * The translation worker (Spec 06 §7): one `llama-server` on 127.0.0.1:17423
 * serving the OpenAI-compatible chat API. GPU layers are `auto` with `--fit`,
 * so llama.cpp offloads what fits in the VRAM actually free (the T1000 also
 * drives the desktop) and keeps the rest on the CPU.
 */
export class LlamaWorker {
  private readonly server: ServerProcess

  constructor(private readonly opts: LlamaWorkerOptions) {
    this.server = new ServerProcess({ name: 'llama-server', ...opts })
  }

  get residentModel(): string | null {
    return this.server.resident
  }

  get logFile(): string {
    return this.server.logFile
  }

  /**
   * GPU: first everything in VRAM with flash attention and a q8_0 KV cache
   * (measured on the T1000: 29.7 tok/s, vs 9.6 with llama.cpp's automatic
   * fit, which kept layers on the CPU). If that can't load (VRAM taken by
   * other apps), fall back to `-ngl auto --fit on` for the rest of the session.
   */
  async ensure(modelId: string, modelPath: string): Promise<void> {
    const base = [
      '-m',
      modelPath,
      '-c',
      String(this.opts.contextTokens ?? 4096),
      '-np',
      '1',
      '-t',
      String(this.opts.threads ?? 4),
      '--jinja',
      '--no-webui',
    ]
    if (!this.opts.useGpu) {
      return this.server.ensure(modelId, `${modelPath}#cpu`, [...base, '-ngl', '0'])
    }
    if (this.fitOnly !== modelPath) {
      try {
        await this.server.ensure(modelId, `${modelPath}#gpu`, [
          ...base,
          ...['-ngl', 'all', '--fit', 'off', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0'],
        ])
        return
      } catch (err) {
        if (!(err instanceof JobError) || err.code !== 'WORKER_UNAVAILABLE') throw err
        this.fitOnly = modelPath
      }
    }
    await this.server.ensure(modelId, `${modelPath}#fit`, [
      ...base,
      ...['-ngl', 'auto', '--fit', 'on', '-fa', 'on'],
    ])
  }

  /** Set when full GPU offload failed for this model; later loads go straight to --fit. */
  private fitOnly: string | null = null

  async chat(
    messages: ChatMessage[],
    opts: { maxTokens: number; temperature?: number; signal?: AbortSignal },
  ): Promise<ChatResult> {
    const res = await this.server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
        top_p: 0.9,
        stream: false,
      }),
      signal: opts.signal,
    })
    const body = await res.text()
    if (!res.ok)
      throw new JobError(
        'JOB_FAILED',
        `llama-server HTTP ${res.status}: ${body.slice(0, 200)}`,
        true,
      )
    const json = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[]
      usage?: { completion_tokens?: number }
      timings?: { predicted_per_second?: number }
    }
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      completionTokens: json.usage?.completion_tokens ?? 0,
      tokensPerSecond: json.timings?.predicted_per_second ?? null,
    }
  }

  stop(): Promise<void> {
    return this.server.stop()
  }
}
