// R1：会话轮换（门控 / 提交 / 退役 / 回滚 / 触发 / 路由），契约 §3/§7/§8。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import type { TaskRecord } from '../../src/host/schema.ts'
import {
  createFakeAgents,
  createFakeCtx,
  createFakeSchedule,
  createFakeSessionController,
  createFakeStorageDomain,
  createFakeWebServer,
  createFakeWorkspaceRegistry,
} from '../fakes/fakes.ts'

const DAY = 86_400_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 换代会给新会话探测 dsh-trace-inspect 的本机审计路由。这里起一个本机 HTTP 桩，
// 把 DSH_WEB_URL 指过去（Host 用它拼审计 origin）；缺省回 404（等价未安装）。
// 这样既不碰 live DSH，也不用等真实超时。
const ORIGINAL_DSH_WEB_URL = process.env.DSH_WEB_URL
let auditResponder: (url: URL) => { status: number; body?: unknown } = () => ({ status: 404, body: { error: 'session not found' } })
const auditCalls: Array<{ method: string; url: URL; body: string }> = []
const auditServer = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    auditCalls.push({ method: req.method ?? '', url, body })
    const result = auditResponder(url)
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result.body ?? {}))
  })
})
await new Promise<void>((resolve) => auditServer.listen(0, '127.0.0.1', () => resolve()))
process.env.DSH_WEB_URL = `http://127.0.0.1:${(auditServer.address() as AddressInfo).port}`
test.after(async () => {
  await new Promise<void>((resolve) => auditServer.close(() => resolve()))
  if (ORIGINAL_DSH_WEB_URL === undefined) delete process.env.DSH_WEB_URL
  else process.env.DSH_WEB_URL = ORIGINAL_DSH_WEB_URL
})

interface SetupOptions {
  events?: Array<Record<string, unknown>>
  /** 假 sessions.get 返回的 cwd；用于 bindSelect 的工作区归属推断。 */
  sessionCwd?: string
  /** 可选 schedule fake；不传则 ctx.get('schedule') 为空（迁移 unavailable）。 */
  schedule?: unknown
}

async function setup(options: SetupOptions = {}) {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const agents = createFakeAgents()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      agents,
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-a', name: 'A', path: '/tmp/a' }]),
      sessions: {
        async get(sessionId: string) {
          return {
            id: sessionId,
            ...(options.sessionCwd !== undefined ? { cwd: options.sessionCwd } : {}),
            events: options.events ?? [],
          }
        },
      },
      ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    },
  })
  await apply(ctx)
  const stores = createStores(await storage.open(commanderDomainSpec))
  return { storage, webServer, controller, agents, ctx, stores }
}

interface SeedOptions {
  enabled?: boolean
  periodDays?: number
  generation?: number
  startedAt?: number
  sessionId?: string
  workspaceId?: string
  toolAudit?: boolean
}

async function seedBound(host: Awaited<ReturnType<typeof setup>>, options: SeedOptions = {}): Promise<void> {
  const sessionId = options.sessionId ?? 'session-old'
  const workspaceId = options.workspaceId ?? 'ws-a'
  const startedAt = options.startedAt ?? Date.now() - 2 * DAY
  await host.stores.config.update((current) => ({
    ...current,
    commander: {
      workspaceId,
      workspacePath: '/tmp/a',
      sessionId,
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      rotation: {
        enabled: options.enabled ?? true,
        periodDays: options.periodDays ?? 1,
        includeUserTail: true,
        ...(options.toolAudit !== undefined ? { toolAudit: options.toolAudit } : {}),
        generation: options.generation ?? 2,
        generationStartedAt: startedAt,
      },
    },
  }))
  await host.stores.sessions.upsert({
    v: 1,
    sessionId,
    workspaceId,
    taskId: '',
    role: 'commander',
    mode: 'new',
    createdAt: startedAt,
    generation: options.generation ?? 2,
    status: 'idle',
  })
  host.agents.add(sessionId)
}

