import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyBinaries } from '../src/workers/verify'

describe('worker binaries against their records (baseline E2)', () => {
  it('reports ok, modified and missing binaries', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'sublight-bin-'))
    const record = (name: string, file: string, content: string | null, tag: string) => {
      const path = join(bin, file)
      if (content !== null) writeFileSync(path, content)
      const sha256 = createHash('sha256').update('original').digest('hex')
      writeFileSync(join(bin, `${name}.json`), JSON.stringify({ tag, path, sha256 }))
    }
    record('whisper', 'whisper-server', 'original', 'v1')
    record('llama', 'llama-server', 'tampered', 'b2')
    record('yt-dlp', 'yt-dlp', null, '2026')
    expect(await verifyBinaries(bin)).toEqual([
      { name: 'whisper', tag: 'v1', state: 'ok' },
      { name: 'llama', tag: 'b2', state: 'modified' },
      { name: 'yt-dlp', tag: '2026', state: 'missing' },
    ])
  })
})
