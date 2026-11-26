#!/usr/bin/env node
/**
 * Native bubble window harness (against the built `lib/window.js`).
 *
 * Loads the real window bundle in jsdom with a fake Tauri boot + Host data
 * plane, then drives `commander.status` frames to lock the v0.5 behaviour:
 *   snapshot activity → SSE activity → long text `...` → null fallback.
 *
 * Requires react/react-dom/jsdom in `DSH_COMMANDER_HARNESS_MODULES` (see README).
 * Usage: node bubble.mjs
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
  console.error(`[bubble] missing optional dependency "jsdom": ${error.message}`)
  console.error('[bubble] install jsdom in a scratch dir and set DSH_COMMANDER_HARNESS_MODULES=<dir>, see README.md')
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
  url: 'http://127.0.0.1:55111/',
  pretendToBeVisual: true,
})
const { window } = dom
window.__COMMANDER_SHELL__ = { token: 'harness', locale: 'zh', role: 'bubble' }

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
  commanderBusy: true,
  commanderActivity: { text: '查看当前目录', at: 1 },
  lastTurnId: 2,
  lastEventAt: 0,
  nativeShell: 'running',
  rotation: null,
  formerCommanders: [],
}
window.fetch = async url => (String(url).includes('/commander/config')
  ? { ok: true, status: 200, json: async () => ({ rev: 1, config: {} }) }
  : { ok: true, status: 200, json: async () => snapshot })

class FakeEventSource {
  constructor() {
    this.readyState = 0
    this.listeners = new Map()
    window.__eventSource = this
  }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  close() { this.readyState = 2 }
}
window.EventSource = FakeEventSource

window.eval(source)

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return true
    await sleep(20)
  }
  return false
}
const text = () => window.document.querySelector('.dshcn-bubble-text')?.textContent ?? null
const phase = () => window.document.querySelector('.dshcn-bubble')?.getAttribute('data-phase') ?? null
function pushStatus(rev, payload) {
  const listener = window.__eventSource?.listeners.get('commander.status')
  if (listener === undefined) throw new Error('commander.status listener missing')
  listener({ data: JSON.stringify({ lastTurnId: 2, rev, ...payload }), lastEventId: String(rev) })
}

check('bubble page loads and shows snapshot activity', await waitFor(() => text() === '查看当前目录'), text())
check('bubble is in working phase', phase() === 'working', phase())

pushStatus(2, { busy: true, activity: { text: 'a'.repeat(50), at: 2 } })
check('SSE activity truncates to 40 chars + ...', await waitFor(() => text() === `${'a'.repeat(40)}...`), text())

pushStatus(3, { busy: true, activity: null })
check('null activity falls back to thinking', await waitFor(() => text() === '正在思考'), text())

pushStatus(4, { busy: true, activity: { text: '运行测试', at: 4 } })
check('SSE activity replaces the bubble text', await waitFor(() => text() === '运行测试'), text())

pushStatus(5, { busy: false, activity: null })
check('turn end switches to the success copy', await waitFor(() => phase() === 'success' && text() === '已完成 · 点击球查看'), `${phase()} / ${text()}`)

window.close()
const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
