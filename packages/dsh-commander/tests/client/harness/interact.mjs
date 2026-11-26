#!/usr/bin/env node
/**
 * Interactive client bundle harness: mounts the overlay entry in jsdom with a
 * fake store, then drives the real click → open → type → Enter → send → close
 * flow, and mounts the settings section to exercise config load + save wiring.
 * This is the M0-1/M0-2 client-side evidence that does not need live DSH.
 *
 * Usage: node interact.mjs [path-to-lib/client.js]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DICTIONARIES } from '../../../src/client/locales.ts'

/** Production zh translator (catches missing dictionary keys instead of echoing them). */
const zhT = key => DICTIONARIES.zh[key] ?? key
/** Any surviving raw i18n key literal in rendered text. */
const RAW_KEY_LITERAL = /\b(?:board|approval|system|badge)\.[a-z][a-zA-Z0-9.]*/
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Resolve react/react-dom/jsdom from devDeps or DSH_COMMANDER_HARNESS_MODULES (see README.md). */
function depRequire() {
  const modules = process.env.DSH_COMMANDER_HARNESS_MODULES
  if (modules !== undefined && modules !== '') return createRequire(resolve(modules, 'harness-anchor.cjs'))
  return createRequire(fileURLToPath(import.meta.url))
}
const req = depRequire()
function load(name) {
  try {
    return req(name)
  } catch (error) {
    console.error(`[interact] missing optional dependency "${name}": ${error.message}`)
    console.error('[interact] install react/react-dom/jsdom in a scratch dir and set DSH_COMMANDER_HARNESS_MODULES=<dir>, see README.md')
    process.exit(2)
  }
}

const { JSDOM } = load('jsdom')