function seedTask(stores: Awaited<ReturnType<typeof setup>>['stores'], overrides: Partial<TaskRecord> & { id: string }): void {
  const now = Date.now()
  void stores.tasks.put({
    v: 1,
    title: `任务 ${overrides.id}`,
    goal: '',
    status: 'running',
    workspaceId: 'ws-a',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [],
    version: 1,
    createdAt: now - DAY,
    updatedAt: now - 60_000,
    lastActivityAt: now - 60_000,
    ...overrides,
  })
}

async function enableForActivity(host: Awaited<ReturnType<typeof setup>>): Promise<void> {
  seedTask(host.stores, { id: 'task-active', status: 'running' })
}

test('rotation: 关闭态 → 409 rotation_disabled，快照 due=false', async () => {
  const host = await setup()
  await seedBound(host, { enabled: false })
  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_disabled' })
  assert.equal(response.status, 409)
  assert.equal((response.body as { code: string }).code, 'rotation_disabled')
  const state = await host.webServer.invoke('GET', '/commander/state')
  const body = state.body as { rotation: { enabled: boolean; due: boolean }; formerCommanders: unknown[] }
  assert.equal(body.rotation.enabled, false)
  assert.equal(body.rotation.due, false)
  assert.deepEqual(body.formerCommanders, [])
})

test('rotation: force 成功 → create→inject→config→旧 retired/新 link，简报为 commander-handoff', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-new'
  host.agents.add('session-new')

  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_1', force: true })
  assert.equal(response.status, 200)
  const body = response.body as { rotated: boolean; generation: number; sessionId: string; brief: { chars: number; unfinished: number } }
  assert.equal(body.rotated, true)
  assert.equal(body.generation, 3)
  assert.equal(body.sessionId, 'session-new')
  assert.ok(body.brief.chars > 0)
  assert.equal(body.brief.unfinished, 1)

  // create 用绑定工作区（不是 cwd）
  assert.deepEqual(host.controller.created[0], { workspaceId: 'ws-a' })
  // 新会话标题 = 第 N 任 · 换任当天（本地日期）
  assert.equal(host.controller.renames.length, 1)
  assert.equal(host.controller.renames[0]?.sessionId, 'session-new')
  assert.match(host.controller.renames[0]?.title ?? '', /^第 3 任 · \d{4}-\d{2}-\d{2}$/)
  // 模型跟随旧任
  assert.equal(host.controller.modelSelections[0]?.sessionId, 'session-new')
  // inject 一份交接简报
  const injected = host.agents.get('session-new')?.injected ?? []
  assert.equal(injected.length, 1)
  const message = injected[0] as { role: string; source: Record<string, unknown>; content: Array<{ text: string }> }
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'commander-handoff')
  assert.equal(message.source.generation, 2)
  assert.match(message.content[0].text, /^<system-reminder>\n\[commander-handoff\] 第 2 任交接简报/)
  assert.match(message.content[0].text, /#task-active/)

  // 新绑定 + 旧 retired（不是 missing）
  const config = host.stores.config.get()
  assert.equal(config.commander.sessionId, 'session-new')
  assert.equal(config.commander.rotation?.generation, 3)
  const old = host.stores.sessions.list().find((link) => link.sessionId === 'session-old')
  assert.equal(old?.status, 'retired')
  assert.ok(typeof old?.retiredAt === 'number')
  const fresh = host.stores.sessions.list().find((link) => link.sessionId === 'session-new')
  assert.equal(fresh?.role, 'commander')
  assert.equal(fresh?.generation, 3)
  assert.equal(fresh?.status, 'idle')

  // 快照暴露 rotation + formerCommanders
  const state = await host.webServer.invoke('GET', '/commander/state')
  const snapshot = state.body as { rotation: { generation: number; due: boolean }; formerCommanders: Array<{ sessionId: string; generation: number }> }
  assert.equal(snapshot.rotation.generation, 3)
  assert.equal(snapshot.rotation.due, false)
  assert.deepEqual(snapshot.formerCommanders.map((item) => item.sessionId), ['session-old'])
  assert.equal(snapshot.formerCommanders[0]?.generation, 2)
})

