#!/usr/bin/env node
/**
 * Build the pinned whisper.cpp server into ~/.sublight/bin (Spec 06 §6, ADR-0016).
 *
 *   pnpm engine:setup-whisper [--cpu] [--jobs N]
 *
 * Supply chain: the tag must resolve to the pinned commit or the build stops.
 * whisper.cpp publishes no Linux server binary, so we compile from that exact
 * commit; CUDA is used when nvcc is on PATH (or /opt/cuda) unless --cpu.
 * Writes ~/.sublight/bin/whisper.json describing what was built; the engine
 * reads it to find the binary.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cpus, homedir } from 'node:os'
import { join } from 'node:path'

const WHISPER_REPO = 'https://github.com/ggml-org/whisper.cpp'
const WHISPER_TAG = 'v1.9.4'
const WHISPER_COMMIT = '927cfce34f31707e17f2bff35c349632fb9e2c3a'

const args = process.argv.slice(2)
const forceCpu = args.includes('--cpu')
const jobsArg = args.indexOf('--jobs')
const jobs = jobsArg >= 0 ? Number(args[jobsArg + 1]) : Math.max(1, cpus().length - 2)

const home = process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
const src = join(home, 'src', `whisper.cpp-${WHISPER_TAG}`)
const binDir = join(home, 'bin')

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(' ')}`)
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`\n${cmd} failed (exit ${r.status}).`)
    process.exit(r.status ?? 1)
  }
}

function capture(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf8', ...opts }).stdout?.trim() ?? ''
}

function findNvcc() {
  if (forceCpu) return null
  const onPath = capture('sh', ['-c', 'command -v nvcc'])
  if (onPath) return onPath
  return existsSync('/opt/cuda/bin/nvcc') ? '/opt/cuda/bin/nvcc' : null
}

mkdirSync(join(home, 'src'), { recursive: true })
if (!existsSync(join(src, '.git'))) {
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_TAG, WHISPER_REPO, src])
}
const head = capture('git', ['rev-parse', 'HEAD'], { cwd: src })
if (head !== WHISPER_COMMIT) {
  console.error(
    `Refusing to build: ${WHISPER_TAG} resolved to ${head}, expected ${WHISPER_COMMIT}.\n` +
      `Delete ${src} to re-clone, and re-pin only after reviewing the upstream change.`,
  )
  process.exit(1)
}

const nvcc = findNvcc()
const buildDir = join(src, nvcc ? 'build-cuda' : 'build-cpu')
const cmakeArgs = [
  '-S',
  src,
  '-B',
  buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=ON',
  '-DWHISPER_BUILD_EXAMPLES=ON',
]
if (nvcc) {
  cmakeArgs.push('-DGGML_CUDA=ON', `-DCMAKE_CUDA_COMPILER=${nvcc}`)
  // Build for the local GPU only (T1000 = sm_75); all-arch builds take far longer.
  cmakeArgs.push('-DCMAKE_CUDA_ARCHITECTURES=native')
}
run('cmake', cmakeArgs)
run('cmake', [
  '--build',
  buildDir,
  '--config',
  'Release',
  '-j',
  String(jobs),
  '--target',
  'whisper-server',
])

const built = join(buildDir, 'bin', 'whisper-server')
if (!existsSync(built)) {
  console.error(`Build finished but ${built} is missing.`)
  process.exit(1)
}
mkdirSync(binDir, { recursive: true })
const target = join(binDir, 'whisper-server')
rmSync(target, { force: true })
copyFileSync(built, target)
chmodSync(target, 0o755)
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
const info = {
  tag: WHISPER_TAG,
  commit: WHISPER_COMMIT,
  backend: nvcc ? 'cuda' : 'cpu',
  path: target,
  sha256,
  builtAt: new Date().toISOString(),
}
writeFileSync(join(binDir, 'whisper.json'), JSON.stringify(info, null, 2) + '\n')
console.log(`\nwhisper-server ${WHISPER_TAG} (${info.backend}) → ${target}\nsha256 ${sha256}`)
