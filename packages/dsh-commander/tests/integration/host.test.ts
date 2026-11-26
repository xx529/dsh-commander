// M0 Host 集成烟测：apply() 装配 + fake 服务（契约型）→ /commander/* 请求/响应/错误码/
// 绑定持久化/懒 resume 失败 markBroken/幂等/会话事件→消息环/SSE 首帧。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../../src/host/index.ts'
import {
  createFakeCapabilityPanel,
  createFakeCtx,
  createFakeSessions,
  createFakeSessionController,
  createFakeStorageDomain,
  createFakeWebServer,
  createFakeWorkspaceRegistry,
  disposeAll,
  type FakeCtx,
  type FakeWebServer,
} from '../fakes/fakes.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'

const WORKSPACES = [
  { id: 'htdot-project', name: 'HtDot', path: '/tmp/htdot-project' },
  { id: 'dsh-commander', name: 'Commander', path: '/tmp/dsh-commander' },
]

interface Host {
  ctx: FakeCtx
  webServer: FakeWebServer
  storage: ReturnType<typeof createFakeStorageDomain>
  controller: ReturnType<typeof createFakeSessionController>
  sessionId: string
}

const tableOf = (storage: ReturnType<typeof createFakeStorageDomain>, tableName: string): Map<string, unknown> => {
  const medium = storage.mediums.get('commander')
  if (medium === undefined) throw new Error('domain not opened')
  const map = medium.get(tableName)
  if (map === undefined) throw new Error(`table ${tableName} missing`)
  return map
}

async function createHost(options: { withPanel?: boolean; sessionController?: ReturnType<typeof createFakeSessionController>; storage?: ReturnType<typeof createFakeStorageDomain> } = {}): Promise<Host> {
  const storage = options.storage ?? createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = options.sessionController ?? createFakeSessionController()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      workspaceRegistry: createFakeWorkspaceRegistry(WORKSPACES),
      sessions: createFakeSessions([{ id: 'session-existing', cwd: '/tmp/htdot-project', workspaceId: 'htdot-project' }]),
      ...(options.withPanel === true ? { capabilityPanel: createFakeCapabilityPanel() } : {}),
    },
  })
  await apply(ctx)
  return { ctx, webServer, storage, controller, sessionId: controller.nextSessionId }
}

const invoke = (host: Host, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  host.webServer.invoke(method, path, body, headers)

test('apply registers one prefix route and boots with panel absent', async () => {
  assert.equal(name, 'commander')
  assert.deepEqual(inject, ['storageDomain', 'webServer'])
  const host = await createHost()
  assert.equal(host.webServer.registrations.length, 1)
  assert.equal(host.webServer.registrations[0]?.kind, 'prefix')
  assert.equal(host.webServer.registrations[0]?.path, '/commander')
  const health = await invoke(host, 'GET', '/commander/health')
  assert.equal(health.status, 200)
  assert.deepEqual(health.body, { ok: true, version: '0.1.0', panel: 'absent', binding: 'unbound', nativeShell: 'disabled', nativeShellPid: null })
  disposeAll(host.ctx)
  assert.equal(host.webServer.registrations.length, 0)
})

test('panel with wrong shape (jev.rank/apply not functions) degrades to panel:absent at integration level (M7)', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      workspaceRegistry: createFakeWorkspaceRegistry([]),
      sessions: createFakeSessions([]),
      // 形状不符：jev.rank/apply 不是 function → resolvePanel 必须回退 absent（M1 派发前必须）
      capabilityPanel: { jev: { rank: true, apply: true } },
    },
  })
  await apply(ctx)
  const host = { ctx, webServer, storage, controller, sessionId: controller.nextSessionId }
  const health = await invoke(host, 'GET', '/commander/health')
  assert.equal(health.status, 200)
  assert.equal((health.body as { panel: string }).panel, 'absent')
  disposeAll(ctx)
})

test('health reports panel present when capabilityPanel exists', async () => {
  const host = await createHost({ withPanel: true })
  const health = await invoke(host, 'GET', '/commander/health')
  assert.equal((health.body as { panel: string }).panel, 'present')
  disposeAll(host.ctx)
})

