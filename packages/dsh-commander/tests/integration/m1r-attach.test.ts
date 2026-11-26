// M1R：GET /commander/sessions（只读）+ commander_task_dispatch 确认路径 attach（校验/派发/不调面板/幂等）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createDispatchService, type DispatchService, type DispatchTaskArgs, type DispatchTaskResult } from '../../src/host/dispatch/service.ts'
import { defaultWorkspaceRecord, type TaskRecord } from '../../src/host/schema.ts'
import {
  createFakeCapabilityPanel,
  createFakeCtx,
  createFakeSessionController,
  createFakeSessionQuery,
  createFakeStorageDomain,
  createFakeWebServer,
  createFakeWorkspaceRegistry,
} from '../fakes/fakes.ts'

/** 派发消息由指挥官写：默认原文只用于跑通链路；需要验证「原样透传」的用例单独传 prompt。 */
const WORKER_PROMPT = '工作会话首条消息（测试）：按任务完成并给出证据。'
const dispatchWith = (service: Pick<DispatchService, 'dispatchTask'>, args: DispatchTaskArgs): Promise<DispatchTaskResult> =>
  // 首派（无 decisionId）默认补一份原文；确认调用不补，验证「省略 prompt 复用确认卡」的语义。
  service.dispatchTask(args.decisionId === undefined ? { prompt: WORKER_PROMPT, ...args } : args)


const SESSIONS = [
  // 归档会话排在最前：验证「先剔除归档再取 limit」（否则归档会话会占满名额）。
  // 真实 SessionRecord/SessionHeader **不带 archived**：归档状态只在 registry 全局 archivedSessionIds。
  { id: 'session-a2', workspaceId: 'ws-a', title: '已归档会话', updatedAt: 20 },
  { id: 'session-a1', workspaceId: 'ws-a', title: '订单导出会话', updatedAt: 30, model: 'deepseek-flash', contextUsage: 0.42 },
  { id: 'session-b1', workspaceId: 'ws-b', title: 'B 会话', updatedAt: 10 },
]
const ARCHIVED_SESSION_ID = 'session-a2'

interface SetupOptions {
  sessions?: typeof SESSIONS
  panel?: unknown
  policy?: 'inherit' | 'auto'
}

async function setup(options: SetupOptions = {}) {
  const storage = createFakeStorageDomain()
  const domain = await storage.open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.config.update((current) => ({ ...current, commander: { ...current.commander, sessionId: 'session-commander' } }), 1)
  const sessions = options.sessions ?? SESSIONS
  const ctx = createFakeCtx({
    services: {
      // 真实 Host 的 registry.sessionIds 含归档会话、归档状态只在 archivedSessionIds：
      // 这里如实模拟，防止「SessionRecord 不带 archived」导致归档会话漏进列表。
      workspaceRegistry: createFakeWorkspaceRegistry([
        {
          id: 'ws-a', name: 'A', path: '/tmp/a',
          sessionIds: sessions.filter((item) => item.workspaceId === 'ws-a' && item.parentSessionId === undefined).map((item) => item.id),
        },
        {
          id: 'ws-b', name: 'B', path: '/tmp/b',
          sessionIds: sessions.filter((item) => item.workspaceId === 'ws-b' && item.parentSessionId === undefined).map((item) => item.id),
        },
      ], { archivedSessionIds: [ARCHIVED_SESSION_ID] }),
      sessionQuery: createFakeSessionQuery(sessions),
      sessionController: createFakeSessionController(),
      ...(options.panel !== undefined ? { capabilityPanel: options.panel } : {}),
    },
  })
  const record = (id: string, policy: 'inherit' | 'auto') => ({ ...defaultWorkspaceRecord({ id, name: id.toUpperCase(), path: `/tmp/${id}` }), allowed: true, capabilityPolicy: { mode: policy } })
  await stores.workspaces.replaceAll([record('ws-a', options.policy ?? 'auto'), record('ws-b', 'inherit')])
  const task: TaskRecord = {
    v: 1, id: 'task_1', title: 'M1R 任务', goal: 'attach 派发', status: 'draft', workspaceId: '', priority: 'normal',
    commandId: '', assignments: [], acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  }
  await stores.tasks.put(task)
  const dispatch = createDispatchService({
    ctx, stores,
    jevCall: async () => ({
      ok: true, latencyMs: 1,
      response: { answers: {
        workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 0.9 }, confidence: 0.8 },
        session: { type: 'choice', choice: 'new', probabilities: { new: 0.9 }, confidence: 0.8 },
      } },
    }),
  })
  return { ctx, stores, dispatch, controller: ctx.get('sessionController') as ReturnType<typeof createFakeSessionController> }
}

