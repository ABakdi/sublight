/**
 * Build one binary from a pinned upstream commit into ~/.sublight/bin
 * (ADR-0016). The checkout must resolve to the pinned commit or the build
 * stops. CUDA is used when nvcc is on PATH (or /opt/cuda) unless `--cpu`;
 * CUDA builds target the local GPU only (`native`), which is much faster to
 * compile than all architectures. Writes `<name>.json` with the backend and
 * the binary's SHA-256 so the engine knows what it runs.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { cpus, homedir } from 'node:os'
import { join } from 'node:path'

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

/**
 * @param {{ name: string, repo: string, tag: string, commit: string, target: string,
 *   cmakeFlags?: string[], cudaFlags?: string[] }} spec
 */
export function buildPinned(spec) {
  const args = process.argv.slice(2)
  const forceCpu = args.includes('--cpu')
  const jobsArg = args.indexOf('--jobs')
  const jobs = jobsArg >= 0 ? Number(args[jobsArg + 1]) : Math.max(1, cpus().length - 2)
  const home = process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
  const src = join(home, 'src', `${spec.name}-${spec.tag}`)
  const binDir = join(home, 'bin')

  mkdirSync(join(home, 'src'), { recursive: true })
  if (!existsSync(join(src, '.git'))) {
    run('git', ['clone', '--depth', '1', '--branch', spec.tag, spec.repo, src])
  }
  const head = capture('git', ['rev-parse', 'HEAD'], { cwd: src })
  if (head !== spec.commit) {
    console.error(
      `Refusing to build: ${spec.tag} resolved to ${head}, expected ${spec.commit}.\n` +
        `Delete ${src} to re-clone, and re-pin only after reviewing the upstream change.`,
    )
    process.exit(1)
  }

  const nvcc = forceCpu
    ? null
    : capture('sh', ['-c', 'command -v nvcc']) ||
      (existsSync('/opt/cuda/bin/nvcc') ? '/opt/cuda/bin/nvcc' : null)
  const buildDir = join(src, nvcc ? 'build-cuda' : 'build-cpu')
  const cmakeArgs = [
    '-S',
    src,
    '-B',
    buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    ...(spec.cmakeFlags ?? []),
  ]
  if (nvcc) {
    cmakeArgs.push(
      '-DGGML_CUDA=ON',
      `-DCMAKE_CUDA_COMPILER=${nvcc}`,
      '-DCMAKE_CUDA_ARCHITECTURES=native',
      ...(spec.cudaFlags ?? []),
    )
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
    spec.target,
  ])

  const built = join(buildDir, 'bin', spec.target)
  if (!existsSync(built)) {
    console.error(`Build finished but ${built} is missing.`)
    process.exit(1)
  }
  mkdirSync(binDir, { recursive: true })
  const target = join(binDir, spec.target)
  rmSync(target, { force: true })
  copyFileSync(built, target)
  chmodSync(target, 0o755)
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
  const info = {
    tag: spec.tag,
    commit: spec.commit,
    backend: nvcc ? 'cuda' : 'cpu',
    path: target,
    sha256,
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(binDir, `${spec.name}.json`), JSON.stringify(info, null, 2) + '\n')
  console.log(`\n${spec.target} ${spec.tag} (${info.backend}) → ${target}\nsha256 ${sha256}`)
}