test('snapshot contains M0 fields (binding/commanderStatus/panel/counts/tasks/workspaces/messages/busy)', async () => {
  const host = await createHost()
  const state = await invoke(host, 'GET', '/commander/state')
  assert.equal(state.status, 200)
  const body = state.body as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.commanderStatus, 'unbound')
  assert.equal(body.panel, 'absent')
  assert.equal(body.commanderBusy, false)
  assert.equal(body.commanderActivity, null)
  assert.deepEqual(body.messages, [])
  assert.deepEqual(body.pendingDispatch, null)
  assert.deepEqual(body.tasks, [])
  assert.equal(Array.isArray(body.workspaces), true)
  assert.equal((body.workspaces as unknown[]).length, 2)
  const counts = body.counts as Record<string, number>
  for (const key of ['draft', 'proposed', 'queued', 'running', 'blocked', 'review', 'done']) assert.equal(typeof counts[key], 'number')
  assert.equal(typeof body.rev, 'number')
  disposeAll(host.ctx)
})

test('PUT /commander/config merges partial patch and rejects invalid fields', async () => {
  const host = await createHost()
  const bad = await invoke(host, 'PUT', '/commander/config', { jev: { threshold: 0.1 }, requestId: 'req_cfg_bad_1' })
  assert.equal(bad.status, 400)
  assert.equal((bad.body as { code: string }).code, 'invalid_request')
  const unknownField = await invoke(host, 'PUT', '/commander/config', { nope: true, requestId: 'req_cfg_bad_2' })
  assert.equal(unknownField.status, 400)
  const ok = await invoke(host, 'PUT', '/commander/config', { jev: { workspaceThreshold: 0.85, sessionThreshold: 0.9, timeoutMs: 2000 }, ui: { theme: 'dark' }, requestId: 'req_cfg_ok_1' })
  assert.equal(ok.status, 200)
  const body = ok.body as { ok: boolean; config: { jev: { workspaceThreshold: number; sessionThreshold: number; timeoutMs: number; apiKeyEnv: string }; ui: { theme: string } } }
  assert.equal(body.ok, true)
  assert.equal(body.config.jev.workspaceThreshold, 0.85)
  assert.equal(body.config.jev.sessionThreshold, 0.9)
  assert.equal(body.config.jev.timeoutMs, 2000)
  assert.equal(body.config.jev.apiKeyEnv, 'JEV_API_KEY')
  assert.equal(body.config.ui.theme, 'dark')
  assert.equal(tableOf(host.storage, 'config').size, 1)
  disposeAll(host.ctx)
})

test('PUT /commander/config persists autoDispatch and GET exposes it', async () => {
  const host = await createHost()
  const initial = await invoke(host, 'GET', '/commander/config')
  assert.equal((initial.body as { config: { jev: { autoDispatch: boolean } } }).config.jev.autoDispatch, false)
  const saved = await invoke(host, 'PUT', '/commander/config', { jev: { autoDispatch: true }, requestId: 'req_cfg_auto_1' })
  assert.equal(saved.status, 200)
  assert.equal((saved.body as { config: { jev: { autoDispatch: boolean } } }).config.jev.autoDispatch, true)
  const after = await invoke(host, 'GET', '/commander/config')
  assert.equal((after.body as { config: { jev: { autoDispatch: boolean } } }).config.jev.autoDispatch, true)
  disposeAll(host.ctx)
})