test('rotation: create 失败 → 502 rotation_failed，旧绑定不变、不退役、不 markBroken', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.failCreate = new Error('create boom')
  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_fail', force: true })
  assert.equal(response.status, 502)
  assert.equal((response.body as { code: string }).code, 'rotation_failed')
  assert.equal(host.stores.config.get().commander.sessionId, 'session-old')
  const old = host.stores.sessions.list().find((link) => link.sessionId === 'session-old')
  assert.equal(old?.status, 'idle')
  const state = await host.webServer.invoke('GET', '/commander/state')
  const snapshot = state.body as { rotation: { lastError?: { code: string } }; commanderStatus: string }
  assert.equal(snapshot.rotation.lastError?.code, 'rotation_failed')
  assert.equal(snapshot.commanderStatus, 'bound')
})

test('rotation: 标题改名失败只记 warn，交接照常提交（标题非提交条件）', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-title-fail'
  host.agents.add('session-title-fail')
  host.controller.failRename = new Error('title boom')
  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_title', force: true })
  assert.equal(response.status, 200)
  assert.equal((response.body as { rotated: boolean }).rotated, true)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-title-fail')
  // 简报照常注入，旧任照常退役
  assert.equal(host.agents.get('session-title-fail')?.injected.length, 1)
  const old = host.stores.sessions.list().find((link) => link.sessionId === 'session-old')
  assert.equal(old?.status, 'retired')
})

test('rotation: 换代默认给新会话预置工具审计（dsh-trace-inspect）', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-audit'
  host.agents.add('session-audit')
  auditCalls.length = 0
  auditResponder = () => ({ status: 200, body: { enabled: true, sealed: false } })
  try {
    const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_audit', force: true })
    assert.equal(response.status, 200)
    assert.equal(auditCalls.length, 1)
    const call = auditCalls[0]!
    assert.equal(call.method, 'POST')
    assert.equal(call.url.pathname, '/trace-inspect/api/tool-audit')
    assert.equal(call.url.searchParams.get('sessionId'), 'session-audit')
    assert.deepEqual(JSON.parse(call.body), { enabled: true })
  } finally {
    auditResponder = () => ({ status: 404, body: { error: 'session not found' } })
  }
})

test('rotation: 关闭 toolAudit（或审计路由 404）都不影响换代', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  // 显式关闭：不探测
  await host.stores.config.update((current) => ({
    ...current,
    commander: {
      ...current.commander,
      rotation: { ...(current.commander.rotation as NonNullable<typeof current.commander.rotation>), toolAudit: false },
    },
  }))
  host.controller.nextSessionId = 'session-audit-off'
  host.agents.add('session-audit-off')
  auditCalls.length = 0
  const off = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_audit_off', force: true })
  assert.equal(off.status, 200)
  assert.equal(auditCalls.length, 0)
  // 写回不能把 toolAudit=false 丢掉（否则下次读取回默认 true）
  assert.equal(host.stores.config.get().commander.rotation?.toolAudit, false)

  // 默认开启但插件缺失（404）：换代照常提交
  await host.stores.config.update((current) => ({
    ...current,
    commander: {
      ...current.commander,
      rotation: { ...(current.commander.rotation as NonNullable<typeof current.commander.rotation>), toolAudit: true },
    },
  }))
  host.controller.nextSessionId = 'session-audit-404'
  host.agents.add('session-audit-404')
  const missing = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_audit_404', force: true })
  assert.equal(missing.status, 200)
  assert.equal((missing.body as { rotated: boolean }).rotated, true)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-audit-404')
})

test('rotation: 新会话没有 live agent → 502，不写 config（简报未注入时不提交）', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-orphan'
  // 不注册 session-orphan 的 agent
  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_noagent', force: true })
  assert.equal(response.status, 502)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-old')
})

