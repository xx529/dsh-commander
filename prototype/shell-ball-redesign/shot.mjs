#!/usr/bin/env node
/**
 * 设计稿截图：CDP 控制无头 Chrome，固定 CSS 视口（默认 440×986 @2x），
 * 用 Emulation 而不是 --window-size，避免 macOS 下窗口尺寸/DPR 不一致。
 *
 * 用法：
 *   node shot.mjs --url 'file:///…/index.html?solo=1' --out shots/panel.png
 *   node shot.mjs --url '…' --out shots/full.png --full 1
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const URL_TARGET = argOf('--url')
const OUT = argOf('--out', 'shots/shot.png')
const WIDTH = Number(argOf('--width', '440'))
const HEIGHT = Number(argOf('--height', '986'))
const SCALE = Number(argOf('--scale', '2'))
const FULL = argOf('--full', '0') === '1'
const PORT = Number(argOf('--port', '9444'))
const USER_DATA = argOf('--user-data-dir', '/tmp/dsh-commander-prototype-shot')
const CHROME = argOf('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
if (URL_TARGET === undefined) {
  console.error('usage: node shot.mjs --url <url> --out <png> [--width 440] [--height 986] [--full 1]')
  process.exit(2)
}
mkdirSync(dirname(OUT), { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
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
for (let i = 0; i < 80; i += 1) {
  try { version = await fetchJson('/json/version'); break } catch { await sleep(250) }
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
  console.error(stderr.slice(-2000))
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
await sleep(1400)
const metrics = await send('Page.getLayoutMetrics')
const content = metrics.result?.cssContentSize ?? { width: WIDTH, height: HEIGHT }
const height = FULL ? Math.max(HEIGHT, Math.ceil(content.height)) : HEIGHT
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: FULL,
  clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 },
})
if (shot.result?.data === undefined) {
  console.error('screenshot failed', JSON.stringify(shot).slice(0, 500))
  ws.close()
  chrome.kill('SIGKILL')
  process.exit(4)
}
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
console.log(`${OUT} ${WIDTH * SCALE}x${height * SCALE} (css ${WIDTH}x${height})`)
ws.close()
chrome.kill('SIGTERM')
await sleep(200)
try { chrome.kill('SIGKILL') } catch { /* noop */ }
