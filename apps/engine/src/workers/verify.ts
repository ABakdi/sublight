import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BinaryCheck } from '@sublight/protocol'

/**
 * Are the worker binaries the ones the setup scripts built or downloaded
 * (security baseline E2)? Each script records the file's SHA-256 next to it
 * (`whisper.json`, `llama.json`, `yt-dlp.json`); a binary that no longer
 * matches was rebuilt, replaced or tampered with. The engine warns, it doesn't refuse.
 */
export async function verifyBinaries(binDir: string): Promise<BinaryCheck[]> {
  const out: BinaryCheck[] = []
  for (const name of ['whisper', 'llama', 'yt-dlp'] as const) {
    const recordFile = join(binDir, `${name}.json`)
    if (!existsSync(recordFile)) continue
    let record: { tag?: string; path?: string; sha256?: string }
    try {
      record = JSON.parse(readFileSync(recordFile, 'utf8')) as typeof record
    } catch {
      out.push({ name, tag: null, state: 'unrecorded' })
      continue
    }
    const tag = record.tag ?? null
    if (!record.path || !existsSync(record.path)) {
      out.push({ name, tag, state: 'missing' })
      continue
    }
    if (!record.sha256) {
      out.push({ name, tag, state: 'unrecorded' })
      continue
    }
    const actual = await sha256(record.path)
    out.push({ name, tag, state: actual === record.sha256 ? 'ok' : 'modified' })
  }
  return out
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}
