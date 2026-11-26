#!/usr/bin/env node
/**
 * 记录球体动效帧：按方案逐段截取 2.4× 球体，供 ffmpeg 合成 GIF。
 * 用法：node record.mjs [url] [outDir] [frames] [intervalMs]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const URL_TARGET = process.argv[2] ?? new URL('./index.html?state=busy&theme=dark', import.meta.url).href
const OUT_DIR = process.argv[3] ?? new URL('./shots/frames', import.meta.url).pathname
const FRAMES = Number(process.argv[4] ?? 32)
const INTERVAL = Number(process.argv[5] ?? 60)
const WIDTH = 1240
const HEIGHT = 1800
const SCALE = 2
const PORT = 9461
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VARIANTS = ['aurora', 'pulse', 'orbit', 'prism']
const PAD = 18

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dsh-commander-ball-record',
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
await sleep(1800)

const rects = await send('Runtime.evaluate', {
  expression: `JSON.stringify([...document.querySelectorAll('.stage .win')].map((el) => {
    const r = el.getBoundingClientRect();
    const v = el.querySelector('.orb')?.dataset.variant;
    return { v, x: r.x, y: r.y, w: r.width, h: r.height };
  }))`,
  returnByValue: true,
})
let parsed
try { parsed = JSON.parse(rects.result?.result?.value ?? '[]') } catch { parsed = [] }
const boxes = new Map(parsed.filter((row) => row.v !== undefined).map((row) => [row.v, row]))
if (boxes.size !== VARIANTS.length) {
  console.error('missing stage boxes', parsed)
  ws.close()
  chrome.kill('SIGKILL')
  process.exit(4)
}

for (const variant of VARIANTS) {
  const dir = join(OUT_DIR, variant)
  mkdirSync(dir, { recursive: true })
  const box = boxes.get(variant)
  const clip = {
    x: Math.max(0, box.x - PAD),
    y: Math.max(0, box.y - PAD),
    width: Math.max(1, box.w + PAD * 2),
    height: Math.max(1, box.h + PAD * 2),
    scale: 1,
  }
  for (let i = 0; i < FRAMES; i += 1) {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip,
    })
    if (shot.result?.data === undefined) {
      console.error(`capture failed ${variant} ${i}`, JSON.stringify(shot).slice(0, 400))
      ws.close()
      chrome.kill('SIGKILL')
      process.exit(5)
    }
    writeFileSync(join(dir, `${String(i).padStart(3, '0')}.png`), Buffer.from(shot.result.data, 'base64'))
    await sleep(INTERVAL)
  }
  console.log(`captured ${variant}: ${FRAMES} frames`)
}

writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify({ frames: FRAMES, interval: INTERVAL, width: WIDTH, height: HEIGHT, scale: SCALE }, null, 2))
ws.close()
chrome.kill('SIGTERM')
await sleep(300)
try { chrome.kill('SIGKILL') } catch { /* noop */ }
console.log('done')
