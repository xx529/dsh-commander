#!/usr/bin/env node
/**
 * 球窗键盘焦点探针（回归护栏，契约 `native-shell-contract.md` v0.7「键盘焦点」）。
 *
 * 背景：球窗曾参与键盘焦点 —— 壳 `show()` 时 AppKit 把球窗设为 key，WKWebView 的初始
 * 焦点落到球按钮上，页面此时还没收到指针输入，浏览器按「键盘焦点」处理，于是画出
 * `:focus-visible` 的 2px 蓝环（用户看到的「启动时浮球一圈蓝边」）。修复是球窗
 * `focusable: false`（tao 的 `canBecomeKeyWindow` 直接读它）。
 *
 * 断言（旧二进制上第 1 条必失败）：
 *  1. 球窗页面（role=ball）任何采样都拿不到 document 焦点（`document.hasFocus() === false`）
 *     且球按钮 `:focus` / `:focus-visible` 恒为 false → 不会再画蓝环；
 *  2. 面板打开后（页面 `invoke('set_mode', {mode:'panel'})`）面板窗仍能拿到键盘焦点，
 *     球窗依旧没有焦点 —— 说明 focusable(false) 只作用于球窗，键盘输入照常进面板；
 *  3. 可选：PATH 里有 `cliclick` 时真实点击球心，球页必须收到 click —— 说明
 *     focusable(false) 没破坏指针交互（没有 cliclick 记 SKIP）。
 *
 * 用法：node tools/dev/native-focus-probe.mjs
 * 退出码：0 = PASS；1 = FAIL；2 = 原生壳产物缺失。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../../packages/dsh-commander/', import.meta.url).pathname
const binary = join(root, 'native', 'dist', `${platform()}-${arch() === 'x64' ? 'x64' : arch()}`, 'dsh-commander-shell')
if (!existsSync(binary)) {
  console.error(`[focus] missing shell binary: ${binary}`)
  console.error('[focus] run: pnpm --filter dsh-commander build:native')
  process.exit(2)
}

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body,#root{width:100%;height:100%;margin:0;padding:0;background:transparent;overflow:hidden}
#ball{position:absolute;inset:8px;width:calc(100% - 16px);height:calc(100% - 16px);border:0;border-radius:50%;
  background:radial-gradient(circle at 30% 25%,#9ec7ff,#1f63eb 60%,#0b1a33);padding:0}
/* 与 src/client/window-styles.ts 的球焦点环同一条规则 */
#ball:focus-visible{outline:2px solid #4f8bff;outline-offset:1px}
</style></head><body><div id="root"></div>
<script>
  var role = new URLSearchParams(location.search).get('role') || 'none';
  window.__COMMANDER_SHELL__ = { token: 'focus', locale: 'zh', theme: 'follow', role: role, panel: false };
  var target = null;
  if (role === 'ball') {
    target = document.createElement('button');
    target.id = 'ball';
    target.type = 'button';
    target.className = 'dshcn-ball';
    document.getElementById('root').appendChild(target);
    target.addEventListener('click', function () { snap('ball-click'); });
  } else if (role === 'panel') {
    target = document.createElement('textarea');
    target.id = 'panel-input';
    document.getElementById('root').appendChild(target);
  }
  function snap(tag) {
    var cs = target ? getComputedStyle(target) : null;
    fetch('/beacon?m=' + encodeURIComponent(JSON.stringify({
      role: role, tag: tag, t: Math.round(performance.now()),
      doc: document.hasFocus(),
      active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
      f: target ? target.matches(':focus') : null,
      fv: target ? target.matches(':focus-visible') : null,
      outline: cs ? (cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineOffset) : null
    }))).catch(function () {});
  }
  [200, 700, 1200, 2000, 2600, 3200].forEach(function (ms) { setTimeout(function () { snap('t' + ms); }, ms); });
  window.addEventListener('focus', function () { snap('win-focus'); });
  window.addEventListener('blur', function () { snap('win-blur'); });
  if (role === 'ball') {
    // 400ms 打开面板（真实球点一下也是走这条 invoke）；2200ms 收起。
    setTimeout(function () {
      window.__TAURI__.core.invoke('set_mode', { mode: 'panel' })
        .then(function () { snap('mode-panel-ok'); })
        .catch(function (error) { snap('mode-panel-error:' + error); });
    }, 400);
    setTimeout(function () {
      window.__TAURI__.core.invoke('set_mode', { mode: 'ball' }).catch(function () {});
    }, 2200);
  }
</script></body></html>`

const stateDir = mkdtempSync(join(tmpdir(), 'dshc-focus-'))
const beacons = []
let bounds = null
let child
let finished = false
let shuttingDown = false

function finish(code, reason) {
  if (finished) return
  finished = true
  try { child?.kill('SIGKILL') } catch {}
  server.close()
  rmSync(stateDir, { recursive: true, force: true })
  console.log(`[focus] ${code === 0 ? 'PASS' : 'FAIL'}: ${reason}`)
  process.exit(code)
}

function write(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`) }

