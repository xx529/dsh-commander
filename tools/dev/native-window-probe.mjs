#!/usr/bin/env node
/**
 * 真实窗口页探针：用构建产物 lib/host/native/window-page.js 渲染 /commander/window，
 * 让 Tauri 壳加载真实 lib/window.js（React + store），验证 bundle 在 WKWebView 中执行、
 * store.start() 真的向 Host 数据面发起 /commander/config 与 /commander/state 请求。
 *
 * 用法：node tools/dev/native-window-probe.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('../../packages/dsh-commander/', import.meta.url).pathname
const binary = join(root, 'native', 'dist', `${platform()}-${arch() === 'x64' ? 'x64' : arch()}`, 'dsh-commander-shell')
const windowPageModule = join(root, 'lib', 'host', 'native', 'window-page.js')

if (!existsSync(binary) || !existsSync(windowPageModule)) {
  console.error('[probe] missing shell binary or window-page build; run build + build:native first')
  process.exit(2)
}

const { createWindowPage } = await import(pathToFileURL(windowPageModule).href)
const page = createWindowPage({ token: 'probe', locale: 'zh' })

const snapshot = {
  ok: true,
  rev: 1,
  binding: null,
  commanderStatus: 'unbound',
  panel: 'present',
  counts: {},
  workspaces: [],
  tasks: [],
  pendingDispatch: null,
  workSessions: [],
  messages: [],
  commanderBusy: false,
  lastTurnId: null,
  lastEventAt: 0,
  nativeShell: 'running',
}

const requests = []
const stateDir = mkdtempSync(join(tmpdir(), 'dshc-probe-'))
let child
let finished = false

function finish(code, reason) {
  if (finished) return
  finished = true
  try {
    child?.kill('SIGKILL')
  } catch {
    // ignore
  }
  server.close()
  rmSync(stateDir, { recursive: true, force: true })
  console.log(`[probe] ${code === 0 ? 'PASS' : 'FAIL'}: ${reason}`)
  console.log(`[probe] requests: ${requests.join(', ')}`)
  process.exit(code)
}

const server = http.createServer((request, response) => {
  requests.push(request.url)
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const accept = String(request.headers.accept ?? '')
  if (url.pathname === '/commander/window') {
    const html = page.html(request.url ?? '')
    if (html === null) {
      response.statusCode = 404
      response.end('bad token')
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(html)
    return
  }
  if (url.pathname === '/commander/state' && accept.includes('text/event-stream')) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    const timer = setInterval(() => response.write(': heartbeat\n\n'), 5_000)
    request.on('close', () => clearInterval(timer))
    return
  }
  if (url.pathname === '/commander/state') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(snapshot))
    return
  }
  if (url.pathname === '/commander/config') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, ui: { theme: 'follow', entryEnabled: true }, commander: { sessionId: '' } }))
    return
  }
  if (url.pathname === '/commander/health') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, version: 'probe', panel: 'present', binding: 'unbound', nativeShell: 'running' }))
    return
  }
  response.statusCode = 404
  response.end('not found')
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/commander/window?token=probe`
  console.log(`[probe] window url ${url}`)
  child = spawn(binary, [], {
    env: {
      ...process.env,
      DSH_COMMANDER_WINDOW_URL: url,
      DSH_COMMANDER_PARENT_PID: String(process.pid),
      DSH_COMMANDER_STATE_DIR: stateDir,
      DSH_COMMANDER_LOG: '1',
      DSH_COMMANDER_HOTKEY: 'Ctrl+Alt+Space',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        try {
          const frame = JSON.parse(line)
          if (frame.type === 'hello') {
            child.stdin.write(`${JSON.stringify({ type: 'ping', at: Date.now() })}\n`)
          }
          if (frame.type === 'pong') {
            setTimeout(() => {
              const data = requests.some((request) => request.startsWith('/commander/state') || request.startsWith('/commander/config'))
              if (data) {
                child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
                setTimeout(() => finish(0, 'real window bundle executed and hit the data plane'), 500)
              } else {
                finish(1, 'window bundle loaded but store did not request /commander/state or /commander/config')
              }
            }, 6_000)
          }
        } catch {
          // ignore non-json
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text.includes('[commander-shell]')) console.log(`[probe] ${text.slice(0, 300)}`)
  })
  setTimeout(() => finish(1, 'timeout'), 15_000)
})
