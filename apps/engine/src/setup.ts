import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { arch, cpus, platform } from 'node:os'
import { join } from 'node:path'
import { enginePaths } from './paths'

/**
 * `sublight-engine setup`: the worker programs the engine runs (Spec 06 §6-§7,
 * ADR-0016), installed into ~/.sublight/bin. The engine carries this itself so
 * an installed copy (install.sh) needs nothing from the repository.
 *
 * whisper.cpp and llama.cpp publish no Linux server binaries: they are built
 * from a pinned commit (the checkout must resolve to it or the build stops).
 * yt-dlp is a pinned standalone release checked against its SHA-256. Each
 * writes `<name>.json` with the binary's SHA-256, which the engine checks at
 * start (`workers/verify.ts`).
 */

export interface PinnedBuild {
  name: 'whisper' | 'llama'
  repo: string
  tag: string
  commit: string
  target: string
  cmakeFlags: string[]
}

export const WHISPER_BUILD: PinnedBuild = {
  name: 'whisper',
  repo: 'https://github.com/ggml-org/whisper.cpp',
  tag: 'v1.9.4',
  commit: '927cfce34f31707e17f2bff35c349632fb9e2c3a',
  target: 'whisper-server',
  cmakeFlags: [
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=ON',
    '-DWHISPER_BUILD_EXAMPLES=ON',
  ],
}

/** The translation worker (M04); no network features: models come through the manifest only. */
export const LLAMA_BUILD: PinnedBuild = {
  name: 'llama',
  repo: 'https://github.com/ggml-org/llama.cpp',
  tag: 'b11174',
  commit: 'ed319febb148d02badf332f4ac499b390acbfece',
  target: 'llama-server',
  cmakeFlags: [
    '-DLLAMA_CURL=OFF',
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DLLAMA_BUILD_SERVER=ON',
  ],
}

export const YTDLP_TAG = '2026.08.19'
/** Release asset + SHA-256 per platform (from the release's digests). */
export const YTDLP_ASSETS: Record<string, { name: string; sha256: string }> = {
  'linux-x64': {
    name: 'yt-dlp_linux',
    sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
  },
  'linux-arm64': {
    name: 'yt-dlp_linux_aarch64',
    sha256: 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc',
  },
  'darwin-x64': {
    name: 'yt-dlp_macos',
    sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
  },
  'darwin-arm64': {
    name: 'yt-dlp_macos',
    sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
  },
  'win32-x64': {
    name: 'yt-dlp.exe',
    sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
  },
}

export const SETUP_USAGE = `usage: sublight-engine setup <what> [--cpu] [--jobs N] [--force]

  whisper   build the speech recognizer (whisper.cpp ${WHISPER_BUILD.tag}, ~15 min with CUDA)
  llama     build the translator for languages other than English
            (llama.cpp ${LLAMA_BUILD.tag}, ~20 min with CUDA)
  yt-dlp    download yt-dlp ${YTDLP_TAG}: captions ahead of playback on YouTube and others
  status    what is installed

  --cpu     build without CUDA even when nvcc is found
  --jobs N  parallel compile jobs (default: CPU threads - 2)
  --force   install again even when this version is already there

Builds need git, cmake and a C++ compiler. CUDA is used when nvcc is on PATH
or in /opt/cuda.`

class SetupError extends Error {}

function run(cmd: string, argv: string[], opts: SpawnSyncOptions = {}): void {
  console.log(`$ ${cmd} ${argv.join(' ')}`)
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts })
  if (r.error) throw new SetupError(`${cmd}: ${r.error.message}`)
  if (r.status !== 0) throw new SetupError(`${cmd} failed (exit ${r.status})`)
}

function capture(cmd: string, argv: string[], opts: SpawnSyncOptions = {}): string {
  const out = spawnSync(cmd, argv, { encoding: 'utf8', ...opts }).stdout
  return typeof out === 'string' ? out.trim() : ''
}

const has = (cmd: string) => capture('sh', ['-c', `command -v ${cmd}`]) !== ''

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** nvcc for a CUDA build, or null for CPU. */
export function findNvcc(forceCpu: boolean): string | null {
  if (forceCpu) return null
  const onPath = capture('sh', ['-c', 'command -v nvcc'])
  if (onPath) return onPath
  return existsSync('/opt/cuda/bin/nvcc') ? '/opt/cuda/bin/nvcc' : null
}

/** The recorded install, when its binary is still the one recorded. */
function installed(name: string): { tag?: string; commit?: string; backend?: string } | null {
  const file = join(enginePaths().bin, `${name}.json`)
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as {
      tag?: string
      commit?: string
      backend?: string
      path?: string
      sha256?: string
    }
    return r.path && existsSync(r.path) && sha256Of(r.path) === r.sha256 ? r : null
  } catch {
    return null
  }
}