function samples(role) { return beacons.filter((item) => item.role === role) }
function pick(role, tag) { return samples(role).find((item) => item.tag === tag) }

const server = http.createServer((request, response) => {
  if (request.url?.startsWith('/commander/window')) {
    response.statusCode = 200
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(page)
    return
  }
  if (request.url?.startsWith('/beacon')) {
    const url = new URL(request.url, 'http://127.0.0.1')
    try {
      const item = JSON.parse(url.searchParams.get('m') ?? '{}')
      if (typeof item.role === 'string') beacons.push(item)
    } catch {
      // ignore malformed
    }
    response.statusCode = 204
    response.end()
    return
  }
  response.statusCode = 404
  response.end('not found')
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/commander/window?token=focus`
  child = spawn(binary, [], {
    env: {
      ...process.env,
      DSH_COMMANDER_WINDOW_URL: url,
      DSH_COMMANDER_PARENT_PID: String(process.pid),
      DSH_COMMANDER_STATE_DIR: stateDir,
      DSH_COMMANDER_LOG: '1',
      DSH_COMMANDER_HOTKEY: 'Ctrl+Alt+F12',
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
            write({
              type: 'ready',
              origin: `http://127.0.0.1:${port}`,
              theme: 'follow',
              locale: 'zh',
              ball: { size: 56 },
              panel: { width: 420, height: 660 },
              entryPos: null,
              hotkey: 'Ctrl+Alt+F12',
            })
          }
          if (frame.type === 'window/bounds') bounds = frame
        } catch {
          // ignore non-json
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text.length > 0) console.log(`[focus] shell stderr: ${text.slice(0, 240)}`)
  })
  child.on('exit', (code, signal) => {
    // shutdown 之后的正常退出由 verify 的收尾负责，不算「提前退出」。
    if (shuttingDown) return
    if (!finished) finish(1, `shell exited early code=${String(code)} signal=${String(signal)}`)
  })

  // 等壳把三个窗口都拉起来并跑完采样；可选的真实点击放在面板收起之后。
  setTimeout(() => {
    const clicker = spawnSync('which', ['cliclick'], { encoding: 'utf8' })
    const hasCliclick = clicker.status === 0 && String(clicker.stdout).trim().length > 0
    if (!hasCliclick || bounds === null) {
      verify('no-click')
      return
    }
    const scale = typeof bounds.scale === 'number' && bounds.scale > 0 ? bounds.scale : 1
    const x = Math.round((bounds.x + bounds.width / 2) / scale)
    const y = Math.round((bounds.y + bounds.height / 2) / scale)
    const before = samples('ball').length
    spawnSync('cliclick', [`m:${x},${y}`, `c:${x},${y}`], { encoding: 'utf8' })
    setTimeout(() => {
      const clicked = samples('ball').slice(before).some((item) => item.tag === 'ball-click')
      verify(clicked ? 'click-ok' : 'click-miss')
    }, 700)
  }, 3800)

  function verify(clickState) {
    const ballSamples = samples('ball')
    const panelSamples = samples('panel')
    if (ballSamples.length === 0) return finish(1, 'ball window page never reported a beacon')
    const focusedBall = ballSamples.filter((item) => item.doc === true || item.f === true || item.fv === true)
    if (focusedBall.length > 0) {
      const sample = focusedBall[0]
      return finish(1, `ball window took keyboard focus (${sample.tag}: doc=${String(sample.doc)} f=${String(sample.f)} fv=${String(sample.fv)})`)
    }
    const ringed = ballSamples.filter((item) => typeof item.outline === 'string' && item.outline.startsWith('solid'))
    if (ringed.length > 0) return finish(1, `ball painted an outline (${ringed[0].tag}: ${ringed[0].outline})`)
    if (panelSamples.length === 0) return finish(1, 'panel window page never reported a beacon')
    const panelFocused = panelSamples.some((item) => item.doc === true)
    if (!panelFocused) return finish(1, 'panel window never received keyboard focus after set_mode(panel)')
    if (clickState === 'click-miss') return finish(1, 'ball window did not receive the real click (pointer interaction broken)')
    console.log(`[focus] ball samples: ${ballSamples.map((item) => `${item.tag}(doc=${String(item.doc)},fv=${String(item.fv)})`).join(' ')}`)
    console.log(`[focus] panel samples: ${panelSamples.map((item) => `${item.tag}(doc=${String(item.doc)})`).join(' ')}`)
    shuttingDown = true
    write({ type: 'shutdown' })
    setTimeout(() => finish(0, `ball never focused; panel focus OK; click=${clickState}`), 500)
  }
})
