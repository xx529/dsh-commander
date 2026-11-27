#!/usr/bin/env node
/**
 * Quick-input harness (against the built `lib/window.js`).
 *
 * 锁 v0.6 的「输入框优先」：空闲（phase=hidden）时悬停唤起输入框，气泡窗里必须出现输入框；
 * 输入框收起后再回到气泡/空。这里的回归点是渲染条件曾把 quickOpen 一起挡掉。
 *
 * Requires react/react-dom/jsdom via `DSH_COMMANDER_HARNESS_MODULES` (see README).
 * Usage: node quick.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const windowPath = resolve(here, '../../../lib/window.js')

function depRequire() {
  const modules = process.env.DSH_COMMANDER_HARNESS_MODULES
  if (modules !== undefined && modules !== '') return createRequire(resolve(modules, 'harness-anchor.cjs'))
  return createRequire(fileURLToPath(import.meta.url))
}
const req = depRequire()
let JSDOM
try {
  JSDOM = req('jsdom').JSDOM
} catch (error) {
  console.error(`[quick] missing optional dependency "jsdom": ${error.message}`)
  process.exit(2)
}

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const source = readFileSync(windowPath, 'utf8')
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  runScripts: 'dangerously',
  url: 'http://127.0.0.1:55112/',
  pretendToBeVisual: true,
})
const { window } = dom
window.__COMMANDER_SHELL__ = { token: 'harness', locale: 'zh', role: 'bubble' }

// 空闲快照：没有 busy、没有活动 → 气泡阶段 hidden
const snapshot = {
  ok: true,
  rev: 1,
  binding: { sessionId: 'sess_1', workspaceId: 'ws_1' },
  commanderStatus: 'bound',
  panel: 'absent',
  counts: {},
  workspaces: [],
  tasks: [],
  pendingDispatch: null,
  workSessions: [],
  messages: [],
  commanderBusy: false,
  commanderActivity: null,
  lastTurnId: 2,
  lastEventAt: 0,
  nativeShell: 'running',
  rotation: null,
  formerCommanders: [],
}
window.fetch = async () => ({ ok: true, status: 200, json: async () => snapshot })

class FakeEventSource {
  constructor() { this.readyState = 0; this.listeners = new Map(); window.__eventSource = this }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  close() { this.readyState = 2 }
}
window.EventSource = FakeEventSource

// 假 Tauri：让桥接 available=true，并把事件监听收集起来由用例触发
const listeners = new Map()
const invokes = []
window.__TAURI__ = {
  core: { invoke: async (command, args) => { invokes.push({ command, args }) } },
  window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },
  event: {
    listen: async (name, callback) => { listeners.set(name, callback); return () => {} },
  },
}
// 假 Web Animations：记录每个元素上的动画，用来断言退场动画会被 cancel（fill:forwards 残留会让节点永久透明）
window.Element.prototype.animate = function animate(keyframes, options) {
  const anim = {
    cancelled: false,
    playState: 'running',
    finished: Promise.resolve(),
    cancel() { this.cancelled = true; this.playState = 'cancelled' },
  }
  this.__anims = this.__anims ?? []
  this.__anims.push(anim)
  return anim
}

window.eval(source)

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return true
    await sleep(20)
  }
  return false
}
const doc = window.document
const bar = () => doc.querySelector('.dshcn-quick-bar')
const root = () => doc.querySelector('.dshcn-quick, .dshcn-bubble')
function emitQuick(open) {
  const listener = listeners.get('commander:quick-input')
  if (listener === undefined) throw new Error('commander:quick-input listener missing')
  listener({ payload: open })
}

check('idle bubble page renders nothing before hover', await waitFor(() => root() === null), root()?.className ?? 'null')
check('quick-input listener is wired', await waitFor(() => listeners.has('commander:quick-input')), String(listeners.size))

emitQuick(true)
check('hover opens the quick input while the bubble is idle', await waitFor(() => bar() !== null), root()?.className ?? 'null')
check('quick input takes focus', await waitFor(() => doc.activeElement?.className === 'dshcn-quick-input'), doc.activeElement?.className ?? 'none')
check('bubble content is not rendered beside the quick input', doc.querySelector('.dshcn-bubble-pill') === null)

emitQuick(false)
check('closing the quick input removes it', await waitFor(() => bar() === null), root()?.className ?? 'null')
await sleep(200)
const leftover = [...doc.querySelectorAll('.dshcn-quick, .dshcn-bubble')]
  .flatMap((el) => el.__anims ?? [])
  .filter((anim) => !anim.cancelled)
check('exit animations are cancelled (no forwards residue)', leftover.length === 0, `${leftover.length} left`)
// 关闭由壳发起（commander:quick-input false），Client 只切内容，不再回发 IPC。
check('idle bubble stays empty after the quick input closes', await waitFor(() => root() === null), root()?.className ?? 'null')

window.close()
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
