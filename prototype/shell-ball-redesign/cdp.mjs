#!/usr/bin/env node
/**
 * 小型 CDP 探针：打开页面、等待稳定、执行一段表达式并打印 JSON。
 * 用法：node cdp.mjs <url> '<expression>'
 */
import { spawn } from 'node:child_process'

const URL_TARGET = process.argv[2]
const EXPRESSION = process.argv[3] ?? '1'
const WIDTH = Number(process.argv[4] ?? 1240)
const HEIGHT = Number(process.argv[5] ?? 1000)
const SCALE = Number(process.argv[6] ?? 2)
const PORT = Number(process.argv[7] ?? 9451)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (URL_TARGET === undefined) {
  console.error('usage: node cdp.mjs <url> <expression> [width] [height] [scale] [port]')
  process.exit(2)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dsh-commander-ball-probe',
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
const result = await send('Runtime.evaluate', {
  expression: EXPRESSION,
  returnByValue: true,
  awaitPromise: true,
})
console.log(JSON.stringify(result.result?.result?.value ?? result.result ?? result, null, 2))
ws.close()
chrome.kill('SIGTERM')
await sleep(200)
try { chrome.kill('SIGKILL') } catch { /* noop */ }