test('GET /commander/config returns display view and reflects PUT (client settings bootstrap)', async () => {
  const host = await createHost()
  const initial = await invoke(host, 'GET', '/commander/config')
  assert.equal(initial.status, 200)
  const initialBody = initial.body as { ok: boolean; config: { jev: { workspaceThreshold: number; sessionThreshold: number; apiKeyEnv: string }; ui: { theme: string } } }
  assert.equal(initialBody.ok, true)
  assert.equal(initialBody.config.jev.workspaceThreshold, 0.8)
  assert.equal(initialBody.config.jev.sessionThreshold, 0.8)
  assert.equal(initialBody.config.jev.apiKeyEnv, 'JEV_API_KEY')
  assert.equal(initialBody.config.ui.theme, 'follow')
  await invoke(host, 'PUT', '/commander/config', { jev: { workspaceThreshold: 0.9, sessionThreshold: 0.75 }, ui: { theme: 'dark' }, requestId: 'req_cfg_get_1' })
  const after = await invoke(host, 'GET', '/commander/config')
  const afterBody = after.body as { config: { jev: { workspaceThreshold: number; sessionThreshold: number }; ui: { theme: string } } }
  assert.equal(afterBody.config.jev.workspaceThreshold, 0.9)
  assert.equal(afterBody.config.jev.sessionThreshold, 0.75)
  assert.equal(afterBody.config.ui.theme, 'dark')
  disposeAll(host.ctx)
})

test('浮窗设置：entryEnabled 默认开启，entryPos 保存/清除且越界被拒', async () => {
  const host = await createHost()
  const initial = await invoke(host, 'GET', '/commander/config')
  const initialBody = initial.body as { config: { ui: { entryEnabled?: boolean; entryPos?: unknown; nativeShell?: boolean } } }
  assert.equal(initialBody.config.ui.entryEnabled, true)
  assert.equal(initialBody.config.ui.nativeShell, true)
  assert.equal(initialBody.config.ui.entryPos, undefined)
  const saved = await invoke(host, 'PUT', '/commander/config', {
    ui: { entryEnabled: false, entryPos: { x: 0.3, y: 0.4 } }, requestId: 'req_cfg_ui_1',
  })
  assert.equal(saved.status, 200)
  const savedBody = saved.body as { config: { ui: { entryEnabled: boolean; entryPos: { x: number; y: number } } } }
  assert.equal(savedBody.config.ui.entryEnabled, false)
  assert.deepEqual(savedBody.config.ui.entryPos, { x: 0.3, y: 0.4 })
  const reset = await invoke(host, 'PUT', '/commander/config', { ui: { entryPos: null }, requestId: 'req_cfg_ui_2' })
  assert.equal(reset.status, 200)
  assert.equal((reset.body as { config: { ui: { entryPos: unknown } } }).config.ui.entryPos, null)
  const invalid = await invoke(host, 'PUT', '/commander/config', { ui: { entryPos: { x: 2, y: 0 } }, requestId: 'req_cfg_ui_3' })
  assert.equal(invalid.status, 400)
  disposeAll(host.ctx)
})

test('PUT /commander/workspaces replaces allowlist and rejects unknown workspace', async () => {
  const host = await createHost()
  const unknown = await invoke(host, 'PUT', '/commander/workspaces', { workspaces: [{ id: 'nope', allowed: true }], requestId: 'req_ws_bad_1' })
  assert.equal(unknown.status, 400)
  assert.equal((unknown.body as { code: string }).code, 'unknown_workspace')
  const ok = await invoke(host, 'PUT', '/commander/workspaces', {
    workspaces: [{ id: 'htdot-project', allowed: true, summary: '电商后台：订单/结算', policy: 'auto' }],
    requestId: 'req_ws_ok_1',
  })
  assert.equal(ok.status, 200)
  const state = await invoke(host, 'GET', '/commander/state')
  const workspaces = (state.body as { workspaces: Array<{ id: string; allowed: boolean; summary: string; policy: string }> }).workspaces
  const htdot = workspaces.find((item) => item.id === 'htdot-project')
  assert.equal(htdot?.allowed, true)
  assert.equal(htdot?.summary, '电商后台：订单/结算')
  assert.equal(htdot?.policy, 'auto')
  const commanderWs = workspaces.find((item) => item.id === 'dsh-commander')
  assert.equal(commanderWs?.allowed, false) // 未配置 → 默认
  disposeAll(host.ctx)
})

