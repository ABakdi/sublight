/**
 * Pinned model manifest (Spec 06 §3, ADR-0016). Every artifact is a
 * Hugging Face file at a fixed revision with its SHA-256; installs that
 * don't match are refused. Refresh deliberately: bump `revision`, re-read
 * sizes and hashes from the HF API, review licenses.
 */
export type ModelRole = 'asr' | 'translate'
export type AsrTaskName = 'transcribe' | 'translate'

export interface ManifestEntry {
  id: string
  role: ModelRole
  name: string
  repo: string
  revision: string
  file: string
  sha256: string
  sizeBytes: number
  /** Rough resident VRAM on the target GPU (ADR-0007). */
  vramClass: string
  license: string
  /** ASR: supported Whisper tasks (ADR-0018). */
  tasks?: AsrTaskName[]
}

const WHISPER_REPO = 'ggerganov/whisper.cpp'
const WHISPER_REV = '5359861c739e955e79d9a303bcbc70fb988958b1'
const BOTH: AsrTaskName[] = ['transcribe', 'translate']

export const MODEL_MANIFEST: readonly ManifestEntry[] = [
  {
    id: 'whisper-base',
    role: 'asr',
    name: 'Whisper base (fast)',
    repo: WHISPER_REPO,
    revision: WHISPER_REV,
    file: 'ggml-base.bin',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    sizeBytes: 147951465,
    vramClass: '~0.5 GB',
    license: 'MIT',
    tasks: BOTH,
  },
  {
    id: 'whisper-small',
    role: 'asr',
    name: 'Whisper small (default)',
    repo: WHISPER_REPO,
    revision: WHISPER_REV,
    file: 'ggml-small.bin',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    sizeBytes: 487601967,
    vramClass: '~1 GB',
    license: 'MIT',
    tasks: BOTH,
  },
  {
    id: 'whisper-medium-q5',
    role: 'asr',
    name: 'Whisper medium, 5-bit (accurate)',
    repo: WHISPER_REPO,
    revision: WHISPER_REV,
    file: 'ggml-medium-q5_0.bin',
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
    sizeBytes: 539212467,
    vramClass: '~1.5 GB',
    license: 'MIT',
    tasks: BOTH,
  },
  {
    id: 'whisper-large-v3-q5',
    role: 'asr',
    name: 'Whisper large-v3, 5-bit (best, slow)',
    repo: WHISPER_REPO,
    revision: WHISPER_REV,
    file: 'ggml-large-v3-q5_0.bin',
    sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
    sizeBytes: 1081140203,
    vramClass: '~2.5 GB',
    license: 'MIT',
    tasks: BOTH,
  },
  {
    // Turbo was fine-tuned on transcription only: no reliable translate (ADR-0018).
    id: 'whisper-large-v3-turbo-q5',
    role: 'asr',
    name: 'Whisper large-v3-turbo, 5-bit (best speed/quality, no translate)',
    repo: WHISPER_REPO,
    revision: WHISPER_REV,
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    sizeBytes: 574041195,
    vramClass: '~1.5 GB',
    license: 'MIT',
    tasks: ['transcribe'],
  },
  {
    // License is the Qwen Research License (HF: "other"), not Apache-2.0 — the
    // 1.5B and 7B sizes are Apache-2.0. Open question for M04 (ADR-0016).
    id: 'qwen2.5-3b-instruct',
    role: 'translate',
    name: 'Qwen2.5 3B Instruct, Q4_K_M',
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    revision: '7dabda4d13d513e3e842b20f0d435c732f172cbe',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    sha256: '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d',
    sizeBytes: 2104932768,
    vramClass: '~2.5 GB',
    license: 'qwen-research',
  },
]

export function manifestEntry(id: string): ManifestEntry | undefined {
  return MODEL_MANIFEST.find((m) => m.id === id)
}

export function downloadUrl(entry: ManifestEntry): string {
  return `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`
}
