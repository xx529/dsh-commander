#!/usr/bin/env node
/**
 * Client bundle SSR smoke harness (against the built lib/client.js): evaluates the wrapped factory in a fake module loader, calls
 * `apply` with a fake Cordis client context, then renders both slot components
 * with react-dom/server.
 *
 * Usage: node smoke.mjs [path-to-lib/client.js]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Runtime deps (react/react-dom) are NOT Client devDeps: the bundle keeps the
 * zero-runtime-dependency contract and the browser module table supplies React.
 * The harness therefore resolves them from either:
 *   - `DSH_COMMANDER_HARNESS_MODULES` (a directory whose `node_modules` has react/react-dom), or
 *   - the package's own node_modules (works when a developer installed them).
 */
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
    console.error(`[smoke] missing optional dependency "${name}": ${error.message}`)
    console.error('[smoke] install react/react-dom in a scratch dir and set DSH_COMMANDER_HARNESS_MODULES=<dir>, see README.md')
    process.exit(2)
  }
}
const React = load('react')
const jsxRuntime = load('react/jsx-runtime')
const { renderToStaticMarkup } = load('react-dom/server')

const clientPath = process.argv[2] ?? resolve(here, '../../../lib/client.js')

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), ...(detail === undefined ? {} : { detail }) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(options) { loaded = options },
  },
}