test('POST /commander/message requires binding; binding=new persists after host restart', async () => {
  const storage = createFakeStorageDomain()
  const first = await createHost({ storage })
  const unbound = await invoke(first, 'POST', '/commander/message', { text: 'hi', requestId: 'req_msg_unbound_1' })
  assert.equal(unbound.status, 409)
  assert.equal((unbound.body as { code: string }).code, 'binding_required')
  const bound = await invoke(first, 'POST', '/commander/binding', { mode: 'new', workspaceId: 'htdot-project', requestId: 'req_bind_new_1' })
  assert.equal(bound.status, 200)
  const binding = (bound.body as { binding: { sessionId: string; workspaceId: string }; commanderStatus: string })
  assert.equal(binding.commanderStatus, 'bound')
  assert.equal(binding.binding.sessionId, first.sessionId)
  assert.equal(binding.binding.workspaceId, 'htdot-project')
  assert.equal(first.controller.created.length, 1)
  assert.equal(tableOf(storage, 'sessions').size, 1)
  disposeAll(first.ctx)

  // 模拟 Host 重启：同一“介质”重建 ctx（数据来自 domain 层）
  const second = await createHost({ storage })
  const state = await invoke(second, 'GET', '/commander/state')
  const body = state.body as { commanderStatus: string; binding: { sessionId: string; workspaceId: string } }
  assert.equal(body.commanderStatus, 'bound')
  assert.equal(body.binding.sessionId, first.sessionId)
  assert.equal(body.binding.workspaceId, 'htdot-project')
  disposeAll(second.ctx)
})

test('bindNew passes workspaceId OR cwd to session.create, never both (DSH contract)', async () => {
  const host = await createHost()
  // workspaceId 分支：注册表能解析 path，但 create 只能收到 workspaceId
  const boundByWorkspace = await invoke(host, 'POST', '/commander/binding', { mode: 'new', workspaceId: 'htdot-project', requestId: 'req_bind_loc_ws_1' })
  assert.equal(boundByWorkspace.status, 200)
  const first = host.controller.created[0] ?? {}
  assert.equal(first.workspaceId, 'htdot-project')
  assert.equal('cwd' in first, false)
  // cwd 分支：未注册工作区，create 只能收到 cwd
  const host2 = await createHost()
  const boundByCwd = await invoke(host2, 'POST', '/commander/binding', { mode: 'new', cwd: '/tmp/locator-cwd', requestId: 'req_bind_loc_cwd_1' })
  assert.equal(boundByCwd.status, 200)
  const second = host2.controller.created[0] ?? {}
  assert.equal(second.cwd, '/tmp/locator-cwd')
  assert.equal('workspaceId' in second, false)
  // fake 自身按真实合同拒绝“同时传”
  await assert.rejects(() => host.controller.create({ workspaceId: 'a', cwd: '/tmp/a' }), /accepts workspaceId or cwd, not both/)
  disposeAll(host.ctx)
  disposeAll(host2.ctx)
})

test('binding new accepts cwd-only when workspace is not registered yet (isolated first-run)', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      workspaceRegistry: createFakeWorkspaceRegistry([]), // 隔离 home 首次启动：无已注册工作区
      sessions: createFakeSessions([]),
    },
  })
  await apply(ctx)
  const host = { ctx, webServer, storage, controller, sessionId: controller.nextSessionId }
  const bound = await invoke(host, 'POST', '/commander/binding', { mode: 'new', cwd: '/tmp/brand-new-workspace', requestId: 'req_bind_cwd_1' })
  assert.equal(bound.status, 200)
  const body = bound.body as { binding: { sessionId: string; workspacePath: string; workspaceId: string } }
  assert.equal(body.binding.sessionId, controller.nextSessionId)
  assert.equal(body.binding.workspacePath, '/tmp/brand-new-workspace')
  assert.equal(controller.created[0]?.cwd, '/tmp/brand-new-workspace')
  assert.equal(controller.created[0]?.workspaceId, undefined)
  disposeAll(ctx)
})

