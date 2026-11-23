#!/usr/bin/env node
/**
 * 原生壳 smoke：不启动 DSH，用一个最小 loopback HTTP 页面模拟 /commander/window，
 * 验证 Tauri 壳能启动、加载页面、发出 hello、响应 ping、响应 shutdown。
 *
 * 用法：node tools/dev/native-shell-smoke.mjs
 * 需要先 `pnpm --filter dsh-commander build:native` 生成 native/dist/darwin-<arch>/。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'

const packageRoot = new URL('../../packages/dsh-commander/', import.meta.url).pathname
const nodeArch = arch() === 'x64' ? 'x64' : arch()
const binary = join(packageRoot, 'native', 'dist', `${platform()}-${nodeArch}`, 'dsh-commander-shell')

if (!existsSync(binary)) {
  console.error(`[smoke] missing shell binary: ${binary}`)
  console.error('[smoke] run: pnpm --filter dsh-commander build:native')
  process.exit(2)
}

const stateDir = mkdtempSync(join(tmpdir(), 'dshc-shell-'))
let windowRequests = 0
let beaconRequests = 0
const page = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{width:100%;height:100%;margin:0;background:transparent}</style></head>
<body><div id="root" style="display:flex;align-items:center;justify-content:center;font:14px -apple-system;background:#1f63eb;color:#fff;border-radius:50%">OK</div>
<script>window.__COMMANDER_SHELL__ = { token: 'smoke', locale: 'zh', theme: 'follow' };fetch('/beacon').catch(() => {});</script></body></html>`

const server = http.createServer((request, response) => {
  if (request.url?.startsWith('/commander/window')) {
    windowRequests += 1
    console.log(`[smoke] window page request #${windowRequests}`)
    response.statusCode = 200
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(page)
    return
  }
  if (request.url === '/beacon') {
    beaconRequests += 1
    console.log(`[smoke] webview js beacon #${beaconRequests}`)
    response.statusCode = 204
    response.end()
    return
  }
  response.statusCode = 404
  response.end('not found')
})

let child
let finished = false
let shuttingDown = false
const seen = []

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
  console.log(`[smoke] ${code === 0 ? 'PASS' : 'FAIL'}: ${reason}`)
  console.log(`[smoke] frames: ${seen.join(', ')}`)
  process.exit(code)
}

function write(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`)
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/commander/window?token=smoke`
  const env = {
    ...process.env,
    DSH_COMMANDER_WINDOW_URL: url,
    DSH_COMMANDER_PARENT_PID: String(process.pid),
    DSH_COMMANDER_STATE_DIR: stateDir,
    DSH_COMMANDER_LOG: '1',
    DSH_COMMANDER_HOTKEY: 'Ctrl+Alt+Space',
  }
  console.log(`[smoke] spawning ${binary}`)
  console.log(`[smoke] window url ${url}`)
  child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''

  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          console.log(`[smoke] non-json stdout: ${line.slice(0, 200)}`)
          continue
        }
        seen.push(frame.type)
        if (frame.type === 'hello') {
          if (frame.protocol !== 1) finish(1, `protocol=${String(frame.protocol)}`)
          write({
            type: 'ready',
            origin: `http://127.0.0.1:${port}`,
            theme: 'follow',
            locale: 'zh',
            ball: { size: 56 },
            panel: { width: 420, height: 660 },
            entryPos: null,
            hotkey: 'Ctrl+Alt+Space',
          })
          write({ type: 'ping', at: Date.now() })
        }
        if (frame.type === 'pong') {
          if (shuttingDown) continue
          shuttingDown = true
          // WebKit 首次初始化 + 页面导航需要时间，给 5s 再判定是否请求了页面。
          setTimeout(() => {
            if (windowRequests === 0) {
              finish(1, 'shell handshaked but never requested the window page (ATS/WebView?)')
              return
            }
            if (beaconRequests === 0) {
              finish(1, 'window page loaded but WebView JS did not execute')
              return
            }
            write({ type: 'shutdown' })
            setTimeout(() => finish(0, 'hello → ready/ping → window page → pong → shutdown'), 800)
          }, 5000)
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text.length > 0) console.log(`[smoke] stderr: ${text.slice(0, 400)}`)
  })
  child.on('exit', (code, signal) => {
    if (finished) return
    if (shuttingDown) finish(0, `shell exited after shutdown code=${String(code)}`)
    else finish(1, `shell exited early code=${String(code)} signal=${String(signal)}`)
  })

  setTimeout(() => finish(1, 'timeout waiting for hello/pong'), 12_000)
})
