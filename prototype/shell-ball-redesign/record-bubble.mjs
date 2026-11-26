#!/usr/bin/env node
/**
 * 录制推理气泡演示：点击「播放推理链」，按 120 ms 截取球 + 气泡场景。
 * 用法：node record-bubble.mjs [url] [outDir] [frames] [intervalMs]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const URL_TARGET = process.argv[2] ?? new URL('./index.html?state=idle&theme=dark', import.meta.url).href
const OUT_DIR = process.argv[3] ?? new URL('./shots/frames-bubble', import.meta.url).pathname
const FRAMES = Number(process.argv[4] ?? 56)
const INTERVAL = Number(process.argv[5] ?? 120)
const WIDTH = 1240
const HEIGHT = 3203
const SCALE = 2
const PORT = 9471
const PAD = 40
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dsh-commander-bubble-record',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-breakpad', '--disable-crash-reporter',
  `--window-size=${WIDTH},${HEIGHT}`, '--remote-allow-origins=*', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
chrome.stderr.on('data', (chunk) => { stderr += String(chunk) })

const fetchJson = async (path) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`)
  return response.json()
}
let version
for (let i = 0; i < 100; i += 1) {
  try { version = await fetchJson('/json/version'); break } catch { await sleep(200) }
}
if (version === undefined) {
  console.error(stderr.slice(-2000))
  chrome.kill('SIGKILL')
  process.exit(3)
}
let target
for (let i = 0; i < 40; i += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
    if (response.ok) { target = await response.json(); break }
  } catch { /* retry */ }
  await sleep(250)
}
if (target?.webSocketDebuggerUrl === undefined) {
  console.error('cannot create page target')
  chrome.kill('SIGKILL')
  process.exit(3)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
ws.onmessage = (message) => {
  let data
  try { data = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)) } catch { return }
  if (data.id !== undefined) {
    const entry = pending.get(data.id)
    if (entry !== undefined) { pending.delete(data.id); entry.resolve(data) }
  }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, { resolve })
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
  screenWidth: WIDTH, screenHeight: HEIGHT,
})
await send('Page.navigate', { url: URL_TARGET })
await sleep(1600)

const rectResult = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector('.demo-stage .bubble-scene');
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`,
  returnByValue: true,
})
const rect = rectResult.result?.result?.value
if (rect === undefined || rect === null) {
  console.error('missing demo scene', JSON.stringify(rectResult).slice(0, 600))
  ws.close()
  chrome.kill('SIGKILL')
  process.exit(4)
}

const clip = {
  x: Math.max(0, rect.x - PAD),
  y: Math.max(0, rect.y - PAD),
  width: Math.max(1, rect.w + PAD * 2),
  height: Math.max(1, rect.h + PAD * 2),
  scale: 1,
}

await send('Runtime.evaluate', {
  expression: `document.querySelector('[data-bubble-action="chain"]')?.click()`,
})
await sleep(160)
mkdirSync(OUT_DIR, { recursive: true })
for (let i = 0; i < FRAMES; i += 1) {
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip,
  })
  if (shot.result?.data === undefined) {
    console.error(`capture failed ${i}`, JSON.stringify(shot).slice(0, 400))
    ws.close()
    chrome.kill('SIGKILL')
    process.exit(5)
  }
  writeFileSync(join(OUT_DIR, `${String(i).padStart(3, '0')}.png`), Buffer.from(shot.result.data, 'base64'))
  await sleep(INTERVAL)
}
console.log(`captured ${FRAMES} bubble frames (${clip.width}×${clip.height} css) at ${join(OUT_DIR)}`)
ws.close()
chrome.kill('SIGTERM')
await sleep(300)
try { chrome.kill('SIGKILL') } catch { /* noop */ }