test('binding select validates existing session and workspace conflict', async () => {
  const host = await createHost()
  const conflict = await invoke(host, 'POST', '/commander/binding', { mode: 'select', workspaceId: 'dsh-commander', sessionId: 'session-existing', requestId: 'req_bind_sel_bad' })
  assert.equal(conflict.status, 409)
  assert.equal((conflict.body as { code: string }).code, 'workspace_conflict')
  const missing = await invoke(host, 'POST', '/commander/binding', { mode: 'select', sessionId: 'session-missing', requestId: 'req_bind_sel_missing' })
  assert.equal(missing.status, 404)
  assert.equal((missing.body as { code: string }).code, 'not_found')
  const ok = await invoke(host, 'POST', '/commander/binding', { mode: 'select', workspaceId: 'htdot-project', sessionId: 'session-existing', requestId: 'req_bind_sel_ok' })
  assert.equal(ok.status, 200)
  assert.equal((ok.body as { binding: { sessionId: string } }).binding.sessionId, 'session-existing')
  disposeAll(host.ctx)
})

test('message channel: prompt accepted, user echo in snapshot, idempotent requestId', async () => {
  const host = await createHost()
  await invoke(host, 'POST', '/commander/binding', { mode: 'new', workspaceId: 'htdot-project', requestId: 'req_bind_msg_1' })
  const sent = await invoke(host, 'POST', '/commander/message', { text: '只回一句：m0-ok', requestId: 'req_msg_send_1' })
  assert.equal(sent.status, 200)
  const body = sent.body as { ok: boolean; accepted: boolean; messageId: string; sessionId: string; rev: number }
  assert.equal(body.ok, true)
  assert.equal(body.accepted, true)
  assert.equal(body.messageId, 'req_msg_send_1')
  assert.equal(body.sessionId, host.sessionId)
  assert.equal(host.controller.prompts.length, 1)
  assert.equal(host.controller.prompts[0]?.mode, 'queue')
  // signal 必填第二参（V1/V3 实测；devops 抓到漏传 → throwIfAborted）
  assert.equal(host.controller.prompts[0]?.signal instanceof AbortSignal, true)
  assert.deepEqual(host.controller.prompts[0]?.content, [{ type: 'text', text: '只回一句：m0-ok' }])
  const repeated = await invoke(host, 'POST', '/commander/message', { text: '只回一句：m0-ok', requestId: 'req_msg_send_1' })
  assert.equal(repeated.status, 200)
  assert.equal(host.controller.prompts.length, 1) // 幂等：不重复 prompt
  const state = await invoke(host, 'GET', '/commander/state')
  const messages = (state.body as { messages: Array<{ messageId: string; role: string; order: number; text: string }> }).messages
  assert.deepEqual(messages.map((message) => message.messageId), ['req_msg_send_1'])
  assert.equal(messages[0]?.role, 'user')
  disposeAll(host.ctx)
})

test('user echo order is assigned before awaiting prompt (M5: assistant arriving during prompt must not invert order)', async () => {
  const host = await createHost()
  await invoke(host, 'POST', '/commander/binding', { mode: 'new', cwd: '/tmp/m0-order', requestId: 'req_bind_order_1' })
  const realPrompt = host.controller.prompt
  host.controller.prompt = async (request) => {
    // 模拟真实场景：prompt await 期间 assistant 事件先到
    host.ctx.emit('session/event', { id: host.sessionId }, { seq: 30, type: 'assistant/message', time: 100, data: { turn: 1, message: { content: [{ type: 'text', text: 'early-reply' }] } } })
    return realPrompt !== undefined ? realPrompt.call(host.controller, request) : { accepted: true }
  }
  const sent = await invoke(host, 'POST', '/commander/message', { text: 'hi', requestId: 'req_msg_order_1' })
  assert.equal(sent.status, 200)
  const state = await invoke(host, 'GET', '/commander/state')
  const messages = (state.body as { messages: Array<{ messageId: string; role: string; order: number }> }).messages
  assert.deepEqual(messages.map((message) => [message.role, message.order]), [['user', 1], ['assistant', 2]])
})

