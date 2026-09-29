#!/usr/bin/env node
/**
 * Render the brand's icons (M06b.14) from brand/*.svg with Playwright's
 * Chromium: the extension's icons (on, and off for a stopped engine) and the
 * Player's favicon. Run after changing an SVG:  node brand/render.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = createRequire(join(root, 'e2e/package.json'))('@playwright/test')
const svg = (f) => readFileSync(join(root, 'brand', f), 'utf8')

const browser = await chromium.launch()
const page = await browser.newPage()
async function png(source, size, out) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  )
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, await page.screenshot({ omitBackground: true }))
}
for (const size of [16, 32, 48, 128]) {
  await png(svg('icon.svg'), size, join(root, `apps/extension/public/icon/${size}.png`))
  await png(svg('icon-off.svg'), size, join(root, `apps/extension/public/icon-off/${size}.png`))
}
await browser.close()
mkdirSync(join(root, 'apps/player/public'), { recursive: true })
copyFileSync(join(root, 'brand/icon.svg'), join(root, 'apps/player/public/favicon.svg'))
console.log('icons rendered')