test('rotation: busy / pendingDispatch 时 409 rotation_busy', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  // turn/start 让 busy=true
  host.ctx.emit('session/event', { id: 'session-old' }, { type: 'turn/start', data: { turn: 9 } })
  const busy = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_busy', force: true })
  assert.equal(busy.status, 409)
  assert.equal((busy.body as { code: string }).code, 'rotation_busy')
  host.ctx.emit('session/event', { id: 'session-old' }, { type: 'turn/end', data: { turn: 9, reason: 'completed' } })
})

test('rotation: 未到点返回 rotated=false/not_due；到点但无活动返回 no_activity', async () => {
  const host = await setup()
  await seedBound(host, { startedAt: Date.now() - 1_000 })
  const notDue = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_notdue', force: false })
  assert.equal(notDue.status, 200)
  assert.equal((notDue.body as { rotated: boolean; reason: string }).rotated, false)
  assert.equal((notDue.body as { reason: string }).reason, 'not_due')

  // 到点但本周期没有任何活动
  await host.stores.config.update((current) => ({
    ...current,
    commander: {
      ...current.commander,
      rotation: { ...(current.commander.rotation as NonNullable<typeof current.commander.rotation>), generationStartedAt: Date.now() - 2 * DAY },
    },
  }))
  const noActivity = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_noact', force: false })
  assert.equal(noActivity.status, 200)
  assert.equal((noActivity.body as { rotated: boolean; reason: string }).reason, 'no_activity')
  assert.equal(host.controller.created.length, 0)
})

test('rotation: turn/end 一级触发（异步、只认指挥官会话）', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-turn-end'
  host.agents.add('session-turn-end')
  // 非指挥官会话：不触发
  host.ctx.emit('session/event', { id: 'session-work-9' }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  await sleep(30)
  assert.equal(host.controller.created.length, 0)
  // 指挥官会话：触发
  host.ctx.emit('session/event', { id: 'session-old' }, { type: 'turn/end', data: { turn: 2, reason: 'completed' } })
  await sleep(80)
  assert.equal(host.controller.created.length, 1)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-turn-end')
})

test('rotation: 投递前兜底 → 消息落到新会话（并保留用户 echo）', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-msg'
  host.agents.add('session-msg')
  const response = await host.webServer.invoke('POST', '/commander/message', { text: '今天做什么', requestId: 'req_msg_1' })
  assert.equal(response.status, 200)
  assert.equal((response.body as { sessionId: string }).sessionId, 'session-msg')
  assert.equal(host.controller.prompts[0]?.sessionId, 'session-msg')
  const state = await host.webServer.invoke('GET', '/commander/state')
  const messages = (state.body as { messages: Array<{ role: string; text: string }> }).messages
  assert.ok(messages.some((message) => message.role === 'user' && message.text === '今天做什么'))
})

test('rotation: 手动「绑定到新会话」不生成简报（D1），但按换代应用标题与工具审计', async () => {
  const host = await setup()
  await seedBound(host, { enabled: true })
  host.controller.nextSessionId = 'session-manual'
  host.agents.add('session-manual')
  auditCalls.length = 0
  auditResponder = () => ({ status: 200, body: { enabled: true, sealed: false } })
  try {
    const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
    assert.equal(response.status, 200)
    // D1：手动绑定仍不注入交接简报
    assert.equal(host.agents.get('session-manual')?.injected.length, 0)
    // B2：标题与工具审计按换代默认应用（不是只改数据不应用副作用）
    assert.equal(host.controller.renames.length, 1)
    assert.equal(host.controller.renames[0]?.sessionId, 'session-manual')
    assert.match(host.controller.renames[0]?.title ?? '', /^第 3 任 · \d{4}-\d{2}-\d{2}$/)
    assert.equal(auditCalls.length, 1)
    assert.equal(auditCalls[0]?.method, 'POST')
    assert.equal(auditCalls[0]?.url.pathname, '/trace-inspect/api/tool-audit')
    assert.equal(auditCalls[0]?.url.searchParams.get('sessionId'), 'session-manual')
    assert.deepEqual(JSON.parse(auditCalls[0]?.body ?? '{}'), { enabled: true })
    // 代际递增、起始时间重置
    const config = host.stores.config.get()
    assert.equal(config.commander.sessionId, 'session-manual')
    assert.equal(config.commander.rotation?.generation, 3)
  } finally {
    auditResponder = () => ({ status: 404, body: { error: 'session not found' } })
  }
})