test('M1R sessions route: lists non-archived sessions for workspace, no content fields', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      workspaceRegistry: createFakeWorkspaceRegistry([
        {
          id: 'ws-a', name: 'A', path: '/tmp/a',
          sessionIds: SESSIONS.filter((item) => item.workspaceId === 'ws-a').map((item) => item.id),
        },
      ], { archivedSessionIds: [ARCHIVED_SESSION_ID] }),
      sessionQuery: createFakeSessionQuery(SESSIONS),
      sessionController: createFakeSessionController(),
    },
  })
  await apply(ctx)
  const response = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-a')
  assert.equal(response.status, 200)
  const body = response.body as {
    ok: boolean
    workspaceId: string
    truncated: boolean
    rev: number
    sessions: Array<{ sessionId: string; title: string; archived: boolean; model?: string; contextUsage?: number }>
  }
  assert.equal(body.ok, true)
  assert.equal(body.workspaceId, 'ws-a')
  assert.equal(body.truncated, false)
  assert.equal(typeof body.rev, 'number')
  assert.deepEqual(body.sessions.map((session) => session.sessionId), ['session-a1']) // archived 与跨工作区都被排除
  const first = body.sessions[0]
  assert.equal(first?.title, '订单导出会话')
  assert.equal(typeof first?.createdAt, 'number')
  assert.equal(first?.archived, false)
  // 真实 SessionHeader 无 model/contextUsage：快速路径省略这些字段（契约允许缺失）
  assert.equal('model' in (first ?? {}), false)
  assert.equal('contextUsage' in (first ?? {}), false)
  assert.equal(JSON.stringify(body).includes('content'), false) // 不返回正文
  const missingParam = await webServer.invoke('GET', '/commander/sessions')
  assert.equal(missingParam.status, 400)
  assert.equal((missingParam.body as { code: string }).code, 'invalid_request')
  const unknown = await webServer.invoke('GET', '/commander/sessions?workspaceId=no-such-ws')
  assert.equal(unknown.status, 404)
  assert.equal((unknown.body as { code: string }).code, 'not_found')
})

test('M1R sessions route: empty workspace returns empty array (200)', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-empty', name: 'Empty', path: '/tmp/empty', sessionIds: [] }]),
      sessionQuery: createFakeSessionQuery([]),
      sessionController: createFakeSessionController(),
    },
  })
  await apply(ctx)
  const response = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-empty')
  assert.equal(response.status, 200)
  assert.deepEqual((response.body as { sessions: unknown[] }).sessions, [])
})

test('M1R sessions route: limit 校验与 subagent 子会话过滤（契约 §1.1）', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const sessions = [
    ...SESSIONS,
    { id: 'session-a3', workspaceId: 'ws-a', title: '第二会话', updatedAt: 25 },
    { id: 'session-child', workspaceId: 'ws-a', title: '子代理会话', updatedAt: 40, parentSessionId: 'session-a1' },
  ]
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      workspaceRegistry: createFakeWorkspaceRegistry([{
        id: 'ws-a', name: 'A', path: '/tmp/a',
        sessionIds: sessions.filter((item) => item.workspaceId === 'ws-a' && item.parentSessionId === undefined).map((item) => item.id),
      }], { archivedSessionIds: [ARCHIVED_SESSION_ID] }),
      sessionQuery: createFakeSessionQuery(sessions),
      sessionController: createFakeSessionController(),
    },
  })
  await apply(ctx)
  const limited = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-a&limit=1')
  assert.equal(limited.status, 200)
  const limitedBody = limited.body as { sessions: Array<{ sessionId: string }>; truncated: boolean }
  assert.equal(limitedBody.sessions.length, 1)
  assert.equal(limitedBody.truncated, true)
  assert.equal(limitedBody.sessions[0]?.sessionId, 'session-a1') // lastActiveAt 倒序
  const invalidLimit = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-a&limit=0')
  assert.equal(invalidLimit.status, 400)
  assert.equal((invalidLimit.body as { code: string }).code, 'invalid_request')
  const all = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-a')
  assert.deepEqual((all.body as { sessions: Array<{ sessionId: string }> }).sessions.map((session) => session.sessionId), ['session-a1', 'session-a3'])
})

test('M1R attach confirm dispatches to existing session without capability panel and writes link/assignment', async () => {
  const panel = createFakeCapabilityPanel({ items: [{ id: 'cap_x', name: 'browser', score: 0.99 }], threshold: 0.5 })
  const { stores, dispatch, controller } = await setup({ panel })
  const first = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'ws-a', mode: 'attach', sessionId: 'session-a1' }, requestId: 'req_attach_1' })
  assert.equal(first.status, 'needs_confirmation')
  if (first.status !== 'needs_confirmation') return
  assert.equal(first.recommendation.mode, 'attach')
  assert.equal(first.recommendation.sessionId, 'session-a1')
  const confirmed = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_attach_2' })
  assert.equal(confirmed.status, 'dispatched')
  if (confirmed.status !== 'dispatched') return
  assert.equal(confirmed.sessionCreated, false)
  assert.equal(confirmed.sessionId, 'session-a1')
  assert.equal(controller.created.length, 0) // 不新建会话
  assert.deepEqual(panel.calls, []) // attach 不调用 capabilityPanel
  const link = stores.sessions.list().find((item) => item.sessionId === 'session-a1')
  assert.equal(link?.role, 'work')
  assert.equal(link?.mode, 'attach')
  assert.equal(link?.taskId, 'task_1')
  assert.deepEqual(stores.tasks.get('task_1')?.assignments, ['session-a1'])
  assert.equal(stores.tasks.get('task_1')?.status, 'queued')
  const dispatchRecord = stores.dispatches.get(first.decisionId)
  assert.equal(dispatchRecord?.outcome, 'confirmed')
  assert.equal(dispatchRecord?.finalTarget?.mode, 'attach')
})

