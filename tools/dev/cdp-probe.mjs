#!/usr/bin/env node
/**
 * 无头 Chrome CDP 探针：打开隔离 DSH web Host 页面，收集 client 半运行时报错并做页面内评估。
 *
 * 用法：node tools/dev/cdp-probe.mjs --url 'http://127.0.0.1:PORT/?token=...' --out /tmp/client-repro/report
 * 依赖：Google Chrome（headless=new）+ Node22 全局 WebSocket；仅本地 loopback，独立 user-data-dir。
 *
 * 输出（--out 目录）：
 *   cdp-events.json      Runtime.exceptionThrown / consoleAPICalled / Log.entryAdded 原始事件
 *   network.json         commander/client.js 相关请求（status/failed）
 *   evaluate.json        页面内 evaluate 结果（boot entries / DOM / ModuleLoader / globals）
 *   screenshot.png       Page.captureScreenshot
 *   summary.txt          过滤后的 TOP 错误 + 结论要点
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const URL_TARGET = argOf('--url')
const OUT = argOf('--out', '/tmp/client-repro/report')
const PORT = Number(argOf('--port', '9333'))
const USER_DATA = argOf('--user-data-dir', '/tmp/client-repro/chrome')
const CHROME = argOf('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
if (URL_TARGET === undefined) { console.error('usage: node tools/dev/cdp-probe.mjs --url <token url> --out <dir>'); process.exit(2) }
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,900', '--remote-allow-origins=*',
  // macOS + 受限父进程下必须关沙箱/崩溃上报，否则 renderer 直接 targetCrashed（CDP 无响应）
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-breakpad', '--disable-crash-reporter',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let chromeStderr = ''
chrome.stderr.on('data', (d) => { chromeStderr += String(d) })

const fetchJson = async (path) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
  return res.json()
}
let version
for (let i = 0; i < 80; i += 1) {
  try { version = await fetchJson('/json/version'); break } catch { await sleep(250) }
}
if (version === undefined) { console.error('chrome did not start'); console.error(chromeStderr.slice(-2000)); chrome.kill('SIGKILL'); process.exit(3) }

// 用 /json/new 建页面 target，直连 page WS（避免 browser session 的兼容问题）
const target = await (async () => {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
      if (res.ok) return res.json()
    } catch { /* retry */ }
    await sleep(250)
  }
  return undefined
})()
if (target === undefined || target.webSocketDebuggerUrl === undefined) {
  console.error('cannot create chrome page target')
  console.error(chromeStderr.slice(-2000))
  chrome.kill('SIGKILL')
  process.exit(3)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
const events = []
let idSeq = 0
const pending = new Map()
ws.onmessage = (message) => {
  let data
  try { data = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)) } catch { return }
  if (data.id !== undefined) {
    const entry = pending.get(data.id)
    if (entry) { pending.delete(data.id); entry.resolve(data) }
    return
  }
  events.push({ at: Date.now(), method: data.method, params: data.params })
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++idSeq
  pending.set(id, { resolve })
  ws.send(JSON.stringify({ id, method, params }))
  setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `timeout: ${method}` } }) }
  }, 15000)
})
const sendS = send
await sendS('Page.enable')
await sendS('Runtime.enable')
await sendS('Log.enable')
await sendS('Network.enable')
await sendS('Page.navigate', { url: URL_TARGET })
await sleep(12000) // 等 boot graph、client bundle 懒加载、apply 与首屏渲染