test('rotation: 轮换关闭时，手动「绑定到新会话」保持现状（不设标题、不预置审计）', async () => {
  const host = await setup()
  await seedBound(host, { enabled: false })
  host.controller.nextSessionId = 'session-manual-off'
  host.agents.add('session-manual-off')
  auditCalls.length = 0
  const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
  assert.equal(response.status, 200)
  assert.equal(host.controller.renames.length, 0)
  assert.equal(auditCalls.length, 0)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-manual-off')
})

test('rotation: 手动「绑定到新会话」首次绑定写「第 1 任」标题并预置审计', async () => {
  const host = await setup()
  await host.stores.config.update((current) => ({
    ...current,
    commander: {
      ...current.commander,
      rotation: { ...(current.commander.rotation as NonNullable<typeof current.commander.rotation>), enabled: true },
    },
  }))
  host.controller.nextSessionId = 'session-first'
  host.agents.add('session-first')
  auditCalls.length = 0
  auditResponder = () => ({ status: 200, body: { enabled: true, sealed: false } })
  try {
    const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
    assert.equal(response.status, 200)
    assert.equal(host.controller.renames.length, 1)
    assert.match(host.controller.renames[0]?.title ?? '', /^第 1 任 · \d{4}-\d{2}-\d{2}$/)
    assert.equal(auditCalls.length, 1)
    assert.equal(host.stores.config.get().commander.rotation?.generation, 1)
  } finally {
    auditResponder = () => ({ status: 404, body: { error: 'session not found' } })
  }
})

test('rotation: 手动绑定尊重 toolAudit=false（不发审计、照写标题、写回不丢字段）', async () => {
  const host = await setup()
  await seedBound(host, { enabled: true, toolAudit: false })
  host.controller.nextSessionId = 'session-manual-no-audit'
  host.agents.add('session-manual-no-audit')
  auditCalls.length = 0
  const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
  assert.equal(response.status, 200)
  assert.equal(auditCalls.length, 0)
  assert.equal(host.controller.renames.length, 1)
  const config = host.stores.config.get()
  assert.equal(config.commander.rotation?.toolAudit, false)
  assert.equal(config.commander.rotation?.generation, 3)
})

test('rotation: 手动绑定审计失败不阻断，标题照写', async () => {
  const host = await setup()
  await seedBound(host, { enabled: true })
  host.controller.nextSessionId = 'session-manual-audit-fail'
  host.agents.add('session-manual-audit-fail')
  auditCalls.length = 0
  auditResponder = () => ({ status: 500, body: { error: 'boom' } })
  try {
    const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
    assert.equal(response.status, 200)
    assert.equal(auditCalls.length, 1)
    assert.equal(host.controller.renames.length, 1)
    assert.equal(host.stores.config.get().commander.sessionId, 'session-manual-audit-fail')
  } finally {
    auditResponder = () => ({ status: 404, body: { error: 'session not found' } })
  }
})

test('rotation: 手动绑定 rename 失败不阻断，审计照发', async () => {
  const host = await setup()
  await seedBound(host, { enabled: true })
  host.controller.nextSessionId = 'session-manual-title-fail'
  host.agents.add('session-manual-title-fail')
  host.controller.failRename = new Error('title boom')
  auditCalls.length = 0
  const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
  assert.equal(response.status, 200)
  assert.equal(host.controller.renames.length, 0)
  assert.equal(auditCalls.length, 1)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-manual-title-fail')
})

