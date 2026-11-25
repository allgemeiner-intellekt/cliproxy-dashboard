// Regenerates the PNG app icons in public/ from public/favicon.svg. Needs Playwright:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/make-icons.mjs
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const rawSvg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const fullBleedSvg = rawSvg.replace(
  /<rect [^>]*\/>/,
  '<rect width="24" height="24" fill="#ffffff"/>',
)

const b = await chromium.launch()
const p = await b.newPage()
for (const [name, size, pad] of [
  ['favicon-32.png', 32, 0],
  ['apple-touch-icon.png', 180, 12],
  ['icon-192.png', 192, 12],
  ['icon-512.png', 512, 24],
  ['icon-maskable-512.png', 512, 64],
]) {
  await p.setViewportSize({ width: size, height: size })
  const inner = size - pad * 2
  const svg = name === 'favicon-32.png' ? rawSvg : fullBleedSvg
  await p.setContent(
    `<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:#ffffff">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body></html>`,
  )
  await p.screenshot({ path: new URL(`../public/${name}`, import.meta.url).pathname, omitBackground: false })
}
await b.close()
console.log('icons written')
