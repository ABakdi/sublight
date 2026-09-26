#!/usr/bin/env node
/**
 * Install the pinned yt-dlp release into ~/.sublight/bin (ADR-0020).
 *
 *   pnpm engine:setup-ytdlp
 *
 * The engine uses it to find a page video's audio when the page has no
 * direct media URL (YouTube, Vimeo and other MSE players), so captions can
 * be made ahead of playback. The standalone build needs no Python. The
 * download must match the pinned SHA-256 or nothing is installed.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { join } from 'node:path'

const TAG = '2026.08.19'
/** Release asset + SHA-256 per platform (from the release's digests). */
const ASSETS = {
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

const key = `${platform()}-${arch()}`
const asset = ASSETS[key]
if (!asset) {
  console.error(`No pinned yt-dlp build for ${key}.`)
  process.exit(1)
}
const home = process.env.SUBLIGHT_HOME ?? join(homedir(), '.sublight')
const binDir = join(home, 'bin')
const target = join(binDir, platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/${asset.name}`

console.log(`Downloading ${url}`)
const res = await fetch(url)
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`)
  process.exit(1)
}
const bytes = Buffer.from(await res.arrayBuffer())
const sha256 = createHash('sha256').update(bytes).digest('hex')
if (sha256 !== asset.sha256) {
  console.error(`SHA-256 mismatch: got ${sha256}, expected ${asset.sha256}. Nothing installed.`)
  process.exit(1)
}
mkdirSync(binDir, { recursive: true })
writeFileSync(`${target}.part`, bytes)
chmodSync(`${target}.part`, 0o755)
renameSync(`${target}.part`, target)
writeFileSync(
  join(binDir, 'yt-dlp.json'),
  JSON.stringify(
    { tag: TAG, asset: asset.name, path: target, sha256, installedAt: new Date().toISOString() },
    null,
    2,
  ) + '\n',
)
console.log(`yt-dlp ${TAG} → ${target}\nsha256 ${sha256}`)