export function buildPinned(
  spec: PinnedBuild,
  opts: { cpu: boolean; jobs: number; force?: boolean },
): void {
  const want = findNvcc(opts.cpu) ? 'cuda' : 'cpu'
  const have = installed(spec.name)
  if (!opts.force && have?.commit === spec.commit && have.backend === want) {
    console.log(`${spec.target} ${spec.tag} (${want}) is already installed`)
    return
  }
  for (const tool of ['git', 'cmake'])
    if (!has(tool)) throw new SetupError(`${tool} is needed to build ${spec.target}`)
  const paths = enginePaths()
  const src = join(paths.home, 'src', `${spec.name}-${spec.tag}`)
  mkdirSync(join(paths.home, 'src'), { recursive: true })
  if (!existsSync(join(src, '.git')))
    run('git', ['clone', '--depth', '1', '--branch', spec.tag, spec.repo, src])
  const head = capture('git', ['rev-parse', 'HEAD'], { cwd: src })
  if (head !== spec.commit)
    throw new SetupError(
      `refusing to build: ${spec.tag} resolved to ${head}, expected ${spec.commit}. ` +
        `Delete ${src} to clone it again.`,
    )

  const nvcc = findNvcc(opts.cpu)
  const buildDir = join(src, nvcc ? 'build-cuda' : 'build-cpu')
  run('cmake', [
    '-S',
    src,
    '-B',
    buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    ...spec.cmakeFlags,
    // CUDA for the local GPU only (`native`): much faster to compile than every architecture.
    ...(nvcc
      ? ['-DGGML_CUDA=ON', `-DCMAKE_CUDA_COMPILER=${nvcc}`, '-DCMAKE_CUDA_ARCHITECTURES=native']
      : []),
  ])
  run('cmake', [
    '--build',
    buildDir,
    '--config',
    'Release',
    '-j',
    String(opts.jobs),
    '--target',
    spec.target,
  ])

  const built = join(buildDir, 'bin', spec.target)
  if (!existsSync(built)) throw new SetupError(`the build finished but ${built} is missing`)
  mkdirSync(paths.bin, { recursive: true })
  const target = join(paths.bin, spec.target)
  rmSync(target, { force: true })
  copyFileSync(built, target)
  chmodSync(target, 0o755)
  const info = {
    tag: spec.tag,
    commit: spec.commit,
    backend: nvcc ? 'cuda' : 'cpu',
    path: target,
    sha256: sha256Of(target),
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(paths.bin, `${spec.name}.json`), JSON.stringify(info, null, 2) + '\n')
  console.log(`\n${spec.target} ${spec.tag} (${info.backend}) → ${target}`)
}

export async function installYtDlp(force = false): Promise<void> {
  const paths = enginePaths()
  const target = join(paths.bin, platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  // The engine runs the one in its own bin folder, whatever an old record says.
  const record = installed('yt-dlp') as { tag?: string; path?: string } | null
  if (!force && record?.tag === YTDLP_TAG && record.path === target) {
    console.log(`yt-dlp ${YTDLP_TAG} is already installed`)
    return
  }
  const key = `${platform()}-${arch()}`
  const asset = YTDLP_ASSETS[key]
  if (!asset) throw new SetupError(`no pinned yt-dlp build for ${key}`)
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/${asset.name}`
  console.log(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new SetupError(`download failed: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== asset.sha256)
    throw new SetupError(`SHA-256 mismatch: got ${sha256}, expected ${asset.sha256}`)
  mkdirSync(paths.bin, { recursive: true })
  writeFileSync(`${target}.part`, bytes)
  chmodSync(`${target}.part`, 0o755)
  renameSync(`${target}.part`, target)
  const info = {
    tag: YTDLP_TAG,
    asset: asset.name,
    path: target,
    sha256,
    installedAt: new Date().toISOString(),
  }
  writeFileSync(join(paths.bin, 'yt-dlp.json'), JSON.stringify(info, null, 2) + '\n')
  console.log(`yt-dlp ${YTDLP_TAG} → ${target}`)
}

/** What `setup` installed: one line per program, with its version and backend. */
export function setupStatus(): { name: string; installed: boolean; detail: string }[] {
  const bin = enginePaths().bin
  return (['whisper', 'llama', 'yt-dlp'] as const).map((name) => {
    const file = join(bin, `${name}.json`)
    if (!existsSync(file)) return { name, installed: false, detail: 'not installed' }
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as {
        tag?: string
        backend?: string
        path?: string
      }
      const present = !!r.path && existsSync(r.path)
      return {
        name,
        installed: present,
        detail: present ? [r.tag, r.backend].filter(Boolean).join(' · ') : 'binary missing',
      }
    } catch {
      return { name, installed: false, detail: 'unreadable record' }
    }
  })
}

export async function setup(args: string[]): Promise<number> {
  const [what] = args
  const cpu = args.includes('--cpu')
  const force = args.includes('--force')
  const j = args.indexOf('--jobs')
  const jobs = j >= 0 ? Number(args[j + 1]) : Math.max(1, cpus().length - 2)
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error('--jobs needs a positive number')
    return 1
  }
  try {
    switch (what) {
      case 'whisper':
        buildPinned(WHISPER_BUILD, { cpu, jobs, force })
        return 0
      case 'llama':
        buildPinned(LLAMA_BUILD, { cpu, jobs, force })
        return 0
      case 'yt-dlp':
      case 'ytdlp':
        await installYtDlp(force)
        return 0
      case 'status':
        for (const s of setupStatus()) console.log(`${s.name.padEnd(8)} ${s.detail}`)
        return setupStatus().every((s) => s.installed) ? 0 : 3
      default:
        console.error(SETUP_USAGE)
        return what === undefined || what === 'help' || what === '--help' ? 0 : 1
    }
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`setup: ${err.message}`)
      return 1
    }
    throw err
  }
}