test('session/event subscription: assistant text → message ring; turn events → commanderBusy', async () => {
  const host = await createHost()
  await invoke(host, 'POST', '/commander/binding', { mode: 'new', workspaceId: 'htdot-project', requestId: 'req_bind_evt_1' })
  host.ctx.emit('session/event', { id: host.sessionId }, { seq: 10, type: 'turn/start', time: 100, data: { turn: 3 } })
  // 气泡活动：tool/call 参数里的 description 优先展示。
  host.ctx.emit('session/event', { id: host.sessionId }, {
    seq: 11,
    type: 'tool/call',
    time: 150,
    data: { turn: 3, callId: 'call_1', name: 'bash', arguments: '{"description":"查看当前目录","command":"ls"}' },
  })
  let state = await invoke(host, 'GET', '/commander/state')
  let body = state.body as { messages: unknown[]; commanderBusy: boolean; commanderActivity: { text: string } | null }
  assert.equal(body.commanderBusy, true)
  assert.deepEqual(body.messages, [])
  assert.deepEqual(body.commanderActivity, { text: '查看当前目录', at: 150 })
  // 没有 description 的工具调用：跳过，保留上一条活动。
  host.ctx.emit('session/event', { id: host.sessionId }, {
    seq: 12,
    type: 'tool/call',
    time: 160,
    data: { turn: 3, callId: 'call_2', name: 'bash', arguments: '{"command":"pwd"}' },
  })
  state = await invoke(host, 'GET', '/commander/state')
  assert.deepEqual((state.body as { commanderActivity: { text: string } | null }).commanderActivity, { text: '查看当前目录', at: 150 })
  // 工具调用之间的 assistant 文本也进入活动。
  host.ctx.emit('session/event', { id: host.sessionId }, {
    seq: 13,
    type: 'assistant/message',
    time: 200,
    data: { turn: 3, message: { content: [{ type: 'text', text: 'm0-ok' }] } },
  })
  state = await invoke(host, 'GET', '/commander/state')
  body = state.body as typeof body
  assert.equal(body.commanderBusy, true)
  assert.equal(body.messages.length, 1)
  assert.deepEqual(body.commanderActivity, { text: 'm0-ok', at: 200 })
  const messages = body.messages as Array<{ messageId: string; role: string; text: string; turnId?: number; seq?: number }>
  assert.equal(messages[0]?.messageId, 'asst_3_13')
  assert.equal(messages[0]?.role, 'assistant')
  assert.equal(messages[0]?.text, 'm0-ok')
  assert.equal(messages[0]?.turnId, 3)
  // 同一事件重复投递：去重
  host.ctx.emit('session/event', { id: host.sessionId }, { seq: 13, type: 'assistant/message', time: 200, data: { turn: 3, message: { content: [{ type: 'text', text: 'm0-ok' }] } } })
  state = await invoke(host, 'GET', '/commander/state')
  assert.equal((state.body as { messages: unknown[] }).messages.length, 1)
  host.ctx.emit('session/event', { id: host.sessionId }, { seq: 14, type: 'turn/end', time: 300, data: { turn: 3, reason: { kind: 'completed' } } })
  state = await invoke(host, 'GET', '/commander/state')
  assert.equal((state.body as { commanderBusy: boolean }).commanderBusy, false)
  assert.equal((state.body as { commanderActivity: unknown }).commanderActivity, null)
  // 非绑定会话的事件不进入消息环
  host.ctx.emit('session/event', { id: 'other-session' }, { seq: 15, type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: 'nope' }] } } })
  state = await invoke(host, 'GET', '/commander/state')
  assert.equal((state.body as { messages: unknown[] }).messages.length, 1)
  disposeAll(host.ctx)
})

test('commander.status SSE carries tool description activity', async () => {
  const host = await createHost()
  await invoke(host, 'POST', '/commander/binding', { mode: 'new', workspaceId: 'htdot-project', requestId: 'req_bind_activity_1' })
  const stream = await invoke(host, 'GET', '/commander/state', undefined, { accept: 'text/event-stream' })
  host.ctx.emit('session/event', { id: host.sessionId }, { seq: 20, type: 'turn/start', time: 400, data: { turn: 4 } })
  host.ctx.emit('session/event', { id: host.sessionId }, {
    seq: 21,
    type: 'tool/call',
    time: 450,
    data: { turn: 4, callId: 'call_1', name: 'bash', arguments: '{"description":"查看当前目录"}' },
  })
  const frames = stream.events.join('')
  assert.match(frames, /event: commander\.status/)
  assert.match(frames, /"activity":\{"text":"查看当前目录","at":450\}/)
  disposeAll(host.ctx)
})

