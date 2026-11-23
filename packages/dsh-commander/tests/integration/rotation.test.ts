// R1：会话轮换（门控 / 提交 / 退役 / 回滚 / 触发 / 路由），契约 §3/§7/§8。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import type { TaskRecord } from '../../src/host/schema.ts'
import {
  createFakeAgents,
  createFakeCtx,
  createFakeSessionController,
  createFakeStorageDomain,
  createFakeWebServer,
  createFakeWorkspaceRegistry,
} from '../fakes/fakes.ts'

const DAY = 86_400_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface SetupOptions {
  events?: Array<Record<string, unknown>>
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
          return { id: sessionId, events: options.events ?? [] }
        },
      },
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

test('rotation: 手动「绑定到新会话」不生成简报（D1 回归）', async () => {
  const host = await setup()
  await seedBound(host, { enabled: true })
  host.controller.nextSessionId = 'session-manual'
  host.agents.add('session-manual')
  const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a' })
  assert.equal(response.status, 200)
  assert.equal(host.agents.get('session-manual')?.injected.length, 0)
  // 代际递增、起始时间重置
  const config = host.stores.config.get()
  assert.equal(config.commander.sessionId, 'session-manual')
  assert.equal(config.commander.rotation?.generation, 3)
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
  const body = view.body as { config: { commander: { rotation: { enabled: boolean; periodDays: number } } } }
  assert.equal(body.config.commander.rotation.enabled, true)
  assert.equal(body.config.commander.rotation.periodDays, 3)
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
