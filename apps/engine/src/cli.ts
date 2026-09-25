import { createReadStream, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { serializeSrt } from '@sublight/core'
import { loadConfig } from './config'
import { enginePaths } from './paths'
import { createServices } from './services'

const USAGE = `usage: pnpm engine:transcribe <file> [--model whisper-small] [--language de]
                               [--translate] [--out subtitles.srt] [--json]

Runs one transcription in-process (no server, M02.8 "--once"): normalizes the
file, runs whisper, prints SRT (or the job result with --json) and exits.
Installs nothing: install models first (POST /v1/models/:id/install).`

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const file = process.argv[2]
  if (!file || file.startsWith('--') || process.argv.includes('--help')) {
    console.error(USAGE)
    return file ? 0 : 1
  }
  if (!existsSync(file)) {
    console.error(`no such file: ${file}`)
    return 1
  }
  const config = loadConfig()
  const real = enginePaths()
  // Media and jobs in a scratch dir; models and binaries from ~/.sublight.
  const scratch = mkdtempSync(join(tmpdir(), 'sublight-cli-'))
  const paths = { ...enginePaths(scratch), models: real.models, bin: real.bin, logs: real.logs }
  const services = createServices(
    { ...config, whisper: { ...config.whisper, port: config.whisper.port + 50 } },
    paths,
  )
  services.jobs.start()
  try {
    process.stderr.write(`normalizing ${basename(file)}…\n`)
    await services.media.ingest('cli', createReadStream(file), basename(file))
    const model = arg('--model') ?? config.defaults.asrModel
    const job = services.jobs.create({
      type: 'transcribe',
      mediaHash: 'cli',
      model,
      params: {
        language: arg('--language') ?? null,
        ...(process.argv.includes('--translate') ? { task: 'translate' as const } : {}),
        maxCueDurationMs: 7000,
      },
    })
    let last = ''
    for (;;) {
      const s = services.jobs.get(job.id)!
      const line = `${s.detail ?? s.state} ${Math.round(s.progress * 100)}%`
      if (line !== last) process.stderr.write(`${line}\n`)
      last = line
      if (s.state === 'failed') {
        console.error(`failed: ${s.error?.code} ${s.error?.message}`)
        return 1
      }
      if (s.state === 'done') break
      await new Promise((r) => setTimeout(r, 250))
    }
    const result = services.jobs.result(job.id)!
    const out = process.argv.includes('--json')
      ? JSON.stringify(result, null, 2)
      : serializeSrt(result.tracks[0]!.cues)
    const target = arg('--out')
    if (target) writeFileSync(target, out)
    else process.stdout.write(out)
    process.stderr.write(
      `language ${result.language ?? '?'} · ${result.realtimeFactor ?? '?'}× realtime\n`,
    )
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  } finally {
    await services.whisper.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
}

main().then((code) => process.exit(code))