test('generic prompt failure keeps binding bound (credential/param errors are retryable)', async () => {
  const controller = createFakeSessionController()
  controller.promptError = new Error('MISSING_CREDENTIAL: no provider key')
  const host = await createHost({ sessionController: controller })
  await invoke(host, 'POST', '/commander/binding', { mode: 'new', cwd: '/tmp/m0-generic', requestId: 'req_bind_generic_1' })
  const failed = await invoke(host, 'POST', '/commander/message', { text: 'hi', requestId: 'req_msg_generic_1' })
  assert.equal(failed.status, 502)
  assert.equal((failed.body as { code: string }).code, 'prompt_failed')
  const health = await invoke(host, 'GET', '/commander/health')
  assert.equal((health.body as { binding: string }).binding, 'bound')
  // 可重试（不因非会话级错误打死绑定）
  controller.promptError = undefined
  const retried = await invoke(host, 'POST', '/commander/message', { text: 'hi again', requestId: 'req_msg_generic_2' })
  assert.equal(retried.status, 200)
  assert.equal(controller.prompts.length, 2)
  disposeAll(host.ctx)
})

test('prompt failure with session/writer-held marks binding broken and later sends return binding_broken', async () => {
  const controller = createFakeSessionController()
  controller.promptError = new Error('session/writer-held: another writer holds the session')
  const host = await createHost({ sessionController: controller })
  await invoke(host, 'POST', '/commander/binding', { mode: 'new', cwd: '/tmp/m0-broken', requestId: 'req_bind_broken_1' })
  const failed = await invoke(host, 'POST', '/commander/message', { text: 'hi', requestId: 'req_msg_fail_1' })
  assert.equal(failed.status, 502)
  assert.equal((failed.body as { code: string }).code, 'prompt_failed')
  const health = await invoke(host, 'GET', '/commander/health')
  assert.equal((health.body as { binding: string }).binding, 'broken')
  const afterBroken = await invoke(host, 'POST', '/commander/message', { text: 'hi', requestId: 'req_msg_fail_2' })
  assert.equal(afterBroken.status, 409)
  assert.equal((afterBroken.body as { code: string }).code, 'binding_broken')
  // 不自动新建会话；失败消息不进消息环
  assert.equal(controller.created.length, 1)
  const state = await invoke(host, 'GET', '/commander/state')
  assert.deepEqual((state.body as { messages: unknown[] }).messages, [])
  disposeAll(host.ctx)
})

test('GET /commander/state with Accept: text/event-stream returns SSE snapshot frame', async () => {
  const host = await createHost()
  const sse = await invoke(host, 'GET', '/commander/state', undefined, { accept: 'text/event-stream' })
  assert.ok(sse.events.length >= 1)
  assert.match(sse.events[0] ?? '', /event: snapshot/)
  assert.match(sse.events[0] ?? '', /"commanderStatus":"unbound"/)
  disposeAll(host.ctx)
  assert.match(sse.events.at(-1) ?? '', /event: bye/)
})

test('unknown route → 404, unknown method → 405, invalid JSON → 400', async () => {
  const host = await createHost()
  const notFound = await invoke(host, 'GET', '/commander/nope')
  assert.equal(notFound.status, 404)
  const method = await invoke(host, 'DELETE', '/commander/health')
  assert.equal(method.status, 405)
  const badJson = await invoke(host, 'PUT', '/commander/config', '{not json')
  assert.equal(badJson.status, 400)
  disposeAll(host.ctx)
})

test('domain spec declares 7 required tables incl board_edits', () => {
  assert.deepEqual(Object.keys(commanderDomainSpec.tables).sort(), ['board_edits', 'commands', 'config', 'dispatches', 'sessions', 'tasks', 'workspaces'])
  assert.equal(commanderDomainSpec.name, 'commander')
  assert.equal(commanderDomainSpec.version, 1)
  assert.equal(commanderDomainSpec.layout, 'per-record') // ARCHITECTURE §3.1/plan §4.1：缺省会被按 single 打开
})