// jsdom globals MUST exist before react-dom is loaded: its input-event support
// detection runs at module init, and a missing `document` silently selects the
// legacy attachEvent path (clicks still work, onChange never fires).
const clientPath = process.argv[2] ?? resolve(here, '../../../lib/client.js')
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { globalThis.navigator = window.navigator } catch { /* Node exposes a read-only navigator */ }
for (const key of ['Node', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent']) {
  if (window[key] !== undefined) globalThis[key] = window[key]
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = load('react')
const { createRoot } = load('react-dom/client')
const { act } = React

// React 19's legacy input-event polyfill is unreachable in jsdom without the
// old-IE attachEvent/detachEvent pair; stub it so input events take the normal path.
if (typeof window.HTMLElement.prototype.attachEvent !== 'function') window.HTMLElement.prototype.attachEvent = () => {}
if (typeof window.HTMLElement.prototype.detachEvent !== 'function') window.HTMLElement.prototype.detachEvent = () => {}
window.document.attachEvent = () => {}
window.document.detachEvent = () => {}

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---- load bundle ----------------------------------------------------------
let loaded = null
window.__ModuleLoader__ = { load(options) { loaded = options } }
// eslint-disable-next-line no-new-func
new Function('window', readFileSync(clientPath, 'utf8'))(window)
check('bundle registers module', loaded?.id === 'dsh-commander')

const jsxRuntime = load('react/jsx-runtime')
const primitivesStub = {
  MarkdownText: ({ text }) => React.createElement('div', { className: 'markdown' }, text),
}
const moduleExports = loaded.factory(id => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected require: ${id}`)
})

// ---- fake context + fake store -------------------------------------------
const registrations = []
const effectDisposers = []
const selectedPanels = []
const openedSessions = []
/** Entry positions persisted by the fake store (free-drag test). */
const savedEntryPositions = []
const layout = { selectPanel(panelId) { selectedPanels.push(panelId) } }
const uiWorkspace = { openSession(sessionId) { openedSessions.push(sessionId) } }
const approvalAnswers = []
let sessionStatusMap = new Map()
const sessionStatusListeners = new Set()
const sessionStatusSource = {
  getSnapshot: () => sessionStatusMap,
  subscribe: (listener) => { sessionStatusListeners.add(listener); return () => { sessionStatusListeners.delete(listener) } },
}
function setSessionStatuses(map) {
  sessionStatusMap = map
  for (const listener of sessionStatusListeners) listener()
}
const uiSession = { sessionStatus: sessionStatusSource }
const ctx = {
  slots: {
    inject(name, register) { return register() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
  effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effectDisposers.push(dispose); return dispose },
  get(name) {
    if (name === 'layout') return layout
    if (name === 'uiWorkspace') return uiWorkspace
    if (name === 'uiSession') return uiSession
    return undefined
  },
  layout,
  uiWorkspace,
  uiSession,
}
moduleExports.apply(ctx)
const overlay = registrations.find(entry => entry.options.name === 'shell.overlay')
const settings = registrations.find(entry => entry.options.name === 'settings.section')
const board = registrations.find(entry => entry.options.name === 'main')
const t = key => key

function baseView() {
  return {
    rev: 1,
    connection: 'live',
    binding: { sessionId: 'sess_1', workspaceId: 'ws_1', workspacePath: '/tmp/htdot', model: { provider: 'tokfans', model: 'deepseek-flash' } },
    commanderStatus: 'bound',
    panel: 'present',
    counts: {},
    workspaces: [{ id: 'ws_1', name: 'HtDot', path: '/tmp/htdot', allowed: true, summary: '电商后台', policy: 'inherit' }],
    tasks: [],
    pendingDispatch: null,
    messages: [
      { id: 'req_1', role: 'user', text: '给订单导出加个开关', at: 1_760_000_000_000, order: 1 },
      { id: 'asst_1_2', role: 'assistant', text: '收到，稍后开始。', at: 1_760_000_001_000, order: 2 },
    ],
    busy: false,
    lastTurnId: 2,
    lastEventAt: 1_760_000_001_000,
    ui: { theme: 'follow', entryPosition: 'br' },
    sending: false,
    notice: null,
    config: null,
    configLoaded: true,
  }
}

function makeStore() {
  let view = baseView()
  const listeners = new Set()
  const sent = []
  let bindResult = { ok: true, data: {} }
  let sessionsResult = {
    ok: true,
    data: {
      truncated: false,
      sessions: [
        { sessionId: 'sess_9', title: '订单导出旧会话', lastActiveAt: Date.now() - 2 * 60_000, contextPct: 62, model: 'deepseek-flash', createdAt: 1_760_000_000_000 },
        { sessionId: 'sess_10', title: '结算页会话', lastActiveAt: 1_759_900_000_000, contextPct: 35 },
        { sessionId: 'session-unnamed-4ac7fcd', title: '', lastActiveAt: 0, createdAt: 1_760_000_100_000 },
      ],
    },
  }
  const archiveQueries = []
  return {
    sent,
    archiveQueries,
    getSessionsResult() { return sessionsResult },
    setSessionsResult(next) { sessionsResult = next },
    setBindResult(next) { bindResult = next },
    listSessions: async (workspaceId) => { sent.push({ listSessions: workspaceId }); return sessionsResult },
    getSnapshot: () => view,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    notify(next) { view = { ...view, ...next }; for (const listener of listeners) listener() },
    start() {}, dispose() {}, refresh: async () => {},
    send: async (text) => { sent.push(text); return { ok: true, messageId: 'req_next' } },
    saveConfig: async () => ({ ok: true, data: {} }),
    saveWorkspaces: async (rows) => { sent.push({ workspaces: rows.length }); return { ok: true, data: [] } },
    testJev: async (options) => {
      sent.push({ jevTest: options ?? {} })
      return { ok: true, data: { ok: true, latencyMs: 123, model: 'jev-latest' } }
    },
    patchBoardTask: async (taskId, patch) => {
      sent.push({ boardPatch: { taskId, patch } })
      return { ok: true, data: { task: { id: taskId, status: patch.field === 'status' ? patch.value : undefined } } }
    },
    archiveTask: async (taskId) => { sent.push({ archive: taskId }); return { ok: true, data: { id: taskId, status: 'archived' } } },
    cancelTask: async (taskId) => { sent.push({ cancel: taskId }); return { ok: true, data: { id: taskId, status: 'cancelled' } } },
    restoreTask: async (taskId) => { sent.push({ restore: taskId }); return { ok: true, data: { id: taskId, status: 'draft' } } },
    acceptTask: async (taskId) => { sent.push({ accept: taskId }); return { ok: true, data: { id: taskId, status: 'done' } } },
    reworkTask: async (taskId, comment) => { sent.push({ rework: taskId, comment }); return { ok: true, data: { id: taskId, status: 'running' } } },
    loadArchive: async (query = {}) => {
      archiveQueries.push(query)
      const tasks = [
        { id: 'tr_1', title: '已归档任务', status: 'archived', workspaceId: 'ws_1', updatedAt: Date.now() - 86_400_000, round: 2 },
        { id: 'tr_2', title: '已取消任务', status: 'cancelled', workspaceId: 'ws_1', updatedAt: Date.now() - 2 * 86_400_000, round: 1 },
      ]
      return { ok: true, data: {
        tasks,
        nextCursor: null,
        total: tasks.length,
        summary: { archivedCount: 1, cancelledCount: 1, last30dCount: 2 },
        months: [{ key: new Date(tasks[0].updatedAt).toISOString().slice(0, 7), count: 2 }],
      } }
    },
    getTaskDetail: async (taskId) => ({ ok: true, data: {
      task: { ...(view.tasks ?? []).find(row => row.id === taskId) ?? { id: taskId }, primarySessionId: 'sess_1', priority: 'normal' },
      acceptance: [{ id: 'acc_1', text: '导出按钮可见', state: 'evidence_present', evidence: '截图' }],
      reportSummary: { text: '本轮完成导出修复，测试通过；边界用例待补。平台 changelog 最新月份条目为 2026 年 10 月，无 11 月条目；在架模型仅 kimi-k3.1-pro、kimi-k3.1-pro-highspeed、kimi-k3 三个；HF moonshotai 20 个仓库最新 Kimi-K3.1-Pro（createdAt 11-02，lastModified 11-05）。', at: 2 },
      reportMaterials: [
        { id: 'mat_img', kind: 'image', title: '配置截图', path: '/tmp/shot.png', imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', source: 'presented', state: 'ok', acceptanceIds: ['acc_1'], meta: { bytes: 1024 } },
        { id: 'mat_link', kind: 'link', title: '官方发布记录', url: 'https://docs.z.ai/release-notes', source: 'commander', state: 'unverified' },
        { id: 'mat_file', kind: 'file', title: '兼容性评估.pdf', path: '/tmp/report.pdf', source: 'presented', state: 'ok', meta: { bytes: 2048 } },
      ],
      capabilities: { status: 'applied', enabled: ['a'], disabled: [] },
      dispatch: { id: 'dec_1', outcome: 'confirmed', finalTarget: { workspaceId: 'ws_1', mode: 'new' }, candidates: [{}] },
      timeline: [{ at: 1, type: 'dispatch', text: '派发' }, { at: 2, type: 'status', text: '运行中' }],
      sessions: [{ sessionId: 'sess_1', workspaceName: 'HtDot', sessionTitle: '订单导出改造', status: 'running', role: 'work' }],
      boardEdits: [{ editId: 'edit_1', field: 'status', before: 'review', after: 'blocked', at: 5 }],
    } }),
    bind: async (request) => { sent.push({ bind: request }); return bindResult },
    loadConfig: async () => {},
    clearNotice() {},
    setEntryPosition() {},
    saveEntryPos: async (position) => {
      savedEntryPositions.push(position)
      // Mirror the real store: optimistic ui.entryPos drives the ball position.
      view = { ...view, ui: { ...view.ui, entryPos: position } }
      for (const listener of listeners) listener()
    },
  }
}

// ---- mount overlay into jsdom --------------------------------------------
const store = makeStore()
const container = document.getElementById('root')
const root = createRoot(container)

await act(async () => {
  root.render(React.createElement(overlay.component, { ...overlay.options.inject(), store, t }))
})

check('ball rendered', container.querySelector('.dshc-ball') !== null)
check('ball uses the single-signal entry markup (label, no status dot)',
  container.querySelector('.dshc-ball-label')?.textContent?.includes('panel.title') === true
    && container.querySelector('.dshc-ball-dot') === null,
  container.querySelector('.dshc-ball-label')?.textContent)
check('panel closed initially', container.querySelector('.dshc-panel') === null)
check('injected style present', container.querySelector('style')?.textContent?.includes('--dsw-alias-brand-primary') === true)
check('floating entry opts out of Electron window drag regions',
  container.querySelector('style')?.textContent?.includes('.dshc-ball, .dshc-panel { -webkit-app-region: no-drag') === true,
  'no-drag rule missing')

// Free drag: the ball is positioned by inline left/top (no fixed corner) and
// persists a normalized center after the pointer is released.
const ballNode = container.querySelector('.dshc-ball')
check('ball uses a free inline position (not a corner preset)',
  ballNode.getAttribute('data-position') === null && ballNode.style.left !== '' && ballNode.style.top !== '',
  JSON.stringify({ position: ballNode.getAttribute('data-position'), left: ballNode.style.left, top: ballNode.style.top }))
const pointerEvent = (type, x, y) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 })
  return event
}
const startLeft = Number.parseInt(ballNode.style.left, 10)
const startTop = Number.parseInt(ballNode.style.top, 10)
await act(async () => { ballNode.dispatchEvent(pointerEvent('pointerdown', 100, 100)) })
await act(async () => { ballNode.dispatchEvent(pointerEvent('pointermove', 160, 40)) })
await act(async () => { ballNode.dispatchEvent(pointerEvent('pointerup', 160, 40)) })
check('dragging the ball persists a normalized center position',
  savedEntryPositions.length === 1
    && typeof savedEntryPositions[0].x === 'number' && savedEntryPositions[0].x > 0 && savedEntryPositions[0].x < 1
    && typeof savedEntryPositions[0].y === 'number' && savedEntryPositions[0].y > 0 && savedEntryPositions[0].y < 1,
  JSON.stringify(savedEntryPositions))
check('dragged ball moved on screen',
  Number.parseInt(ballNode.style.left, 10) !== startLeft || Number.parseInt(ballNode.style.top, 10) !== startTop,
  JSON.stringify({ before: { startLeft, startTop }, after: { left: ballNode.style.left, top: ballNode.style.top } }))
check('dragging does not toggle the panel', container.querySelector('.dshc-panel') === null)
// A real browser still fires click after pointerup: the overlay must swallow that one.
await act(async () => { ballNode.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('click following a drag is swallowed', container.querySelector('.dshc-panel') === null)

// entryEnabled=false hides the whole overlay (per-profile setting, default on).
const hiddenStore = makeStore()
hiddenStore.notify({ ui: { theme: 'follow', entryPosition: 'br', entryEnabled: false } })
const hiddenContainer = document.createElement('div')
const hiddenRoot = createRoot(hiddenContainer)
await act(async () => {
  hiddenRoot.render(React.createElement(overlay.component, { ...overlay.options.inject(), store: hiddenStore, t }))
})
check('entry disabled hides the ball entirely', hiddenContainer.querySelector('.dshc-ball') === null)

await act(async () => {
  container.querySelector('.dshc-ball').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
const panel = container.querySelector('.dshc-panel')
check('click opens panel', panel !== null)
check('panel anchors to the ball with an inline position',
  panel !== null && panel.style.left !== '' && panel.style.top !== '' && panel.getAttribute('data-position') === null,
  JSON.stringify({ left: panel?.style.left, top: panel?.style.top }))
check('panel header title', panel?.querySelector('.dshc-panel-title')?.textContent === 'panel.title', panel?.querySelector('.dshc-panel-title')?.textContent)
const boardButton = panel?.querySelectorAll('.dshc-icon-button')[0]
check('panel board button enabled (layout available)', boardButton?.disabled === false)
await act(async () => { boardButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('panel board button switches main panel', selectedPanels.includes('commander-board'), JSON.stringify(selectedPanels))
check('transcript renders host messages', panel?.textContent?.includes('收到，稍后开始。') === true)
check('assistant reply renders through MarkdownText', panel?.querySelector('.dshc-bubble--markdown .markdown')?.textContent === '收到，稍后开始。', panel?.querySelector('.dshc-bubble--markdown')?.textContent)
check('user message stays plain text', panel?.querySelector('.dshc-msg[data-role="user"] .dshc-bubble--markdown') === null)
check('composer present', panel?.querySelector('textarea.dshc-input') !== null)

// M3: approval floating card reads uiSession.sessionStatus (same instance as official UI).
store.notify({
  tasks: [{ id: 'task_1', title: '导出任务', status: 'running', workspaceId: 'ws_1' }],
  workSessions: [{ sessionId: 'sess_1', taskId: 'task_1', title: '导出会话' }],
})
const approvalInstance = {
  kind: 'approval',
  key: 'approval:1',
  sessionId: 'sess_1',
  toolName: 'bash',
  reason: 'rm -rf build 需要确认',
  answerable: true,
  answer: async (outcome) => { approvalAnswers.push(outcome) },
}
await act(async () => { setSessionStatuses(new Map([['sess_1', { pendingInteraction: approvalInstance }]])) })
const ballBadge = container.querySelector('.dshc-ball-badge')
check('ball badge derives the approval count',
  ballBadge?.getAttribute('data-kind') === 'approval' && ballBadge?.textContent === '1',
  `${String(ballBadge?.getAttribute('data-kind'))}/${String(ballBadge?.textContent)}`)
check('C keeps the sheet closed and exposes a pending FAB', panel.querySelector('.dshc-sheet') === null && panel.querySelector('.dshc-pending-fab') !== null)
const fab = panel.querySelector('.dshc-pending-fab')
await act(async () => { fab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const approvalCard = panel.querySelector('.dshc-approval-card')
check('pending FAB opens the action sheet', panel.querySelector('.dshc-sheet') !== null && approvalCard !== null)
check('approval card is outside the transcript', panel.querySelector('.dshc-panel-body .dshc-approval-card') === null)
check('approval card drops the disabled always-allow button', findButton(approvalCard, 'approval.always') === undefined)
check('approval card marks UI-only handling', approvalCard?.textContent?.includes('approval.onlyUi') === true)
check('approval card shows task/session/tool',
  approvalCard?.textContent?.includes('导出任务') === true
  && approvalCard?.textContent?.includes('导出会话') === true
  && approvalCard?.textContent?.includes('bash') === true)
check('sheet footer keeps approvals out of commander context', panel.querySelector('.dshc-sheet-foot')?.textContent?.includes('panel.sheet.footer') === true)
await act(async () => { findButton(approvalCard, 'approval.allow').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('approval allow answers the official instance', approvalAnswers[0] === 'allowed-once', JSON.stringify(approvalAnswers))
check('answered approval card disappears', panel.querySelector('.dshc-approval-card') === null)

// A non-answerable request must not call answer(); the card is dropped silently.
await act(async () => {
  setSessionStatuses(new Map([['sess_1', { pendingInteraction: { ...approvalInstance, key: 'approval:2', answerable: false } }]]))
})
if (panel.querySelector('.dshc-sheet') === null) {
  const nextFab = panel.querySelector('.dshc-pending-fab')
  if (nextFab !== null) await act(async () => { nextFab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
}
const guardCard = panel.querySelector('.dshc-approval-card')
check('non-answerable approval still renders', guardCard !== null)
const guardReject = findButton(guardCard, 'approval.reject')
check('non-answerable approval disables its actions', guardReject?.disabled === true)
await act(async () => { guardReject.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('non-answerable approval does not call answer()', approvalAnswers.length === 1, JSON.stringify(approvalAnswers))
check('non-answerable card waits for the request to end', panel.querySelector('.dshc-approval-card') !== null)
await act(async () => { setSessionStatuses(new Map()) })
await act(async () => {})
check('approval card disappears when the request ends', panel.querySelector('.dshc-approval-card') === null)

// ask_user_question: the panel answers through the same pending question instance
// (kind='question' in the uiSession projection), not a second answerer.
const questionAnswers = []
const questionInstance = {
  kind: 'question',
  key: 'question:sess_1:call_1',
  sessionId: 'sess_1',
  callId: 'call_1',
  questions: [{
    id: 'q1',
    question: '这一轮你想让我做什么？',
    options: [{ label: '派发新的调研任务' }, { label: '跟进 DSH 升级' }],
    multiSelect: false,
  }],
  answer: async (answer) => { questionAnswers.push(answer) },
}
await act(async () => { setSessionStatuses(new Map([['sess_1', { pendingInteraction: questionInstance }]])) })
await act(async () => {})
const questionCard = panel.querySelector('.dshc-question-card')
check('question card renders the pending ask_user_question', questionCard !== null,
  String(panel.querySelector('.dshc-sheet')?.textContent?.slice(0, 200)))
check('question card shows the question text', questionCard?.textContent?.includes('这一轮你想让我做什么？') === true)
check('question submit is disabled until answered',
  findButton(questionCard, 'question.submit')?.disabled === true)
const firstOption = questionCard.querySelectorAll('.dshc-question-option')[0]
await act(async () => { firstOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('clicking an option selects it', firstOption.getAttribute('data-selected') === 'true')
await act(async () => { findButton(questionCard, 'question.submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('submit answers through the official pending question instance',
  questionAnswers.length === 1
    && questionAnswers[0].answers[0].id === 'q1'
    && questionAnswers[0].answers[0].selected[0] === '派发新的调研任务',
  JSON.stringify(questionAnswers))
await act(async () => { setSessionStatuses(new Map()) })
await act(async () => {})
check('question card disappears when the request ends', panel.querySelector('.dshc-question-card') === null)

// C: status bar opens the binding/task/connection popover; no cards in chat.
const statusBar = panel.querySelector('.dshc-statusbar')
check('status bar renders binding and task context', statusBar?.textContent?.includes('panel.title') === false && statusBar?.textContent?.includes('sess_1') === true)
await act(async () => { statusBar.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('status bar opens the command status popover', panel.querySelector('.dshc-status-pop') !== null)
check('status popover exposes binding + connection', panel.querySelector('.dshc-status-pop')?.textContent?.includes('panel.binding.workspace') === true && panel.querySelector('.dshc-status-pop')?.textContent?.includes('conn.live') === true)
check('transcript has no action cards', panel.querySelectorAll('.dshc-panel-body .dshc-card-dispatch, .dshc-panel-body .dshc-approval-card').length === 0)
await act(async () => { panel.querySelector('.dshc-status-scrim').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('status popover closes via its scrim', panel.querySelector('.dshc-status-pop') === null)

const textarea = panel.querySelector('textarea.dshc-input')
function findButton(root, label) {
  return [...root.querySelectorAll('button')].find(button => button.textContent === label)
}

function setSelectValue(node, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new window.Event('change', { bubbles: true }))
}

function setTextareaValue(node, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new window.Event('input', { bubbles: true }))
}

await act(async () => { setTextareaValue(textarea, '你好指挥官') })
const sendButton = [...panel.querySelectorAll('button')].find(button => button.textContent === 'panel.send')
check('send button enabled after typing', sendButton !== undefined && !sendButton.disabled)

await act(async () => { sendButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('click send posts text', store.sent[0] === '你好指挥官', JSON.stringify(store.sent))
check('composer cleared after send', panel.querySelector('textarea.dshc-input').value === '')

await act(async () => { setTextareaValue(textarea, 'Enter 发送') })
await act(async () => {
  textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
check('Enter sends message', store.sent[1] === 'Enter 发送', JSON.stringify(store.sent))

await act(async () => { setTextareaValue(textarea, '换行不进消息') })
await act(async () => {
  textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
})
check('Shift+Enter does not send', store.sent.length === 2, String(store.sent.length))

const before = store.sent.length
await act(async () => { store.notify({ messages: [...baseView().messages, { id: 'asst_2_5', role: 'assistant', text: '补充一条回复', at: 1_760_000_002_000, order: 3 }] }) })
check('viewport picks up new assistant message', container.textContent.includes('补充一条回复'), `sent=${before}`)

await act(async () => {
  store.notify({
    messages: [
      ...baseView().messages,
      {
        id: 'decision_msg',
        role: 'user',
        text: '[dispatch-confirm] 采用建议\ndecisionId=dec_record\ntaskId=task_record\ntarget=workspaceId:ws_1;mode:new',
        at: 1_760_000_003_000,
        order: 4,
      },
    ],
  })
})
const decision = container.querySelector('.dshc-decision')
check('dispatch protocol messages render as a collapsed decision record',
  decision !== null && decision.hasAttribute('open') === false && decision.textContent.includes('decision.title') === true)
check('raw protocol text stays out of plain user bubbles',
  [...container.querySelectorAll('.dshc-msg[data-role="user"] .dshc-bubble')].every(bubble => !bubble.textContent.includes('decisionId=')))
await act(async () => {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
check('Escape closes panel', container.querySelector('.dshc-panel') === null)

// ---- M1 dispatch confirmation card --------------------------------------
// The composer tests above already recorded two sends; card messages append.
const sentBeforeDispatch = store.sent.length
function pendingDecision(overrides = {}) {
  return {
    decisionId: 'dec_1',
    taskId: 'task_1',
    taskTitle: '给订单导出加开关',
    recommendation: { workspaceId: 'ws_1', mode: 'new' },
    candidates: [
      { workspaceId: 'ws_1', workspaceName: 'HtDot', mode: 'new', pWorkspace: 0.62, pSession: 0.71, score: 0.44 },
      { workspaceId: 'ws_1', mode: 'attach', sessionId: 'sess_9', sessionTitle: '订单导出旧会话', pWorkspace: 0.31 },
    ],
    scores: { pWorkspace: 0.62, pSession: 0.71, pMax: 0.62, concentration: 0.43 },
    reason: 'user_confirm_required',
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    ...overrides,
  }
}

await act(async () => { store.notify({ pendingDispatch: pendingDecision() }) })
check('new pending decision auto-opens panel', container.querySelector('.dshc-panel') !== null)
let card = container.querySelector('.dshc-card-dispatch')
check('confirm card renders', card !== null)
check('card shows task title', card?.textContent?.includes('给订单导出加开关') === true)
check('card shows recommendation workspace + pMax', card?.textContent?.includes('HtDot') === true && card?.textContent?.includes('62%') === true)
check('card shows candidate rows (<=3)', card?.querySelectorAll('.dshc-candidate').length === 2, String(card?.querySelectorAll('.dshc-candidate').length))
check('sheet card folds candidates behind a closed disclosure',
  card?.querySelector('.dshc-candidates-details') !== null
    && card?.querySelector('.dshc-candidates-details')?.hasAttribute('open') === false)
check('card shows every-dispatch-needs-confirmation tag', card?.textContent?.includes('dispatch.onlyConfirm') === true)
check('card shows reason line', card?.textContent?.includes('dispatch.reason.userConfirm') === true)

await act(async () => { findButton(card, 'dispatch.adopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
const adoptText = store.sent[sentBeforeDispatch]
check('adopt sends the contract message', typeof adoptText === 'string'
  && adoptText.startsWith('[dispatch-confirm] 采用建议')
  && adoptText.includes('decisionId=dec_1')
  && adoptText.includes('target=workspaceId:ws_1;mode:new'), JSON.stringify(adoptText))
check('confirm card closes immediately after adopt', container.querySelector('.dshc-card-dispatch') === null)
check('sent status line reports waiting for the commander',
  container.querySelector('.dshc-dispatch-sent')?.textContent?.includes('dispatch.waiting') === true,
  String(container.querySelector('.dshc-dispatch-sent')?.textContent))

await act(async () => {
  store.notify({
    pendingDispatch: null,
    tasks: [{ id: 'task_1', title: '导出开关', status: 'queued', workspaceId: 'ws_1', updatedAt: 2 }],
    counts: { queued: 1 },
  })
})
check('card stays closed after pendingDispatch=null', container.querySelector('.dshc-card-dispatch') === null)
check('status bar reflects the updated task', container.querySelector('.dshc-statusbar')?.textContent?.includes('task.status.queued') === true)
check('task summary strip shows queued chip', container.textContent.includes('task.status.queued') === true)

await act(async () => { store.notify({ pendingDispatch: pendingDecision({ decisionId: 'dec_2' }) }) })
card = container.querySelector('.dshc-card-dispatch')
await act(async () => { findButton(card, 'dispatch.custom').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('custom picker expands', card.querySelectorAll('.dshc-dispatch-custom select').length >= 1)
await act(async () => { findButton(card, 'dispatch.custom.confirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
const customText = store.sent[sentBeforeDispatch + 1]
check('custom sends the contract message', typeof customText === 'string'
  && customText.startsWith('[dispatch-confirm] 自定义')
  && customText.includes('decisionId=dec_2')
  && customText.includes('target=workspaceId:ws_1;mode:new'), JSON.stringify(customText))

await act(async () => { store.notify({ pendingDispatch: pendingDecision({ decisionId: 'dec_3' }) }) })
card = container.querySelector('.dshc-card-dispatch')
await act(async () => { findButton(card, 'dispatch.cancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
const cancelText = store.sent[sentBeforeDispatch + 2]
check('cancel sends the contract message', typeof cancelText === 'string'
  && cancelText.startsWith('[dispatch-confirm] 取消')
  && cancelText.includes('decisionId=dec_3')
  && cancelText.includes('target=') === false, JSON.stringify(cancelText))

await act(async () => {
  store.notify({ pendingDispatch: pendingDecision({ decisionId: 'dec_4', expiresAt: Date.now() - 1_000 }) })
})
card = container.querySelector('.dshc-card-dispatch')
check('expired card greys out and asks for a new dispatch', card?.textContent?.includes('dispatch.expired') === true)
check('expired card hides actions', findButton(card, 'dispatch.adopt') === undefined)

// ---- M1R: custom attach picker ------------------------------------------
store.setSessionsResult({
  ok: true,
  data: { ...store.getSessionsResult().data, truncated: true },
})
await act(async () => { store.notify({ pendingDispatch: pendingDecision({ decisionId: 'dec_5' }) }) })
card = container.querySelector('.dshc-card-dispatch')
await act(async () => { findButton(card, 'dispatch.custom').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const customBlock = () => card.querySelector('.dshc-dispatch-custom')
const modeSelect = customBlock().querySelectorAll('select')[1]
check('custom picker offers new and attach modes',
  [...modeSelect.options].map(option => option.value).join(',') === 'new,attach',
  [...modeSelect.options].map(option => option.value).join(','))

await act(async () => { setSelectValue(customBlock().querySelectorAll('select')[1], 'attach') })
await act(async () => {})
check('attach mode requests the workspace session list',
  store.sent.some(entry => entry !== null && typeof entry === 'object' && entry.listSessions === 'ws_1'))
check('attach picker lists the returned sessions', customBlock().querySelectorAll('.dshc-session-row').length === 3,
  String(customBlock().querySelectorAll('.dshc-session-row').length))
check('attach picker shows title and context level',
  customBlock().textContent.includes('订单导出旧会话') && customBlock().textContent.includes('62'))
check('attach picker labels an unnamed session', customBlock().textContent.includes('settings.binding.unnamedSession'))
check('attach picker shows the limit-20 truncated hint',
  customBlock().textContent.includes('sessions.truncatedLimit20') === true)
check('attach confirm disabled until a session is picked',
  findButton(customBlock(), 'dispatch.custom.confirm').disabled === true)

await act(async () => { customBlock().querySelectorAll('.dshc-session-row')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('attach confirm enabled after picking a session',
  findButton(customBlock(), 'dispatch.custom.confirm').disabled === false)
await act(async () => { findButton(customBlock(), 'dispatch.custom.confirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
const attachText = [...store.sent].reverse().find(entry => typeof entry === 'string')
check('attach custom sends the M1R contract message', typeof attachText === 'string'
  && attachText.startsWith('[dispatch-confirm] 自定义')
  && attachText.includes('decisionId=dec_5')
  && attachText.includes('target=workspaceId:ws_1;mode:attach;sessionId:sess_9'), JSON.stringify(attachText))

// Host route absent → degrade to new-session only.
store.setSessionsResult({ ok: false, failure: { ok: false, code: 'not_found', message: 'no route' } })
await act(async () => { store.notify({ pendingDispatch: pendingDecision({ decisionId: 'dec_6' }) }) })
card = container.querySelector('.dshc-card-dispatch')
await act(async () => { findButton(card, 'dispatch.custom').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { setSelectValue(card.querySelectorAll('.dshc-dispatch-custom select')[1], 'attach') })
await act(async () => {})
check('attach degrades when the Host session route is missing',
  card.textContent.includes('dispatch.custom.session.unavailable') === true)
check('attach confirm stays disabled without a session list',
  findButton(card.querySelector('.dshc-dispatch-custom'), 'dispatch.custom.confirm').disabled === true)

// ---- mount settings section ---------------------------------------------
const settingsStore = makeStore()
let loadConfigCalls = 0
settingsStore.loadConfig = async () => { loadConfigCalls += 1 }
const settingsContainer = document.createElement('div')
const settingsRoot = createRoot(settingsContainer)
let settingsError = null
try {
  await act(async () => {
    settingsRoot.render(React.createElement(settings.component, { store: settingsStore, t }))
  })
} catch (error) {
  settingsError = error
}
check('settings mounts without throwing', settingsError === null, settingsError?.message)
check('settings reads config on mount', loadConfigCalls === 1, String(loadConfigCalls))
check('settings renders five groups', settingsContainer.querySelectorAll('section.dshc-card').length === 5, String(settingsContainer.querySelectorAll('section.dshc-card').length))
const appearanceCard = [...settingsContainer.querySelectorAll('section.dshc-card')]
  .find(card => card.textContent.includes('settings.group.appearance'))
const entryToggle = appearanceCard?.querySelector('input[type="checkbox"]')
check('settings appearance has the floating-entry toggle', entryToggle !== undefined)
check('settings appearance toggle defaults to on (config default)', entryToggle?.checked === true)
check('settings appearance no longer offers the corner select',
  !settingsContainer.textContent.includes('settings.appearance.position.br'))
check('settings appearance explains drag-to-move', settingsContainer.textContent.includes('settings.appearance.positionHint') === true)
const configPatches = []
settingsStore.saveConfig = async (patch) => { configPatches.push(patch); return { ok: true, data: {} } }
await act(async () => { entryToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { findButton(appearanceCard, 'settings.appearance.save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('appearance save sends entryEnabled=false', configPatches.some(patch => patch?.ui?.entryEnabled === false), JSON.stringify(configPatches))
check('settings shows bound session id', settingsContainer.textContent.includes('sess_1') === true)
check('settings shows workspace row', settingsContainer.textContent.includes('HtDot') === true)
check('settings notes confirmation-only dispatch', settingsContainer.textContent.includes('settings.jev.note') === true)
const saveWorkspaces = [...settingsContainer.querySelectorAll('button')].find(button => button.textContent === 'settings.workspace.save')
check('settings save-workspaces button exists', saveWorkspaces !== undefined)
await act(async () => { saveWorkspaces.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('settings save posts full workspace list', typeof settingsStore.sent[0] === 'object' && settingsStore.sent[0].workspaces === 1, JSON.stringify(settingsStore.sent[0]))
const autoSwitch = settingsContainer.querySelector('[role="switch"]')
check('settings renders autoDispatch switch (default off)', autoSwitch?.getAttribute('aria-checked') === 'false')
await act(async () => { autoSwitch?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('settings autoDispatch toggles on', autoSwitch?.getAttribute('aria-checked') === 'true')
check('settings apiKeyEnv defaults to TYPESAFE_API_KEY', [...settingsContainer.querySelectorAll('input')].some(input => input.value === 'TYPESAFE_API_KEY'))
check('settings shows both stage thresholds', settingsContainer.textContent.includes('settings.jev.workspaceThreshold') === true && settingsContainer.textContent.includes('settings.jev.sessionThreshold') === true)
const testJevButton = findButton(settingsContainer, 'jev.test')
check('settings test-connection button exists', testJevButton !== undefined)
await act(async () => { testJevButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('test connection calls POST /commander/jev/test', typeof settingsStore.sent[1] === 'object' && 'jevTest' in settingsStore.sent[1], JSON.stringify(settingsStore.sent[1]))
check('test connection renders latency result', settingsContainer.textContent.includes('jev.test.ok') && settingsContainer.textContent.includes('123ms'), settingsContainer.querySelector('.dshc-test-result')?.textContent)

// task-64: binding picker — open → load → select → confirm (POST /commander/binding).
// The picker highlights `state.binding.sessionId`; align the fake binding with the list.
await act(async () => {
  settingsStore.notify({ binding: { ...baseView().binding, sessionId: 'sess_9', workspaceId: 'ws_1' } })
})
await act(async () => {})
const selectButton = findButton(settingsContainer, 'settings.binding.select')
check('binding picker button exists and is wired', selectButton !== undefined && selectButton.getAttribute('aria-expanded') === 'false')
await act(async () => { selectButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('binding picker requests sessions for the selected workspace',
  settingsStore.sent.some(entry => entry !== null && typeof entry === 'object' && entry.listSessions === 'ws_1'))
const bindingPicker = () => settingsContainer.querySelector('.dshc-binding-picker')
check('binding picker lists sessions', bindingPicker()?.querySelectorAll('.dshc-session-row').length === 3,
  String(bindingPicker()?.querySelectorAll('.dshc-session-row').length))
const bindingRows = [...bindingPicker().querySelectorAll('.dshc-session-row')]
check('binding picker hides the truncated hint when not truncated', bindingPicker().textContent.includes('sessions.truncatedLimit20') === false)
check('binding row shows the session title', bindingRows[0]?.textContent?.includes('订单导出旧会话') === true)
check('binding row keeps a short id suffix', bindingRows[0]?.textContent?.includes('…') === true)
check('binding row shows relative activity + context + created time',
  bindingRows[0]?.textContent?.includes('2 time.minutesAgo') === true
  && bindingRows[0].textContent.includes('dispatch.custom.session.context 62%')
  && bindingRows[0].textContent.includes('settings.binding.createdAt'))
check('unnamed session row falls back to the labelled title',
  bindingRows[2]?.textContent?.includes('settings.binding.unnamedSession') === true
  && bindingRows[2].textContent.includes('settings.binding.unknownTime')
  && bindingRows[2].textContent.includes('…4ac7fcd'),
  bindingRows[2]?.textContent)
check('binding picker highlights the currently bound session',
  bindingPicker()?.querySelector('.dshc-session-row[data-bound="true"]')?.textContent?.includes('订单导出旧会话') === true
  && bindingPicker().querySelector('.dshc-session-row[data-bound="true"]')?.textContent?.includes('settings.binding.selectBound') === true)
check('binding confirm disabled before selecting a session',
  findButton(bindingPicker(), 'settings.binding.selectConfirm')?.disabled === true)
await act(async () => { bindingPicker().querySelectorAll('.dshc-session-row')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('binding confirm enabled after selecting a session',
  findButton(bindingPicker(), 'settings.binding.selectConfirm')?.disabled === false)
await act(async () => { findButton(bindingPicker(), 'settings.binding.selectConfirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
const bindRequest = settingsStore.sent.filter(entry => entry !== null && typeof entry === 'object' && entry.bind).at(-1)
check('binding confirm posts mode=select with workspaceId+sessionId',
  bindRequest?.bind?.mode === 'select' && bindRequest?.bind?.workspaceId === 'ws_1' && bindRequest?.bind?.sessionId === 'sess_10',
  JSON.stringify(bindRequest))
check('binding picker closes after success', bindingPicker() === null)
check('binding picker reports success', settingsContainer.textContent.includes('settings.save.ok'))

// Failure copy maps the Host code but keeps it visible.
settingsStore.setBindResult({ ok: false, failure: { ok: false, code: 'not_found', message: 'session gone' } })
await act(async () => { findButton(settingsContainer, 'settings.binding.select').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
await act(async () => { settingsContainer.querySelector('.dshc-binding-picker .dshc-session-row').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { findButton(settingsContainer.querySelector('.dshc-binding-picker'), 'settings.binding.selectConfirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('binding failure shows mapped copy and keeps the code',
  settingsContainer.textContent.includes('settings.binding.error.notFound')
  && settingsContainer.textContent.includes('not_found'),
  settingsContainer.querySelector('.dshc-result[data-kind="error"]')?.textContent)
// invalid_request keeps the Host message verbatim (backend includes "可用会话 N 个").
settingsStore.setBindResult({ ok: false, failure: { ok: false, code: 'invalid_request', message: '可用会话 0 个' } })
await act(async () => { findButton(settingsContainer.querySelector('.dshc-binding-picker'), 'settings.binding.selectConfirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('invalid_request failure shows the Host message and the code',
  settingsContainer.textContent.includes('可用会话 0 个')
  && settingsContainer.textContent.includes('invalid_request'),
  settingsContainer.querySelector('.dshc-result[data-kind="error"]')?.textContent)
settingsStore.setBindResult({ ok: true, data: {} })
await act(async () => { findButton(settingsContainer.querySelector('.dshc-binding-picker'), 'settings.binding.selectCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})

// Empty state.
settingsStore.setSessionsResult({ ok: true, data: { sessions: [], truncated: false } })
await act(async () => { findButton(settingsContainer, 'settings.binding.select').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('binding picker renders the empty state', bindingPicker()?.textContent?.includes('settings.binding.selectEmpty') === true)
check('binding confirm stays disabled in the empty state',
  findButton(bindingPicker(), 'settings.binding.selectConfirm')?.disabled === true)
await act(async () => { findButton(bindingPicker(), 'settings.binding.selectCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})

// Error state + retry recovery.
settingsStore.setSessionsResult({ ok: false, failure: { ok: false, code: 'internal', message: 'list failed' } })
await act(async () => { findButton(settingsContainer, 'settings.binding.select').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('binding picker renders the error state', bindingPicker()?.textContent?.includes('settings.binding.selectError') === true)
settingsStore.setSessionsResult({
  ok: true,
  data: { truncated: true, sessions: [{ sessionId: 'sess_10', title: '结算页会话', lastActiveAt: 1_759_900_000_000, contextPct: 35 }] },
})
await act(async () => { findButton(bindingPicker(), 'settings.binding.selectRetry').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('binding picker retry recovers the list', bindingPicker()?.querySelectorAll('.dshc-session-row').length === 1,
  String(bindingPicker()?.querySelectorAll('.dshc-session-row').length))
check('binding picker shows the limit-20 truncated hint',
  bindingPicker()?.textContent?.includes('sessions.truncatedLimit20') === true)

// ---- M2 board page -------------------------------------------------------
const boardStore = makeStore()
const boardTasks = [
  { id: 'task_p', title: '待确认任务', status: 'proposed', workspaceId: 'ws_1', priority: 'high', updatedAt: 9, acceptanceCount: 0, primarySessionId: 'sess_1', dependsOn: ['task_q'], waitingFor: ['task_q'], ready: false },
  { id: 'task_q', title: '待运行任务', status: 'queued', workspaceId: 'ws_1', priority: 'normal', lastActivityAt: 1 },
  { id: 'task_a', title: '进行中任务', status: 'running', workspaceId: 'ws_1', priority: 'normal', lastActivityAt: 2, capability: { status: 'inherited', enabledCount: 0, disabledCount: 0 } },
  { id: 'task_b', title: '受阻任务', status: 'blocked', workspaceId: 'ws_1', block: { code: 'delivery_failed', since: 4 } },
  { id: 'task_r', title: '待验收任务', status: 'review', workspaceId: 'ws_1', acceptanceCount: 2, updatedAt: 5, capability: { status: 'applied', enabledCount: 3, disabledCount: 2 } },
  { id: 'task_d', title: '完成的任务', status: 'done', workspaceId: 'ws_1', updatedAt: 3 },
]
boardStore.notify({ tasks: boardTasks, counts: { review: 1, done: 1 }, pendingDispatch: null })
const boardContainer = document.createElement('div')
// Focus-driven dependency highlighting needs the container in the document.
document.body.appendChild(boardContainer)
const boardRoot = createRoot(boardContainer)
await act(async () => {
  boardRoot.render(React.createElement(board.component, { ...board.options.inject(), store: boardStore, t }))
})
check('board renders six columns', boardContainer.querySelectorAll('.dshc-board-column').length === 6,
  String(boardContainer.querySelectorAll('.dshc-board-column').length))
check('board columns default to equal grid tracks with 5 drag handles',
  boardContainer.querySelectorAll('.dshc-board-resizer').length === 5
  && (boardContainer.querySelector('.dshc-board-columns')?.getAttribute('style') ?? '').split('minmax').length - 1 === 6,
  boardContainer.querySelector('.dshc-board-columns')?.getAttribute('style'))
check('board column heads carry the frozen labels',
  ['board.column.proposed', 'board.column.queued', 'board.column.running', 'board.column.blocked', 'board.column.review', 'board.column.done']
    .every(key => boardContainer.textContent.includes(key)))
check('board renders cards across columns', boardContainer.querySelectorAll('.dshc-board-card').length === 6)
check('board card renders the dependency gate', boardContainer.textContent.includes('board.card.prereq')
  && boardContainer.textContent.includes('board.card.remaining'))
check('only cards with dependencies render a one-line gate', boardContainer.querySelectorAll('.dshc-dep-gate').length === 1)
check('cards without dependencies render no dependency block', boardContainer.querySelectorAll('.dshc-dep-spacer').length === 0)
check('collapsed dependency gate does not render its list', boardContainer.querySelectorAll('.dshc-dep-gate-list').length === 0)
check('board card renders the downstream count', boardContainer.textContent.includes('board.card.downstream'))
const depCard = boardContainer.querySelector('.dshc-board-card[data-task-id="task_p"]')
check('board cards carry dependency data attributes', depCard?.getAttribute('data-dep-active') === 'false')
await act(async () => { depCard.focus() })
check('focusing a card highlights its chain and dims the rest',
  depCard.getAttribute('data-dep-active') === 'true'
  && boardContainer.querySelectorAll('.dshc-board-card[data-dep-dim="true"]').length > 0,
  JSON.stringify({
    active: depCard.getAttribute('data-dep-active'),
    dim: boardContainer.querySelectorAll('.dshc-board-card[data-dep-dim="true"]').length,
    focused: boardContainer.querySelector('.dshc-board-card[data-task-id="task_p"]') === document.activeElement,
    text: depCard.textContent.slice(0, 60),
  }))
await act(async () => { depCard.blur() })
check('blur clears the dependency highlight',
  boardContainer.querySelectorAll('.dshc-board-card[data-dep-dim="true"]').length === 0)
const lonelyCard = boardContainer.querySelector('.dshc-board-card[data-task-id="task_a"]')
await act(async () => { lonelyCard.focus() })
check('focusing a card without dependency links does not dim the board',
  boardContainer.querySelectorAll('.dshc-board-card[data-dep-dim="true"]').length === 0
  && lonelyCard.getAttribute('data-dep-active') === 'false'
  && boardContainer.querySelectorAll('.dshc-edge-line, .dshc-dep-edge').length === 0)
await act(async () => { lonelyCard.blur() })

// 依赖连线覆盖层：jsdom 没有布局，用固定矩形驱动一次真实的绘制，
// 锁住 SVG 连线与箭头（等待中琥珀箭头 / 前置已完成绿色箭头）。
const boardWrap = boardContainer.querySelector('.dshc-board-columns-wrap')
const cardEl = id => boardContainer.querySelector(`.dshc-board-card[data-task-id="${id}"]`)
const stubRect = (element, left, top, width, height) => {
  element.getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON() { return this },
  })
}
Object.defineProperty(boardWrap, 'clientWidth', { configurable: true, value: 900 })
Object.defineProperty(boardWrap, 'clientHeight', { configurable: true, value: 600 })
stubRect(boardWrap, 0, 0, 900, 600)
stubRect(cardEl('task_q'), 220, 40, 180, 120)
stubRect(cardEl('task_p'), 20, 300, 180, 120)
await act(async () => { cardEl('task_p').focus() })
const waitingEdge = boardContainer.querySelector('.dshc-dep-edge[data-state="waiting"]')
check('dependency overlay draws a waiting edge with the amber arrow',
  waitingEdge !== null && waitingEdge.getAttribute('marker-end') === 'url(#dshc-dep-arrow)',
  waitingEdge?.getAttribute('d') ?? 'no edge')
await act(async () => { cardEl('task_p').blur() })
// 前置改为 done：连线换成绿色，并带绿色箭头（用户反馈「绿色没有了箭头」）。
await act(async () => {
  boardStore.notify({
    tasks: boardTasks.map(row => (row.id === 'task_q' ? { ...row, status: 'done' } : row)),
    counts: { review: 1, done: 2 }, pendingDispatch: null,
  })
})
stubRect(cardEl('task_q'), 220, 40, 180, 120)
stubRect(cardEl('task_p'), 20, 300, 180, 120)
await act(async () => { cardEl('task_p').focus() })
const readyEdge = boardContainer.querySelector('.dshc-dep-edge[data-state="ready"]')
check('ready dependency edge keeps its arrow in the success colour',
  readyEdge !== null && readyEdge.getAttribute('marker-end') === 'url(#dshc-dep-arrow-ready)'
  && boardContainer.querySelector('#dshc-dep-arrow-ready path')?.getAttribute('fill')?.includes('state-success-primary'),
  readyEdge?.getAttribute('d') ?? 'no edge')
await act(async () => { cardEl('task_p').blur() })
await act(async () => {
  boardStore.notify({ tasks: boardTasks, counts: { review: 1, done: 1 }, pendingDispatch: null })
})
delete boardWrap.clientWidth
delete boardWrap.clientHeight
delete boardWrap.getBoundingClientRect
for (const id of ['task_p', 'task_q']) delete cardEl(id).getBoundingClientRect
check('long-silent running card shows no stall badge',
  boardContainer.querySelectorAll('.dshc-board-stale').length === 0
  && !boardContainer.textContent.includes('board.card.staleBadge'))
check('board shows blocked code', boardContainer.textContent.includes('delivery_failed'))
check('board hides the capability count when nothing was enabled (no 0/0 noise)',
  !boardContainer.textContent.includes('task.capability (0/0)'))
check('board shows the capability count when capabilities were applied',
  boardContainer.textContent.includes('task.capability (3/5)'))
check('board shows high priority pill',
  boardContainer.querySelector('.dshc-board-priority[data-priority="high"]') !== null)
const sessionCard = boardContainer.querySelector('.dshc-board-card[data-status="proposed"]')
const openSessionButton = sessionCard?.querySelector('.dshc-board-card-actions button')
check('board card offers an open-session action', openSessionButton?.textContent === 'board.action.openSession',
  String(openSessionButton?.textContent))
await act(async () => { openSessionButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('board card open-session opens the linked session', openedSessions.includes('sess_1'), JSON.stringify(openedSessions))

// Drawer: click a card, wait for GET /commander/tasks/:id.
await act(async () => { boardContainer.querySelectorAll('.dshc-board-card')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('board opens the task detail drawer', boardContainer.querySelector('.dshc-board-drawer') !== null)
check('drawer renders the chronological feed',
  ['board.drawer.feed.dispatch', 'board.drawer.feed.status', 'board.drawer.feed.edit', 'board.drawer.feed.report', 'board.drawer.now']
    .every(key => boardContainer.textContent.includes(key)),
  boardContainer.querySelector('.dshc-board-drawer')?.textContent?.slice(0, 240))
check('drawer shows acceptance text', boardContainer.textContent.includes('导出按钮可见'))
const conclusionCard = boardContainer.querySelector('.dshc-d-conclusion')
check('drawer shows the commander_task_report summary in a conclusion card',
  conclusionCard?.querySelector('.dshc-d-conclusion-text')?.textContent?.includes('本轮完成导出修复') === true,
  String(conclusionCard?.querySelector('.dshc-d-conclusion-text')?.textContent))
check('drawer renders the summary once (no raw duplicate)',
  boardContainer.querySelector('.dshc-d-ev-summary') === null
    && (boardContainer.querySelector('.dshc-board-drawer')?.textContent?.split('本轮完成导出修复').length ?? 1) - 1 === 1,
  String((boardContainer.querySelector('.dshc-board-drawer')?.textContent?.split('本轮完成导出修复').length ?? 1) - 1))
check('conclusion card renders the 结论 label key',
  conclusionCard?.querySelector('.dshc-d-conclusion-pill')?.textContent === 'board.drawer.conclusion',
  String(conclusionCard?.querySelector('.dshc-d-conclusion-pill')?.textContent))
const conclusionToggle = conclusionCard?.querySelector('.dshc-d-conclusion-toggle')
check('long conclusion offers the collapse toggle key',
  conclusionToggle !== undefined && conclusionToggle !== null && conclusionToggle.textContent.includes('board.drawer.conclusionMore'),
  String(conclusionToggle?.textContent))
await act(async () => { conclusionToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('expanding the conclusion flips aria-expanded and the toggle label',
  conclusionCard?.querySelector('.dshc-d-conclusion-text')?.getAttribute('data-expanded') === 'true'
    && conclusionCard?.querySelector('.dshc-d-conclusion-toggle')?.getAttribute('aria-expanded') === 'true'
    && boardContainer.textContent.includes('board.drawer.conclusionLess'),
  JSON.stringify({ expanded: conclusionCard?.querySelector('.dshc-d-conclusion-text')?.getAttribute('data-expanded'), label: conclusionCard?.querySelector('.dshc-d-conclusion-toggle')?.textContent }))
const materialsBlock = boardContainer.querySelector('.dshc-d-mat')
check('drawer renders the report materials block',
  materialsBlock !== null && materialsBlock.textContent?.includes('board.drawer.materials') === true,
  String(materialsBlock?.textContent?.slice(0, 160)))
check('materials block shows one image and two list rows',
  materialsBlock?.querySelectorAll('.dshc-d-mat-shot').length === 1
    && materialsBlock?.querySelectorAll('.dshc-d-mat-row').length === 2)
check('acceptance item shows a linked material chip',
  materialsBlock?.parentElement?.querySelectorAll('.dshc-d-mat-chip').length === 1,
  String(materialsBlock?.parentElement?.querySelectorAll('.dshc-d-mat-chip').length))
await act(async () => {
  materialsBlock?.querySelector('.dshc-d-mat-shot')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {})
check('clicking a material image opens the lightbox', boardContainer.querySelector('.dshc-d-lb') !== null)
await act(async () => {
  boardContainer.querySelector('.dshc-d-lb-close')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {})
check('lightbox close button closes it', boardContainer.querySelector('.dshc-d-lb') === null)
const fileMaterialRow = [...(materialsBlock?.querySelectorAll('.dshc-d-mat-row') ?? [])]
  .find(row => row.textContent?.includes('兼容性评估'))
await act(async () => {
  fileMaterialRow?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {})
check('clicking a local document opens the file action sheet',
  boardContainer.querySelector('.dshc-d-fs') !== null
    && boardContainer.querySelector('.dshc-d-fs')?.textContent?.includes('兼容性评估') === true)
await act(async () => {
  boardContainer.querySelector('.dshc-d-fs .dshc-d-fs-btn.primary')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {})
check('file action sheet closes', boardContainer.querySelector('.dshc-d-fs') === null)

const drawerSession = [...boardContainer.querySelectorAll('.dshc-board-drawer .dshc-d-session')]
  .find(row => row.textContent.includes('订单导出改造'))
check('drawer session card shows 工作区 · 会话标题（不是裸 sessionId）',
  drawerSession !== undefined && drawerSession.textContent.includes('订单导出改造')
    && !drawerSession.textContent.includes('sess_1'),
  String(drawerSession?.textContent))
await act(async () => { boardContainer.querySelector('.dshc-board-mask').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('drawer closes via the mask', boardContainer.querySelector('.dshc-board-drawer') === null)

// M3: review drawer accept + rework (human-only routes).
const reviewCard = [...boardContainer.querySelectorAll('.dshc-board-card')].find(card => card.textContent.includes('待验收任务'))
await act(async () => { reviewCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
const reviewDrawer = boardContainer.querySelector('.dshc-board-drawer')
check('review drawer shows accept/rework actions', findButton(reviewDrawer, 'board.action.accept') !== undefined
  && findButton(reviewDrawer, 'board.action.rework') !== undefined)
check('review drawer states the human-only review rule', reviewDrawer.textContent.includes('board.drawer.reviewHint'))
const reviewTitle = reviewDrawer.querySelector('.dshc-d-title')
const reviewStatus = reviewDrawer.querySelector('.dshc-d-status')
const reviewWorkspace = reviewDrawer.querySelector('.dshc-d-workspace')
const reviewPriority = reviewDrawer.querySelector('.dshc-d-priority')
check('review drawer header carries title/workspace/status/priority',
  reviewTitle?.value === '待验收任务'
    && reviewWorkspace?.textContent?.includes('HtDot') === true
    && reviewStatus?.textContent?.trim() === 'task.status.review'
    && reviewPriority?.value === 'normal',
  JSON.stringify({ title: reviewTitle?.value, workspace: reviewWorkspace?.textContent, status: reviewStatus?.textContent, priority: reviewPriority?.value }))
check('review drawer shows the five-step stepper',
  reviewDrawer.querySelectorAll('.dshc-d-steps > li').length === 5
    && reviewDrawer.textContent.includes('board.drawer.stage.proposed')
    && reviewDrawer.textContent.includes('board.drawer.stage.done'))
check('review drawer renders the now marker', reviewDrawer.textContent.includes('board.drawer.now'))
await act(async () => { findButton(reviewDrawer, 'board.action.accept').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('accept asks for confirmation first', reviewDrawer.textContent.includes('board.accept.confirm'))
await act(async () => { findButton(reviewDrawer, 'board.accept.ok').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('accept calls POST /commander/tasks/:id/accept',
  boardStore.sent.some(entry => entry !== null && typeof entry === 'object' && entry.accept === 'task_r'))
await act(async () => { findButton(reviewDrawer, 'board.action.rework').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const reworkArea = reviewDrawer.querySelector('.dshc-d-rework textarea')
check('rework opens the comment box', reworkArea !== null)
await act(async () => { setTextareaValue(reworkArea, '请补充截图证据') })
await act(async () => { findButton(reviewDrawer, 'board.rework.submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('rework posts the comment to /rework',
  boardStore.sent.some(entry => entry !== null && typeof entry === 'object' && entry.rework === 'task_r' && entry.comment === '请补充截图证据'),
  JSON.stringify(boardStore.sent.filter(entry => entry !== null && typeof entry === 'object' && entry.rework)))
await act(async () => { boardContainer.querySelector('.dshc-board-mask').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

// No drag/drop: cards are not draggable, and the only status action is cancel (human route).
const cardP = boardContainer.querySelectorAll('.dshc-board-card')[0]
check('board cards are not draggable (no status drag)', cardP.getAttribute('draggable') === null)
const patchesBefore = boardStore.sent.filter(entry => entry !== null && typeof entry === 'object' && entry.boardPatch).length
const cancelButton = [...cardP.querySelectorAll('button')].find(button => button.textContent === 'board.action.cancel')
check('board card offers a cancel action', cancelButton !== undefined)
await act(async () => { cancelButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('cancel calls POST /commander/tasks/:id/cancel',
  boardStore.sent.some(entry => entry !== null && typeof entry === 'object' && entry.cancel !== undefined),
  JSON.stringify(boardStore.sent.filter(entry => entry !== null && typeof entry === 'object' && entry.cancel)))
check('board no longer renders action toasts', boardContainer.querySelector('.dshc-board-toast') === null)
check('no board PATCH was sent by the card', boardStore.sent.filter(entry => entry !== null && typeof entry === 'object' && entry.boardPatch).length === patchesBefore)

// Trash tab + restore.
const trashTab = [...boardContainer.querySelectorAll('button')].find(button => button.textContent.startsWith('board.tab.trash'))
await act(async () => { trashTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
await act(async () => {})
check('trash tab renders the archive stream', boardContainer.querySelectorAll('.dshc-archive-card').length === 2,
  String(boardContainer.querySelectorAll('.dshc-archive-card').length))
check('trash requests the first archive batch with the page size',
  boardStore.archiveQueries.at(-1)?.limit === 60,
  JSON.stringify(boardStore.archiveQueries.at(-1)))
check('trash shows filters and stats', boardContainer.querySelectorAll('.dshc-archive-chip').length === 3
  && boardContainer.textContent.includes('board.trash.stats.total')
  && boardContainer.textContent.includes('board.trash.stats.recent'))
const archivedChip = [...boardContainer.querySelectorAll('.dshc-archive-chip')].find(button => button.textContent === 'board.trash.status.archived')
await act(async () => { archivedChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('trash status filter is sent to the Host', boardStore.archiveQueries.at(-1)?.status === 'archived',
  JSON.stringify(boardStore.archiveQueries.at(-1)))
const restoreButton = boardContainer.querySelector('.dshc-archive-restore')
check('trash offers restore for archived tasks', restoreButton !== null)
await act(async () => { restoreButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
check('restore calls the Host route', boardStore.sent.some(entry => entry !== null && typeof entry === 'object' && entry.restore === 'tr_1'))

// Header no longer carries a back button (removed by design).
check('board header has no back button', [...boardContainer.querySelectorAll('button')].every(button => button.textContent !== 'board.back'))

// ---- production dictionary render: no raw key literals (task-63) ----------
const boardZhContainer = document.createElement('div')
const boardZhRoot = createRoot(boardZhContainer)
await act(async () => {
  boardZhRoot.render(React.createElement(board.component, { ...board.options.inject(), store: boardStore, t: zhT }))
})
check('board zh render has no raw i18n keys', !RAW_KEY_LITERAL.test(boardZhContainer.textContent ?? ''))
check('board zh render shows localized headings/columns',
  boardZhContainer.textContent.includes('看板')
  && boardZhContainer.textContent.includes('待派发')
  && boardZhContainer.textContent.includes('待运行')
  && boardZhContainer.textContent.includes('运行中')
  && boardZhContainer.textContent.includes('已验收')
  && boardZhContainer.textContent.includes('普通'))
const zhReviewCard = [...boardZhContainer.querySelectorAll('.dshc-board-card')].find(card => card.textContent.includes('待验收任务'))
await act(async () => { zhReviewCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => {})
const zhDrawer = boardZhContainer.querySelector('.dshc-board-drawer')
check('drawer zh render has no raw i18n keys', !RAW_KEY_LITERAL.test(zhDrawer?.textContent ?? ''))
const zhTitle = zhDrawer?.querySelector('.dshc-d-title')
const zhStatus = zhDrawer?.querySelector('.dshc-d-status')
const zhWorkspace = zhDrawer?.querySelector('.dshc-d-workspace')
const zhPriority = zhDrawer?.querySelector('.dshc-d-priority')
check('drawer zh header is localized',
  zhTitle?.value === '待验收任务' && zhStatus?.textContent?.trim() === '待验收'
    && zhWorkspace?.textContent?.includes('HtDot') === true && zhPriority?.value === 'normal',
  JSON.stringify({ title: zhTitle?.value, status: zhStatus?.textContent, workspace: zhWorkspace?.textContent, priority: zhPriority?.value }))
check('drawer zh feed labels are localized',
  zhDrawer?.textContent?.includes('派发') === true
  && zhDrawer.textContent.includes('验收')
  && zhDrawer.textContent.includes('人工改动')
  && zhDrawer.textContent.includes('现在')
  && zhDrawer.textContent.includes('采用建议'))
const zhConclusionPill = zhDrawer?.querySelector('.dshc-d-conclusion-pill')
const zhConclusionToggle = zhDrawer?.querySelector('.dshc-d-conclusion-toggle')
check('drawer zh conclusion card is localized',
  zhConclusionPill?.textContent === '结论'
  && zhConclusionToggle?.textContent?.includes('展开结论') === true,
  JSON.stringify({ pill: zhConclusionPill?.textContent, toggle: zhConclusionToggle?.textContent }))

// Overlay with the production dictionary: approval card + injected system messages.
const zhStore = makeStore()
zhStore.notify({
  tasks: [{ id: 'task_1', title: '导出任务', status: 'running', workspaceId: 'ws_1' }],
  workSessions: [{ sessionId: 'sess_1', taskId: 'task_1', title: '导出会话' }],
  messages: [
    { id: 'rep_1', role: 'user', text: '[session-reply] 订单导出开关已完成。\n---\ntaskId=task_1 sessionId=sess_1 turnId=4 seq=37 truncated=false', at: 1_760_000_000_000, order: 1 },
    { id: 'edit_1', role: 'user', text: '[board-edit] taskId=task_1 by=user\nstatus: review → blocked\n---\neditIds=edit_1 injectionKey=k1', at: 1_760_000_001_000, order: 2 },
  ],
})
await act(async () => {
  setSessionStatuses(new Map([['sess_1', { pendingInteraction: { ...approvalInstance, key: 'approval:zh', answerable: true } }]]))
})
const zhOverlayContainer = document.createElement('div')
const zhOverlayRoot = createRoot(zhOverlayContainer)
await act(async () => {
  zhOverlayRoot.render(React.createElement(overlay.component, { ...overlay.options.inject(), store: zhStore, t: zhT }))
})
await act(async () => {
  zhOverlayContainer.querySelector('.dshc-ball').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {})
check('overlay zh render has no raw i18n keys', !RAW_KEY_LITERAL.test(zhOverlayContainer.textContent ?? ''))
check('approval card is localized',
  zhOverlayContainer.textContent.includes('工作会话审批')
  && zhOverlayContainer.textContent.includes('允许')
  && zhOverlayContainer.textContent.includes('拒绝'))
check('injected system messages are localized cards',
  zhOverlayContainer.textContent.includes('工作会话汇报')
  && zhOverlayContainer.textContent.includes('看板改动'))
check('C sheet is localized', zhOverlayContainer.textContent.includes('需要你处理') && zhOverlayContainer.textContent.includes('仅在界面处理') && zhOverlayContainer.textContent.includes('暂时收起'))
await act(async () => { setSessionStatuses(new Map()) })

await act(async () => { zhOverlayRoot.unmount() })
await act(async () => { boardZhRoot.unmount() })
await act(async () => { root.unmount() })
await act(async () => { boardRoot.unmount() })
await act(async () => { settingsRoot.unmount() })
for (const dispose of effectDisposers) {
  try { dispose() } catch { /* best effort */ }
}
window.close()

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