const evaluate = async (expression) => {
  const res = await sendS('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return res.result?.result?.value ?? { exception: res.result?.exceptionDetails?.text }
}
const evaluateResults = {
  url: URL_TARGET,
  moduleLoaderPresent: await evaluate('typeof window.__ModuleLoader__'),
  bootExists: await evaluate('typeof window.__DSH_BOOT__'),
  commanderEntries: await evaluate(`(() => { try { const b=window.__DSH_BOOT__; if(!b) return []; return (b.entries||[]).filter(e=>String(e.id).includes('commander')); } catch(e){ return 'ERR:'+String(e) } })()`),
  commanderBatches: await evaluate(`(() => { try { const b=window.__DSH_BOOT__; if(!b) return []; return (b.batches||[]).filter(x=>(x.entries||[]).some(id=>String(id).includes('commander'))); } catch(e){ return 'ERR:'+String(e) } })()`),
  dshcNodes: await evaluate(`document.querySelectorAll('[class*="dshc"], [data-commander], [class*="commander"]').length`),
  ballNodes: await evaluate(`document.querySelectorAll('[class*="ball"], [class*="fab"], [class*="launcher"], [class*="overlay"]').length`),
  bodyHasCommanderText: await evaluate(`document.body ? document.body.innerText.includes('指挥官') : false`),
  bodyTextHead: await evaluate(`document.body ? document.body.innerText.slice(0,300) : null`),
  title: await evaluate('document.title'),
  moduleLoadErrors: await evaluate(`(() => { try { const m=window.__ModuleLoader__; const keys=m?Object.keys(m):[]; return { keys, mode: m?.mode ?? null, pending: Array.isArray(m?.pendingQueue)?m.pendingQueue.length:null }; } catch(e){ return 'ERR:'+String(e) } })()`),
}
await sleep(500)

const screenshot = await sendS('Page.captureScreenshot', { format: 'png' })
if (screenshot.result?.data) writeFileSync(join(OUT, 'screenshot.png'), Buffer.from(screenshot.result.data, 'base64'))

// ---- 过滤错误 ----
const isRelevant = (text) => /commander|slot|Failed to load|ModuleLoader|dshc|overlay|settings\.section|cannot|undefined|TypeError|ReferenceError/i.test(String(text ?? ''))
const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => ({
  at: e.at,
  text: e.params?.exceptionDetails?.text,
  description: e.params?.exceptionDetails?.exception?.description,
  url: e.params?.exceptionDetails?.url,
  line: e.params?.exceptionDetails?.lineNumber,
}))
const consoleErrors = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(e.params?.type)).map((e) => ({
  at: e.at, type: e.params?.type,
  args: (e.params?.args ?? []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type),
}))
const logEntries = events.filter((e) => e.method === 'Log.entryAdded').map((e) => ({ at: e.at, level: e.params?.entry?.level, text: e.params?.entry?.text, url: e.params?.entry?.url }))
const consoleAll = events.filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => ({
  at: e.at, type: e.params?.type,
  args: (e.params?.args ?? []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type),
}))
const commanderConsole = consoleAll.filter((e) => e.args.some((arg) => /dsh-commander|commander|slot/.test(String(arg))))
const network = events.filter((e) => e.method === 'Network.responseReceived' || e.method === 'Network.loadingFailed')
  .map((e) => e.method === 'Network.responseReceived'
    ? { at: e.at, kind: 'response', url: e.params?.response?.url, status: e.params?.response?.status, mime: e.params?.response?.mimeType }
    : { at: e.at, kind: 'failed', url: e.params?.requestId, error: e.params?.errorText })
  .filter((n) => /commander|client\.js|\/plugins\/|DSH_BOOT/i.test(String(n.url)))

writeFileSync(join(OUT, 'cdp-events.json'), JSON.stringify({ exceptions, consoleErrors, consoleAll, logEntries }, null, 2) + '\n')
writeFileSync(join(OUT, 'network.json'), JSON.stringify(network, null, 2) + '\n')
writeFileSync(join(OUT, 'evaluate.json'), JSON.stringify(evaluateResults, null, 2) + '\n')
const relevantExceptions = exceptions.filter((e) => isRelevant(`${e.text} ${e.description}`))
const relevantConsole = consoleErrors.filter((e) => isRelevant(e.args.join(' ')))
const relevantLogs = logEntries.filter((e) => isRelevant(e.text))
const summary = [
  `url=${URL_TARGET}`,
  `chrome=${version.Browser}`,
  `exceptions=${exceptions.length} (relevant ${relevantExceptions.length})`,
  `consoleErrors=${consoleErrors.length} (relevant ${relevantConsole.length})`,
  `logEntries=${logEntries.length} (relevant ${relevantLogs.length})`,
  `commanderNetwork=${JSON.stringify(network)}`,
  `--- TOP relevant exceptions ---`,
  ...relevantExceptions.slice(0, 10).map((e) => `[exception] ${e.text}\n${e.description ?? ''}`),
  `--- TOP relevant console errors ---`,
  ...relevantConsole.slice(0, 10).map((e) => `[console] ${e.args.join(' | ')}`),
  `--- TOP relevant log entries ---`,
  ...relevantLogs.slice(0, 10).map((e) => `[log:${e.level}] ${e.text} ${e.url ?? ''}`),
  `--- console (all, commander/slot filtered) ---`,
  ...commanderConsole.slice(0, 20).map((e) => `[console:${e.type}] ${e.args.join(' | ')}`),
].join('\n') + '\n'
writeFileSync(join(OUT, 'summary.txt'), summary)
console.log(summary)
ws.close()
chrome.kill('SIGTERM')
await sleep(500)
try { chrome.kill('SIGKILL') } catch { /* noop */ }
process.exit(0)