const source = readFileSync(clientPath, 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

check('loader called', loaded !== null)
check('module id', loaded?.id === 'dsh-commander', String(loaded?.id))
check('factory is function', typeof loaded?.factory === 'function')

// The browser's static module table supplies the UI primitives; this SSR harness
// renders Markdown as plain text so the rest of the component tree is exercised.
const primitivesStub = {
  MarkdownText: ({ text }) => React.createElement('div', { className: 'markdown' }, text),
}
const moduleExports = loaded.factory(id => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected runtime require: ${id}`)
})

check('no direct remote prompt fallback', !/\.session\.prompt/.test(source) && !source.includes('getRemote'), 'bundle must send only through POST /commander/message')
check('dispatch confirmation template shipped', source.includes('[dispatch-confirm]'), 'M1 card sends [dispatch-confirm] text through POST /commander/message')
check('attach session route wired', source.includes('/commander/sessions'), 'M1R custom picker reads GET /commander/sessions?workspaceId=')
check('approval status wiring shipped', source.includes('sessionStatus') && source.includes('pendingInteraction'), 'M3 card reads uiSession.sessionStatus.pendingInteraction')
check('accept/continue routes wired', source.includes('/accept') && source.includes('/continue'), 'M3/M5 human-only routes')
check('exports.apply', typeof moduleExports.apply === 'function')
check('exports.inject', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'), JSON.stringify(moduleExports.inject))
// Cordis throws when a plugin reads a service it did not inject; `locale` must be
// declared or `apply` dies before registering a single slot (live-no-ball bug).
check('inject declares locale', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('locale'), JSON.stringify(moduleExports.inject))

// ---- fake Cordis client context -------------------------------------------
const registrations = []
const effects = []
const ctx = {
  slots: {
    inject(name, register) {
      const disposer = register()
      effects.push({ label: `slot:${name}`, disposer })
      return disposer
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect(callback, label) {
    const disposer = callback()
    effects.push({ label: label ?? 'effect', disposer })
  },
  get() { return undefined },
}

let applyError = null
try {
  moduleExports.apply(ctx)
} catch (error) {
  applyError = error
}
check('apply() does not throw', applyError === null, applyError?.message)

// Re-run apply against a Cordis-like strict proxy: reading any undeclared
// service throws, exactly like the real client context does.
const strictRegistrations = []
const strictEffects = []
const strictTarget = {
  slots: {
    inject(name, register) { return register() },
    register(options, component) { strictRegistrations.push({ options, component }); return () => {} },
  },
  effect(callback) { const dispose = callback(); strictEffects.push(dispose); return dispose },
  locale: { register: () => () => {}, bind: () => key => key },
}
const strictCtx = new Proxy(strictTarget, {
  get(target, prop) {
    if (Reflect.has(target, prop)) return Reflect.get(target, prop)
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})
let strictError = null
try {
  moduleExports.apply(strictCtx)
} catch (error) {
  strictError = error
}
check('apply survives a strict Cordis context', strictError === null, strictError?.message)
check('strict apply registers all slots', strictRegistrations.length === 4, String(strictRegistrations.length))
for (const dispose of strictEffects) { try { if (typeof dispose === 'function') dispose() } catch { /* best effort */ } }

const overlay = registrations.find(entry => entry.options.name === 'shell.overlay')
const settings = registrations.find(entry => entry.options.name === 'settings.section')
const board = registrations.find(entry => entry.options.name === 'main')
const nav = registrations.find(entry => entry.options.name === 'sidebar.panellist')
check('registers shell.overlay', overlay !== undefined)
check('overlay id', overlay?.options.id === 'commander.floating', String(overlay?.options.id))
check('overlay order', overlay?.options.order === 100, String(overlay?.options.order))
check('registers settings.section', settings !== undefined)
check('settings id', settings?.options.id === 'commander', String(settings?.options.id))
check('settings nav label', settings?.options.label?.() === '指挥官', String(settings?.options.label?.()))
check('main board page registered', board?.options.key === 'commander-board', String(board?.options.key))
check('board inject face closes to conversation', typeof board?.options.inject?.().closeBoard === 'function')
// The sidebar row resolves the clicked panel by this id: it must match the
// `main` keyed registration exactly, or selecting the row throws.
check('registers sidebar.panellist', nav !== undefined)
check('sidebar row id equals main board key', nav?.options.id === board?.options.key, `${String(nav?.options.id)} / ${String(board?.options.key)}`)
check('sidebar row order after shipped panels', nav?.options.order === 40, String(nav?.options.order))
check('sidebar row label localized', nav?.options.label?.() === '任务看板', String(nav?.options.label?.()))
check('sidebar row is icon-only component', typeof nav?.component === 'function')
check('overlay component', typeof overlay?.component === 'function')
check('settings component', typeof settings?.component === 'function')

const overlayFace = overlay?.options.inject?.() ?? {}
const settingsFace = settings?.options.inject?.() ?? {}
check('overlay inject face has store', typeof overlayFace.store === 'object' && overlayFace.store !== null)
check('overlay inject face has t', typeof overlayFace.t === 'function')
check('settings inject face has store', typeof settingsFace.store === 'object' && settingsFace.store !== null)
check('fallback t resolves zh', overlayFace.t?.('panel.title') === '指挥官', String(overlayFace.t?.('panel.title')))

// ---- render both entries with a fake store --------------------------------
const view = {
  rev: 1,
  connection: 'live',
  binding: {
    sessionId: 'sess_1',
    workspaceId: 'ws_1',
    workspacePath: '/tmp/htdot',
    model: { provider: 'tokfans', model: 'deepseek-flash', reasoningEffort: 'high' },
    agentPreset: 'standard',
  },
  commanderStatus: 'bound',
  panel: 'present',
  counts: { running: 1 },
  workspaces: [{ id: 'ws_1', name: 'HtDot', path: '/tmp/htdot', allowed: true, summary: '电商后台', policy: 'inherit' }],
  tasks: [],
  pendingDispatch: null,
  messages: [
    { id: 'req_1', role: 'user', text: '给订单导出加个开关', at: 1_760_000_000_000, order: 1 },
    { id: 'asst_1_2', role: 'assistant', text: '收到，稍后开始。', at: 1_760_000_001_000, order: 2 },
  ],
  busy: true,
  lastTurnId: 2,
  lastEventAt: 1_760_000_001_000,
  ui: { theme: 'follow', entryPosition: 'br' },
  sending: false,
  notice: null,
  config: null,
  configLoaded: true,
}
const store = {
  getSnapshot: () => view,
  subscribe: () => () => {},
  start() {},
  dispose() {},
  refresh: async () => {},
  send: async () => ({ ok: true, messageId: 'req_next' }),
  saveConfig: async () => ({ ok: true, data: {} }),
  saveWorkspaces: async () => ({ ok: true, data: [] }),
  bind: async () => ({ ok: true, data: {} }),
  loadConfig: async () => {},
  clearNotice() {},
  setEntryPosition() {},
}

const t = key => key
const rendered = {}
for (const [name, component, face] of [
  ['overlay', overlay?.component, { store, t }],
  ['settings', settings?.component, { store, t: overlayFace.t }],
  ['nav', nav?.component, { size: 16 }],
]) {
  if (typeof component !== 'function') continue
  try {
    rendered[name] = renderToStaticMarkup(React.createElement(component, face))
  } catch (error) {
    rendered[name] = `ERROR: ${error.message}`
  }
}

check('overlay renders ball', rendered.overlay?.includes('dshc-ball') === true, firstLine(rendered.overlay))
check('overlay renders style sheet', rendered.overlay?.includes('--dsw-alias-brand-primary') === true)
check('overlay has no full-screen mask element', /<div[^>]*dshc-board-mask/u.test(rendered.overlay ?? '') === false)
// The shell.overlay layer is click-through and `pointer-events` is inherited:
// the ball/panel must opt back in or live DSH hit-testing never reaches them.
const overlayCss = rendered.overlay ?? ''
check('overlay root stays click-through', /\.dshc-root\s*\{[^}]*pointer-events:\s*none/.test(overlayCss))
check('ball opts into pointer events', /\.dshc-ball\s*\{[\s\S]*?pointer-events:\s*auto/.test(overlayCss))
check('panel opts into pointer events', /\.dshc-panel\s*\{[\s\S]*?pointer-events:\s*auto/.test(overlayCss))
const settingsCss = rendered.settings ?? ''
check('sidebar row renders an svg glyph', /<svg[^>]*width="16"/.test(rendered.nav ?? ''), firstLine(rendered.nav))
check('settings opts into pointer events', /\.dshc-settings\s*\{[^}]*pointer-events:\s*auto/.test(settingsCss))
check('settings renders five groups', countOf(rendered.settings, '<section class="dshc-card"') === 5, String(countOf(rendered.settings, '<section class="dshc-card"')))
check('settings renders rotation group', rendered.settings?.includes('会话轮换') === true)
check('settings renders rotation switch (default off)', rendered.settings?.includes('启用轮换') === true)
check('settings renders tool audit switch (default on)', rendered.settings?.includes('换代后默认开启工具审计') === true && rendered.settings?.includes('仅当已安装 dsh-trace-inspect') === true)
check('settings renders binding kv', rendered.settings?.includes('sess_1') === true)
check('settings renders workspace row', rendered.settings?.includes('HtDot') === true)
check('settings renders jev fields', rendered.settings?.includes('JEV_API_KEY') === true)
check('settings renders theme options', rendered.settings?.includes('跟随 DSH') === true)
check('settings renders autoDispatch switch (default off)', rendered.settings?.includes('role="switch"') === true && rendered.settings?.includes('aria-checked="false"') === true)
check('settings renders Jev test button', rendered.settings?.includes('测试连接') === true)
check('settings apiKeyEnv defaults to TYPESAFE_API_KEY', rendered.settings?.includes('TYPESAFE_API_KEY') === true)

// ---- cleanup: dispose the transport effect so the polling timer is cleared --
for (const effect of effects) {
  try {
    if (typeof effect.disposer === 'function') effect.disposer()
  } catch { /* best effort */ }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)

function firstLine(text) {
  return text === undefined ? 'undefined' : text.slice(0, 80)
}
function countOf(text, needle) {
  if (text === undefined) return 0
  return text.split(needle).length - 1
}
