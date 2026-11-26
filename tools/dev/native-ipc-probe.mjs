#!/usr/bin/env node
/**
 * 远程页 IPC 探针：启动壳加载一个 loopback 页面，页面检测 window.__TAURI__ 并调用
 * `set_mode({mode:'panel'})`，用 /beacon 回报结果。
 *
 * v0.2（球常驻 + 独立面板窗口）：不再期望球窗口 bounds 变大，而是断言
 *  - 球窗口（role=ball）与面板窗口（panel=1&role=panel）各请求一次窗口页；
 *  - 球窗口的 window/bounds 在所有模式切换中都保持 56×56 且位置不变；
 *  - invoke('panel'/'board'/'panel'/'ball') 全部成功。
 *
 * 用法：node tools/dev/native-ipc-probe.mjs
 * 退出码：0 = IPC 可用且窗口切换成功；1 = 失败；2 = 产物缺失。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../../packages/dsh-commander/', import.meta.url).pathname
const binary = join(root, 'native', 'dist', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, 'dsh-commander-shell')
if (!existsSync(binary)) {
  console.error(`[ipc] missing shell binary: ${binary}`)
  process.exit(2)
}

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  const tauri = typeof window.__TAURI__;
  const core = typeof window.__TAURI__?.core?.invoke;
  fetch('/beacon?tauri=' + encodeURIComponent(tauri) + '&core=' + encodeURIComponent(core)).catch(() => {});
  if (window.__TAURI__?.core?.invoke) {
    const invoke = (mode, label) => window.__TAURI__.core.invoke('set_mode', { mode })
      .then(() => fetch('/beacon?' + label + '=ok').catch(() => {}))
      .catch((error) => fetch('/beacon?' + label + '=' + encodeURIComponent(String(error))).catch(() => {}));
    setTimeout(() => {
      invoke('panel', 'invoke');
      setTimeout(() => {
        invoke('board', 'board');
        setTimeout(() => {
          invoke('panel', 'panel2');
          setTimeout(() => {
            fetch('/beacon?shot=ready').catch(() => {});
            setTimeout(() => invoke('ball', 'collapsed'), 1_500);
          }, 800);
        }, 900);
      }, 900);
    }, 900);
  } else {
    fetch('/beacon?invoke=no-tauri').catch(() => {});
  }
</script></body></html>`

const stateDir = mkdtempSync(join(tmpdir(), 'dshc-ipc-'))
const shotPath = join(root, '..', '..', 'tests', 'artifacts', 'm4', 'ipc-panel-plus-ball.png')
let shotTaken = false
function takeShot() {
  try {
    mkdirSync(join(root, '..', '..', 'tests', 'artifacts', 'm4'), { recursive: true })
    execFileSync('screencapture', ['-x', shotPath])
    console.log(`[ipc] screenshot: ${shotPath}`)
  } catch (error) {
    console.log(`[ipc] screenshot skipped: ${String(error)}`)
  }
}
const beacons = []
const windowUrls = []
let bounds = []
let child
let finished = false

function finish(code, reason) {
  if (finished) return
  finished = true
  try { child?.kill('SIGKILL') } catch {}
  server.close()
  rmSync(stateDir, { recursive: true, force: true })
  console.log(`[ipc] ${code === 0 ? 'PASS' : 'FAIL'}: ${reason}`)
  console.log(`[ipc] beacons: ${beacons.join(' | ') || '(none)'}`)
  console.log(`[ipc] window urls: ${windowUrls.join(' | ') || '(none)'}`)
  console.log(`[ipc] bounds: ${bounds.map((b) => `${b.x},${b.y} ${b.width}x${b.height}`).join(', ') || '(none)'}`)
  process.exit(code)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/commander/window') {
    windowUrls.push(request.url ?? '')
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(page)
    return
  }
  if (url.pathname === '/beacon') {
    beacons.push(request.url ?? '')
    response.statusCode = 204
    response.end()
    return
  }
  response.statusCode = 404
  response.end('no')
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/commander/window?token=ipc`
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
          if (frame.type === 'hello') child.stdin.write(`${JSON.stringify({ type: 'ping', at: Date.now() })}\n`)
          if (frame.type === 'window/bounds') bounds.push(frame)
          if (beacons.some((b) => b.includes('shot=ready')) && shotTaken === false) {
            shotTaken = true
            setTimeout(takeShot, 500)
          }
          if (frame.type === 'pong') {
            setTimeout(() => {
              const beacon = (label) => beacons.some((b) => b.includes(`${label}=ok`))
              const ballPage = windowUrls.some((u) => /[?&]role=ball/.test(u))
              const panelPage = windowUrls.some((u) => /[?&]panel=1/.test(u) && /[?&]role=panel/.test(u))
              // 球窗口常驻：所有 bounds 都必须是球的 56×56，且位置不变。
              const first = bounds[0]
              const ballStable = first !== undefined && bounds.every((b) =>
                b.width === first.width && b.height === first.height
                && Math.abs(b.x - first.x) <= 1 && Math.abs(b.y - first.y) <= 1)
              if (beacon('invoke') && beacon('board') && beacon('panel2') && beacon('collapsed') && ballPage && panelPage && ballStable) {
                child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
                setTimeout(() => finish(0, 'ball stays parked while the panel/board window opens and closes'), 500)
              } else {
                finish(1, `invoke=${beacon('invoke')} board=${beacon('board')} panel2=${beacon('panel2')} collapsed=${beacon('collapsed')} ballPage=${ballPage} panelPage=${panelPage} ballStable=${ballStable}`)
              }
            }, 7_000)
          }
        } catch {}
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text.includes('[commander-shell]')) console.log(`[ipc] ${text.slice(0, 300)}`)
  })
  setTimeout(() => finish(1, 'timeout'), 15_000)
})
