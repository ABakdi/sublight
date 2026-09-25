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
    // Translator (ADR-0019): the closest Apache-2.0 successor to Qwen2.5-3B,
    // whose own license (Qwen Research) forbids commercial use. Qwen publishes
    // no GGUF for this release; bartowski's Q4_K_M of the upstream weights
    // (Qwen/Qwen3-4B-Instruct-2507 @ cdbee75f) is pinned by revision + SHA-256.
    id: 'qwen3-4b-instruct',
    role: 'translate',
    name: 'Qwen3 4B Instruct 2507, Q4_K_M',
    repo: 'bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF',
    revision: 'ae44f08e1392f39c0e474af10c3ff8355c8b6688',
    file: 'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sha256: '2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e',
    sizeBytes: 2497280736,
    vramClass: '~3 GB',
    license: 'Apache-2.0',
  },
]

export function manifestEntry(id: string): ManifestEntry | undefined {
  return MODEL_MANIFEST.find((m) => m.id === id)
}

export function downloadUrl(entry: ManifestEntry): string {
  return `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`
}
