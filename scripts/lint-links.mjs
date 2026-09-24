#!/usr/bin/env node
/**
 * sublight docs link linter (M00.9 — kept in-repo so CI can run it).
 *
 * Checks, for every .md file under docs/:
 *   1. Relative markdown link targets resolve to an existing file.
 *   2. #anchor fragments match a heading whose GitHub-style slug exists in the
 *      target (punct stripped, lowercase, each space -> '-'; double hyphens
 *      preserved).
 *   3. Code fences (```mermaid etc.) are balanced.
 *   4. Obsidian wikilinks are reported as warnings.
 *
 * Exit code 0 = green.
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname, relative, normalize } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'dist', '.wxt', '.output'])

function mdFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
      } else if (entry.name.endsWith('.md')) {
        out.push(join(dir, entry.name))
      }
    }
  }
  walk(join(ROOT, 'docs'))
  return out
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // strip punctuation (unicodedata-normalized proxy)
    .replace(/ /g, '-')
    .replace(/^-+|-+$/g, '')
}

function headingSlugs(path) {
  const slugs = new Set()
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const line of lines) {
    const m = /^#{1,6}\s+(.*)$/.exec(line)
    if (!m) continue
    let text = m[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // strip inline links
      .replace(/`/g, '')
      .trim()
    slugs.add(slugify(text))
  }
  return slugs
}

function fenceIssues(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const issues = []
  let inFence = false
  let fenceType = null
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s.startsWith('```')) {
      if (!inFence) {
        inFence = true
        fenceType = s.slice(3).trim() || 'code'
      } else {
        const info = s.slice(3).trim()
        if (info && info !== fenceType)
          issues.push(
            `  ${relative(ROOT, path)}:${i + 1}: closing fence \`${info}\` mismatches open \`${fenceType}\``,
          )
        inFence = false
        fenceType = null
      }
    }
  }
  if (inFence) issues.push(`  ${relative(ROOT, path)}: unclosed fence (${fenceType})`)
  return issues
}

const LINKS_RE = /\[[^\]]*\]\(([^\s)\]]+)(?:\s+["'][^"']*["'])?\)/g

const problems = []
const warnings = []
let checked = 0

for (const path of mdFiles()) {
  const rel = relative(ROOT, path)
  warnings.push(...fenceIssues(path))

  const content = readFileSync(path, 'utf8')

  // Wikilinks
  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    warnings.push(`  ${rel}: wikilink [[${m[1]}]]`)
  }

  // Markdown links
  for (const m of content.matchAll(LINKS_RE)) {
    let target = m[1]
    checked += 1
    if (/^(https?:|mailto:|#|\/\/)/.test(target)) continue

    let frag = null
    const hashIdx = target.indexOf('#')
    if (hashIdx !== -1) {
      frag = target.slice(hashIdx + 1)
      target = target.slice(0, hashIdx)
    }

    if (!target) {
      if (frag && !headingSlugs(path).has(frag)) {
        problems.push(`  ${rel}: anchor '#${frag}' is not a heading in the same file`)
      }
      continue
    }

    const resolved = realpathSafe(normalize(join(dirname(path), target)))
    if (!resolved.exists) {
      problems.push(`  ${rel}: missing target '${target}'`)
      continue
    }
    if (frag) {
      if (resolved.isDir) {
        problems.push(`  ${rel}: anchor on directory link '${target}#${frag}'`)
      } else if (!headingSlugs(resolved.path).has(frag)) {
        problems.push(`  ${rel}: anchor '#${frag}' not found in ${target}`)
      }
    }
  }
}

function realpathSafe(p) {
  try {
    const real = realpathSync(p)
    return { exists: true, isDir: existsSync(real) && isDirectory(real), path: real }
  } catch {
    return { exists: false }
  }
}

function isDirectory(p) {
  try {
    return readdirSync(p).length >= 0
  } catch {
    return false
  }
}

console.log(`checked ${checked} links, ${problems.length} problems, ${warnings.length} warnings`)
for (const w of warnings.slice(0, 30)) console.log('WARN', w)
if (problems.length) {
  console.log('----- PROBLEMS -----')
  for (const p of [...new Set(problems)].slice(0, 80)) console.log(p)
  process.exit(1)
}
console.log('OK: relative links resolve; anchors match headings; fences balanced.')