test('rotation: 「选择已有会话」不设标题、不预置审计', async () => {
  const host = await setup({ sessionCwd: '/tmp/a' })
  await seedBound(host, { enabled: true })
  auditCalls.length = 0
  const response = await host.webServer.invoke('POST', '/commander/binding', {
    mode: 'select',
    workspaceId: 'ws-a',
    sessionId: 'session-existing',
  })
  assert.equal(response.status, 200)
  assert.equal(host.controller.renames.length, 0)
  assert.equal(auditCalls.length, 0)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-existing')
})

test('rotation: 配置校验（periodDays 1..7；generation 由 Host 管理；config 视图回显）', async () => {
  const host = await setup()
  const tooLong = await host.webServer.invoke('PUT', '/commander/config', { requestId: 'req_cfg_bad', commander: { rotation: { periodDays: 8 } } })
  assert.equal(tooLong.status, 400)
  assert.equal((tooLong.body as { field: string }).field, 'commander.rotation.periodDays')
  const managed = await host.webServer.invoke('PUT', '/commander/config', { requestId: 'req_cfg_gen', commander: { rotation: { generation: 9 } } })
  assert.equal(managed.status, 400)
  const enabled = await host.webServer.invoke('PUT', '/commander/config', { requestId: 'req_cfg_ok', commander: { rotation: { enabled: true, periodDays: 3, includeUserTail: false } } })
  assert.equal(enabled.status, 200)
  const config = host.stores.config.get()
  assert.equal(config.commander.rotation?.enabled, true)
  assert.equal(config.commander.rotation?.periodDays, 3)
  assert.equal(config.commander.rotation?.includeUserTail, false)
  assert.ok((config.commander.rotation?.generationStartedAt ?? 0) > 0)
  const view = await host.webServer.invoke('GET', '/commander/config')
  const body = view.body as { config: { commander: { rotation: { enabled: boolean; periodDays: number; toolAudit: boolean } } } }
  assert.equal(body.config.commander.rotation.enabled, true)
  assert.equal(body.config.commander.rotation.periodDays, 3)
  // toolAudit 默认 true，可显式关闭并回显
  assert.equal(body.config.commander.rotation.toolAudit, true)
  const auditOff = await host.webServer.invoke('PUT', '/commander/config', { requestId: 'req_cfg_audit', commander: { rotation: { toolAudit: false } } })
  assert.equal(auditOff.status, 200)
  assert.equal(host.stores.config.get().commander.rotation?.toolAudit, false)
  const auditBad = await host.webServer.invoke('PUT', '/commander/config', { requestId: 'req_cfg_audit_bad', commander: { rotation: { toolAudit: 'yes' } } })
  assert.equal(auditBad.status, 400)
  assert.equal((auditBad.body as { field: string }).field, 'commander.rotation.toolAudit')
})

test('rotation: 并发触发只换一次（一个 200、一个 409 rotation_busy）', async () => {
  const host = await setup()
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-race'
  host.agents.add('session-race')
  const [first, second] = await Promise.all([
    host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_race_1', force: true }),
    host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_race_2', force: true }),
  ])
  const statuses = [first.status, second.status].sort((a, b) => a - b)
  assert.deepEqual(statuses, [200, 409])
  const busy = [first, second].find((item) => item.status === 409)
  assert.equal((busy?.body as { code: string }).code, 'rotation_busy')
  assert.equal(host.controller.created.length, 1)
  assert.equal(host.stores.config.get().commander.sessionId, 'session-race')
})

