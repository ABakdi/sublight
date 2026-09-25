import { execFile } from 'node:child_process'
import type { GpuInfo } from '@sublight/protocol'

const NONE: GpuInfo = { available: false, name: null, vramTotal: null, vramFree: null }
const CACHE_MS = 5000

let cached: { at: number; info: GpuInfo } | null = null

/** VRAM via `nvidia-smi` (Spec 06 §2; NVML bindings can replace it later). MB units. */
export function probeGpu(): Promise<GpuInfo> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.info)
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
      (err, stdout) => {
        let info = NONE
        const line = err ? undefined : stdout.trim().split('\n')[0]
        const [name, total, free] = line?.split(',').map((s) => s.trim()) ?? []
        if (name && Number.isFinite(Number(total))) {
          info = { available: true, name, vramTotal: Number(total), vramFree: Number(free) }
        }
        cached = { at: Date.now(), info }
        resolve(info)
      },
    )
  })
}
