#!/usr/bin/env node
/**
 * 原生壳面板截图：真实 lib/window.js + 假 Host 数据面（含 Markdown 消息），
 * 壳加载后自动 set_mode('panel')，4s 后 screencapture 全屏。
 *
 * 用法：node tools/dev/native-shell-shot.mjs [输出 png]
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('../../packages/dsh-commander/', import.meta.url).pathname
const binary = join(root, 'native', 'dist', `${platform()}-${arch() === 'x64' ? 'x64' : arch()}`, 'dsh-commander-shell')
const windowPageModule = join(root, 'lib', 'host', 'native', 'window-page.js')
if (!existsSync(binary) || !existsSync(windowPageModule)) {
  console.error('[shot] missing shell binary or window-page build')
  process.exit(2)
}
const { createWindowPage } = await import(pathToFileURL(windowPageModule).href)
const page = createWindowPage({ token: 'shot', locale: 'zh' })

const now = Date.now()
const text = [
  '**搜索范围**：以北京时间 2026-11-18 00:00 至 2026-11-19 01:20 为窗口，覆盖国际政治外交、冲突与安全、经济市场、科技产业和重大灾害。',
  '',
  '**派发建议**',
  '- 原因：需要你确认（user_confirm_required）；pMax 92% ≥ 阈值 0.8',
  '- 建议目标：**Research** 工作区 · 新建会话',
  '',
  '**候选目标**',
  '1. Research 工作区 · 新建会话（建议）',
  '2. agent-workspace 工作区 · 新建会话',
  '',
  '> 备注：回复「采用建议」/「自定义」/「取消」。',
  '',
  '```js',
  'const confirmed = true',
  '```',
].join('\n')
const snapshot = {
  ok: true, rev: 1, binding: { workspaceId: 'ws-1', sessionId: 'session-demo-1234' },
  commanderStatus: 'bound', panel: 'present', counts: {},
  workspaces: [
    { id: 'ws-1', name: 'Research', path: '/tmp/research' },
    { id: 'ws-2', name: 'agent-workspace', path: '/tmp/agent-workspace' },
  ],
  tasks: [
    { id: 't1', title: '调研 DSH 升级清单', status: 'proposed', workspaceId: 'ws-1', updatedAt: now },
    { id: 't2', title: '修复登录重试', status: 'running', workspaceId: 'ws-2', updatedAt: now },
    { id: 't3', title: '导出订单字段映射', status: 'review', workspaceId: 'ws-1', updatedAt: now, acceptanceCount: 2 },
    { id: 't4', title: '清理看板残留', status: 'done', workspaceId: 'ws-2', updatedAt: now },
    { id: 't5', title: '阻塞：缺少凭据', status: 'blocked', workspaceId: 'ws-1', updatedAt: now },
  ],
  pendingDispatch: {
    decisionId: 'dec-demo', taskId: 'task-demo',
    taskTitle: '调研钉钉 dsw 能否向群发送消息并 @ 指定成员',
    recommendation: { workspaceId: 'ws-1', workspaceName: 'Research', mode: 'new' },
    candidates: [
      { workspaceId: 'ws-1', workspaceName: 'Research', mode: 'new', pWorkspace: 0.92, pSession: 0.9 },
      { workspaceId: 'ws-2', workspaceName: 'agent-workspace', mode: 'new', pWorkspace: 0.71 },
    ],
    pMax: 0.92, threshold: 0.8, reason: 'user_confirm_required', createdAt: now, expiresAt: now + 1_800_000,
  },
  workSessions: [],
  messages: [{ messageId: 'm1', role: 'assistant', text, at: now, order: 1 }],
  commanderBusy: false, lastTurnId: null, lastEventAt: now,
}

const questionBatch = {
  id: 'q-1',
  at: now,
  questions: [
    {
      id: 'q1', header: '使用场景', multiSelect: true,
      question: '你主要拿这个指挥官做什么？',
      options: [
        { label: '技术调研', description: '库/框架/发布' },
        { label: '信息收集', description: '新闻/市场/动向' },
        { label: '代码任务协调', description: '把开发工作派出去' },
        { label: '环境/工具链维护', description: '本机环境、插件、配置' },
      ],
    },
    { id: 'q2', question: '需要我在每次交付后主动提下一步吗？', options: [{ label: '需要' }, { label: '不需要' }] },
  ],
}

const stateDir = mkdtempSync(join(tmpdir(), 'dshc-shot-'))
const beacons = []
let child
let finished = false
const target = process.argv[2] ?? new URL('../../tests/artifacts/m4/shots/window-panel.png', import.meta.url).pathname

function finish(code, reason) {
  if (finished) return
  finished = true
  try { child?.kill('SIGKILL') } catch {}
  server.close()
  rmSync(stateDir, { recursive: true, force: true })
  console.log(`[shot] ${code === 0 ? 'PASS' : 'FAIL'}: ${reason}`)
  process.exit(code)
}

function write(frame) {
  child?.stdin?.write(`${JSON.stringify(frame)}\n`)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/commander/window') {
    console.log(`[shot] window request ${request.url}`)
    let html
    try {
      html = page.html(request.url ?? '')
    } catch (error) {
      console.log(`[shot] page error ${String(error)}`)
      response.statusCode = 500
      response.end('page error')
      return
    }
    if (html === null) {
      response.statusCode = 404
      response.end('bad token')
      return
    }
    // 球窗口加载后自动展开面板（生产里由点击/热键触发），便于截到「球 + 面板同时存在」。
    // 面板窗口自己也加载同一页面，但它带 role=panel，不再触发。
    const injected = html.replace('<head>', '<head><script>window.addEventListener("error", e => fetch("/beacon?error=" + encodeURIComponent(String(e.message) + " @" + (e.filename||"") + ":" + (e.lineno||0))).catch(() => {}));window.addEventListener("unhandledrejection", e => fetch("/beacon?rejection=" + encodeURIComponent(String(e.reason))).catch(() => {}));try{if(new URL(location.href).searchParams.get("role")==="ball"&&window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke){setTimeout(function(){window.__TAURI__.core.invoke("set_mode",{mode:"panel"}).catch(function(){});},1500);}}catch(_){}</script>')
    response.setHeader('content-type', 'text/html; charset=utf-8')
    console.log(`[shot] html bytes=${Buffer.byteLength(injected, 'utf8')} bodyAt=${injected.indexOf('<body>')} bodyHead=${injected.slice(injected.indexOf('<body>'), injected.indexOf('<body>') + 1400).replace(/\n/g, ' ')}`)
    response.end(injected)
    return
  }
  if (url.pathname === '/commander/state' && String(request.headers.accept ?? '').includes('text/event-stream')) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    response.write(`event: native.question\ndata: ${JSON.stringify(questionBatch)}\n\n`)
    return
  }
  if (url.pathname === '/commander/state') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(snapshot))
    return
  }
  if (url.pathname === '/commander/config') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, ui: { theme: 'follow', entryEnabled: true, nativeShell: true } }))
    return
  }
  if (url.pathname === '/commander/native/approvals') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, approvals: [] }))
    return
  }
  if (url.pathname === '/beacon') {
    beacons.push(request.url ?? '')
    response.statusCode = 204
    response.end()
    return
  }
  if (url.pathname === '/commander/native/questions') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, questions: [] }))
    return
  }
  if (url.pathname === '/commander/session-transcript') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      ok: true,
      sessionId: url.searchParams.get('sessionId') ?? '',
      messages: [
        { role: 'user', text: '去调研一下 DSH 0.2.2-rc5 的升级兼容性。' },
        {
          role: 'assistant',
          text: [
            '调研与检测完成，全部只读。产出在 /Users/lzx/Documents/research/dsh-022-rc5/。',
            '',
            '## 一、本机版本（先纠正一个前提）',
            '',
            '| 对象 | 版本 | 证据 |',
            '| --- | --- | --- |',
            '| Desktop 应用 + 内置 CLI | 0.2.2-rc.3 | PlistBuddy Info.plist |',
            '| app.asar 内 dsh 包 | 0.2.2-rc.3 | package.json |',
            '',
            '## 二、更新内容（逐条出处见 [changes-0.2.2-rc5.md](',
            '/Users/lzx/Documents/research/dsh-022-rc5/docs/changes-0.2.2-rc5.md)）',
            '',
            '- 0.2.2-rc.5（2026-11-18，commit 9c2670d）：模型改用 DeepSeek 服务端搜索，不按次收费；其他模型仍走 Search API，来源：GitHub Release。',
            '- 0.2.2-rc.4（11-17）：优化模型异常响应处理；修复桌面端 LiveShare 无法创建分享。',
            '',
            '## 三、兼容检测结论',
            '',
            '1. 判定规则是 `engines.dsh` 单独决定，否则逐个校验 peer 的 `semver.satisfies`。',
            '2. 硬阻塞 2 个：`@deepseek-ai/dsh-subagent-codex`、`@deepseek-ai/dsh-subagent-claude-code`。',
            '',
            '```text',
            'engines.dsh = >=0.2.0-rc.2 <0.3.0',
            '```',
          ].join('\n'),
        },
      ],
    }))
    return
  }
  response.statusCode = 404
  response.end('no')
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/commander/window?token=shot`
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
          if (frame.type === 'hello') write({ type: 'ping', at: Date.now() })
          if (frame.type === 'pong') {
            setTimeout(() => {
              try {
                const debugPath = join(stateDir, 'startup.json')
                if (existsSync(debugPath)) console.log(`[shot] startup=${readFileSync(debugPath, 'utf8')}`)
                console.log(`[shot] beacons=${beacons.join(' | ') || '(none)'}`)
                execFileSync('screencapture', ['-x', target])
                console.log(`[shot] saved ${target}`)
                write({ type: 'shutdown' })
                setTimeout(() => finish(0, 'screenshot saved'), 600)
              } catch (error) {
                finish(1, `screencapture failed: ${String(error)}`)
              }
            }, 5_500)
          }
        } catch {}
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text.includes('[commander-shell]')) console.log(`[shot] ${text.slice(0, 200)}`)
  })
  setTimeout(() => finish(1, 'timeout'), 20_000)
})