test('rotation: 简报窗口至少覆盖一个周期（刚启用/刚换任也不会丢掉当天任务）', async () => {
  const host = await setup()
  // 本任 1 小时前开始，任务 2 小时前更新（早于本任起点，但仍在 1 天周期内）
  await seedBound(host, { startedAt: Date.now() - 3_600_000 })
  seedTask(host.stores, { id: 'task-today', status: 'done', updatedAt: Date.now() - 2 * 3_600_000, lastActivityAt: Date.now() - 2 * 3_600_000 })
  host.controller.nextSessionId = 'session-window'
  host.agents.add('session-window')
  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_window', force: true })
  assert.equal(response.status, 200)
  const message = (host.agents.get('session-window')?.injected[0] ?? {}) as { content?: Array<{ text?: string }> }
  const text = message.content?.[0]?.text ?? ''
  assert.match(text, /#task-today/)
  assert.match(text, /本周期任务（1 条）：/)
  // 页脚不再引导去打开旧任会话
  assert.doesNotMatch(text, /打开第 1 任会话/)
})

// ---------------------------------------------------------------- R1 schedule 跟随迁移
test('rotation: 手动换代迁移旧 commander 名下 active/paused/ended，其他会话完全不变', async () => {
  const other = {
    id: 'other-task',
    status: 'active' as const,
    updatedAt: 'u-other',
    target: { kind: 'session' as const, sessionId: 'session-other' },
  }
  const beforeOther = structuredClone(other)
  const schedule = createFakeSchedule([
    { id: 'old-active', status: 'active', updatedAt: 'u-a', target: { kind: 'session', sessionId: 'session-old' } },
    { id: 'old-paused', status: 'paused', updatedAt: 'u-p', target: { kind: 'session', sessionId: 'session-old' } },
    { id: 'old-ended', status: 'ended', updatedAt: 'u-e', target: { kind: 'session', sessionId: 'session-old' } },
    other,
    { id: 'new-target', status: 'active', updatedAt: 'u-n', target: { kind: 'new' } },
    { id: 'new-once', status: 'active', updatedAt: 'u-o', target: { kind: 'new_once', sessionId: 'session-reserved' } },
  ])
  const host = await setup({ schedule: schedule.service })
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-new-sched'
  host.agents.add('session-new-sched')

  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_sched_1', force: true })
  assert.equal(response.status, 200)
  const body = response.body as {
    rotated: boolean
    sessionId: string
    scheduleMigration: { status: string; matched: number; migrated: number; failed: unknown[] }
  }
  assert.equal(body.rotated, true)
  assert.equal(body.sessionId, 'session-new-sched')
  assert.equal(body.scheduleMigration.status, 'ok')
  assert.equal(body.scheduleMigration.matched, 3)
  assert.equal(body.scheduleMigration.migrated, 3)
  assert.equal(body.scheduleMigration.failed.length, 0)

  for (const id of ['old-active', 'old-paused', 'old-ended']) {
    assert.deepEqual(schedule.entries.get(id)?.target, { kind: 'session', sessionId: 'session-new-sched' })
  }
  assert.equal(schedule.entries.get('old-active')?.status, 'active')
  assert.equal(schedule.entries.get('old-paused')?.status, 'paused')
  assert.equal(schedule.entries.get('old-ended')?.status, 'ended')
  // 反例：别的会话任务必须连 updatedAt 都不变
  assert.deepEqual(schedule.entries.get('other-task'), beforeOther)
  assert.deepEqual(schedule.entries.get('new-target')?.target, { kind: 'new' })
  assert.deepEqual(schedule.entries.get('new-once')?.target, { kind: 'new_once', sessionId: 'session-reserved' })
  assert.equal(schedule.edits.length, 3)
})

test('rotation: turn/end 自动换代也迁移旧 commander 的定时任务', async () => {
  const schedule = createFakeSchedule([
    { id: 'old-active', status: 'active', updatedAt: 'u-a', target: { kind: 'session', sessionId: 'session-old' } },
  ])
  const host = await setup({ schedule: schedule.service })
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-turn-sched'
  host.agents.add('session-turn-sched')

  host.ctx.emit('session/event', { id: 'session-old' }, { type: 'turn/end', data: { turn: 2, reason: 'completed' } })
  await sleep(80)

  assert.equal(host.stores.config.get().commander.sessionId, 'session-turn-sched')
  assert.deepEqual(schedule.entries.get('old-active')?.target, { kind: 'session', sessionId: 'session-turn-sched' })
})

test('rotation: 投递前兜底换代也迁移旧 commander 的定时任务', async () => {
  const schedule = createFakeSchedule([
    { id: 'old-active', status: 'active', updatedAt: 'u-a', target: { kind: 'session', sessionId: 'session-old' } },
  ])
  const host = await setup({ schedule: schedule.service })
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-before-deliver-sched'
  host.agents.add('session-before-deliver-sched')

  const response = await host.webServer.invoke('POST', '/commander/message', { text: '到点了吗', requestId: 'req_before_sched' })
  assert.equal(response.status, 200)
  assert.equal((response.body as { sessionId: string }).sessionId, 'session-before-deliver-sched')
  assert.deepEqual(schedule.entries.get('old-active')?.target, { kind: 'session', sessionId: 'session-before-deliver-sched' })
})

test('rotation: bindNew 手动绑定到新会话也迁移旧 commander 的定时任务', async () => {
  const schedule = createFakeSchedule([
    { id: 'old-active', status: 'active', updatedAt: 'u-a', target: { kind: 'session', sessionId: 'session-old' } },
  ])
  const host = await setup({ schedule: schedule.service })
  await seedBound(host)
  host.controller.nextSessionId = 'session-bind-sched'
  host.agents.add('session-bind-sched')

  const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
  assert.equal(response.status, 200)
  const body = response.body as { scheduleMigration: { migrated: number } }
  assert.equal(body.scheduleMigration.migrated, 1)
  assert.deepEqual(schedule.entries.get('old-active')?.target, { kind: 'session', sessionId: 'session-bind-sched' })
})

test('rotation: bindSelect 手动重绑定也迁移旧 commander 的定时任务', async () => {
  const schedule = createFakeSchedule([
    { id: 'old-active', status: 'active', updatedAt: 'u-a', target: { kind: 'session', sessionId: 'session-old' } },
  ])
  const host = await setup({ sessionCwd: '/tmp/a', schedule: schedule.service })
  await seedBound(host)

  const response = await host.webServer.invoke('POST', '/commander/binding', {
    mode: 'select',
    workspaceId: 'ws-a',
    sessionId: 'session-existing',
  })
  assert.equal(response.status, 200)
  const body = response.body as { scheduleMigration: { migrated: number } }
  assert.equal(body.scheduleMigration.migrated, 1)
  assert.deepEqual(schedule.entries.get('old-active')?.target, { kind: 'session', sessionId: 'session-existing' })
})

test('rotation: 定时任务迁移失败不阻断换代；旧 target 保持、失败计数可见', async () => {
  const schedule = createFakeSchedule([
    { id: 'old-active', status: 'active', updatedAt: 'u-a', target: { kind: 'session', sessionId: 'session-old' } },
  ])
  schedule.service.edit = async () => {
    throw Object.assign(new Error('edit boom'), { code: 'edit_broke' })
  }
  const host = await setup({ schedule: schedule.service })
  await seedBound(host)
  await enableForActivity(host)
  host.controller.nextSessionId = 'session-fail-sched'
  host.agents.add('session-fail-sched')

  const response = await host.webServer.invoke('POST', '/commander/rotation', { requestId: 'req_rot_sched_fail', force: true })
  assert.equal(response.status, 200)
  const body = response.body as {
    rotated: boolean
    scheduleMigration: { status: string; failed: Array<{ code: string }> }
  }
  assert.equal(body.rotated, true)
  assert.equal(body.scheduleMigration.status, 'failed')
  assert.deepEqual(body.scheduleMigration.failed.map((item) => item.code), ['edit_broke'])
  assert.equal(host.stores.config.get().commander.sessionId, 'session-fail-sched')
  assert.deepEqual(schedule.entries.get('old-active')?.target, { kind: 'session', sessionId: 'session-old' })
})