test('M1R attach validation: missing session / cross workspace / archived are rejected', async () => {
  const { dispatch } = await setup()
  const base = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'ws-a', mode: 'attach', sessionId: 'session-a1' }, requestId: 'req_val_1' })
  if (base.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const missing = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: base.decisionId, confirmTarget: { workspaceId: 'ws-a', mode: 'attach', sessionId: 'no-such-session' }, requestId: 'req_val_2' })
  assert.equal(missing.status, 'rejected')
  if (missing.status === 'rejected') assert.equal(missing.code, 'invalid_target')
  const cross = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: base.decisionId, confirmTarget: { workspaceId: 'ws-b', mode: 'attach', sessionId: 'session-a1' }, requestId: 'req_val_3' })
  assert.equal(cross.status, 'rejected')
  if (cross.status === 'rejected') assert.match(cross.message, /不存在、已归档、是子代理\/teammate 会话或不属于/)
  const archived = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: base.decisionId, confirmTarget: { workspaceId: 'ws-a', mode: 'attach', sessionId: 'session-a2' }, requestId: 'req_val_4' })
  assert.equal(archived.status, 'rejected')
  if (archived.status === 'rejected') assert.match(archived.message, /已归档/)
})

test('M1R attach: same session may be attached by multiple tasks (contract §1.2.4, no lock)', async () => {
  const { stores, dispatch } = await setup()
  await stores.sessions.upsert({ v: 1, sessionId: 'session-a1', workspaceId: 'ws-a', taskId: 'task_other', role: 'work', mode: 'attach', createdAt: 1, status: 'running' })
  await stores.tasks.put({
    v: 1, id: 'task_other', title: 'other', goal: 'g', status: 'running', workspaceId: 'ws-a', priority: 'normal',
    commandId: '', assignments: ['session-a1'], acceptance: [], timeline: [], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  })
  const first = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'ws-a', mode: 'attach', sessionId: 'session-a1' }, requestId: 'req_multi_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const result = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_multi_2' })
  assert.equal(result.status, 'dispatched') // 不因其它任务占用而拒绝
  assert.deepEqual(stores.tasks.get('task_1')?.assignments, ['session-a1'])
  // 已有任务的 assignment 不应被覆盖
  assert.deepEqual(stores.tasks.get('task_other')?.assignments, ['session-a1'])
})

test('M1R attach: decision replay idempotent and expired decision rejected', async () => {
  const { dispatch } = await setup()
  const first = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'ws-a', mode: 'attach', sessionId: 'session-a1' }, requestId: 'req_idem_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const confirmed = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_idem_2' })
  assert.equal(confirmed.status, 'dispatched')
  const replay = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_idem_3' })
  assert.equal(replay.status, 'dispatched')
  if (confirmed.status === 'dispatched' && replay.status === 'dispatched') assert.equal(replay.sessionId, confirmed.sessionId)
  const expired = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: 'dec_unknown_0000000000000000', confirmTarget: first.recommendation, requestId: 'req_idem_4' })
  assert.equal(expired.status, 'rejected')
  if (expired.status === 'rejected') assert.equal(expired.code, 'decision_expired')
})

test('M1R attach to session in second workspace succeeds (no capability panel on attach)', async () => {
  const panel = createFakeCapabilityPanel({ items: [{ id: 'cap_y', name: 'shell', score: 0.9 }], threshold: 0.1 })
  const { stores, dispatch, controller } = await setup({ panel })
  const first = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'ws-b', mode: 'attach', sessionId: 'session-b1' }, requestId: 'req_wsb_1' })
  assert.equal(first.status, 'needs_confirmation')
  if (first.status !== 'needs_confirmation') return
  const confirmed = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_wsb_2' })
  assert.equal(confirmed.status, 'dispatched')
  if (confirmed.status !== 'dispatched') return
  assert.equal(confirmed.sessionId, 'session-b1')
  assert.equal(controller.created.length, 0)
  assert.deepEqual(panel.calls, [])
  assert.equal(stores.sessions.list().find((item) => item.sessionId === 'session-b1')?.workspaceId, 'ws-b')
  assert.equal(stores.tasks.get('task_1')?.workspaceId, 'ws-b')
})
