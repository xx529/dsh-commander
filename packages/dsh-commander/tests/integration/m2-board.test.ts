// M2 看板 Host 集成：PATCH/boardEdits/30s 合并注入、archive/restore/archive list、详情。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { defaultWorkspaceRecord, type TaskRecord } from '../../src/host/schema.ts'
import { createFakeCtx, createFakeSessionController, createFakeSessionQuery, createFakeStorageDomain, createFakeWebServer, createFakeWorkspaceRegistry } from '../fakes/fakes.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function setup(options: { mergeMs?: number; services?: Record<string, unknown> } = {}) {
  const previous = process.env.COMMANDER_BOARD_MERGE_MS
  if (options.mergeMs !== undefined) process.env.COMMANDER_BOARD_MERGE_MS = String(options.mergeMs)
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  // 可注入的 live 指挥官 agent（上下文注入路径）；缺省时投递回退 sessionController.prompt。
  let liveAgent: { followup(message: unknown): void } | undefined
  const agents = { get: () => liveAgent, list: () => [] }
  const setLiveAgent = (agent: { followup(message: unknown): void } | undefined): void => {
    liveAgent = agent
  }
  const ctx = createFakeCtx({
    services: {
      ...(options.services ?? {}),
      storageDomain: storage,
      webServer,
      sessionController: controller,
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: [] }]),
      agents,
    },
  })
  await apply(ctx)
  const domain = await storage.open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.workspaces.replaceAll([{ ...defaultWorkspaceRecord({ id: 'ws-a', name: 'A', path: '/tmp/a' }), allowed: true }])
  // 绑定指挥官（注入投递需要有效绑定；fake create 返回 session-fake-1）
  const bound = await webServer.invoke('POST', '/commander/binding', { mode: 'new', cwd: '/tmp/commander-ws', requestId: 'req_m2_bind' })
  assert.equal(bound.status, 200)
  const restoreEnv = (): void => {
    if (previous === undefined) delete process.env.COMMANDER_BOARD_MERGE_MS
    else process.env.COMMANDER_BOARD_MERGE_MS = previous
  }
  return { storage, domain, webServer, controller, stores, ctx, restoreEnv, setLiveAgent }
}

function seedTask(stores: ReturnType<typeof createStores>, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const task: TaskRecord = {
    v: 1,
    id: 'task_m2_1',
    title: 'M2 任务',
    goal: '看板验证',
    status: 'proposed',
    workspaceId: 'ws-a',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }
  void stores.tasks.put(task)
  return task
}

test('PATCH board: status is rejected (no drag); priority/title still write task + board_edits', async () => {
  const host = await setup({ mergeMs: 20 })
  try {
    seedTask(host.stores)
    const statusPatch = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', {
      field: 'status', value: 'running', editId: 'edit_00000000000000000000000000000001', requestId: 'req_m2_patch_1',
    })
    assert.equal(statusPatch.status, 400)
    assert.equal((statusPatch.body as { code: string }).code, 'invalid_request')
    assert.equal(host.stores.tasks.get('task_m2_1')?.status, 'proposed')
    assert.equal(host.stores.boardEdits.list().length, 0)
    const response = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', {
      field: 'priority', value: 'high', editId: 'edit_00000000000000000000000000000002', requestId: 'req_m2_patch_2',
    })
    assert.equal(response.status, 200)
    const body = response.body as { ok: boolean; task: { priority: string } & Record<string, unknown>; boardEdit: { editId: string; injectedAt: number | null }; rev: number }
    assert.equal(body.ok, true)
    assert.equal(body.task.priority, 'high')
    assert.equal('stale' in body.task, false) // 2026-11-24：看板不再下发 stale
    assert.equal(body.boardEdit.injectedAt, null)
    assert.equal(typeof body.rev, 'number')
    assert.equal(host.stores.tasks.get('task_m2_1')?.priority, 'high')
    const edits = host.stores.boardEdits.list().filter((edit) => edit.taskId === 'task_m2_1')
    assert.equal(edits.length, 1)
    assert.equal(edits[0]?.field, 'priority')
    assert.equal(edits[0]?.before, 'normal')
    assert.equal(edits[0]?.after, 'high')
    assert.equal(edits[0]?.actor, 'user')
  } finally {
    host.restoreEnv()
  }
})

test('PATCH board: any status target is 400 invalid_request; illegal field 400; unknown task 409', async () => {
  const host = await setup({ mergeMs: 20 })
  try {
    seedTask(host.stores)
    for (const [index, value] of ['done', 'archived', 'review', 'queued', 'cancelled'].entries()) {
      const response = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', { field: 'status', value, editId: `edit_status_${String(index)}` })
      assert.equal(response.status, 400, JSON.stringify(response.body))
      assert.equal((response.body as { code: string }).code, 'invalid_request')
    }
    const invalid = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', { field: 'nope', value: 1, editId: 'edit_nope' })
    assert.equal(invalid.status, 400)
    assert.equal((invalid.body as { code: string }).code, 'invalid_request')
    const missing = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_missing', { field: 'priority', value: 'high', editId: 'edit_missing' })
    assert.equal(missing.status, 409)
  } finally {
    host.restoreEnv()
  }
})

test('PATCH board: same editId is idempotent (no duplicate edit/injection)', async () => {
  const host = await setup({ mergeMs: 20 })
  try {
    seedTask(host.stores)
    const body = { field: 'priority', value: 'high', editId: 'edit_idem_1', requestId: 'req_m2_idem_1' }
    const first = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', body)
    // 同 requestId → 服务端 5min LRU 直接回放首次响应（不重复写）
    const replayed = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', body)
    // 同 editId + 新 requestId → 服务层幂等（duplicate:true，不重复写/不重复注入）
    const second = await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', { ...body, requestId: 'req_m2_idem_2' })
    assert.equal(first.status, 200)
    assert.equal(replayed.status, 200)
    assert.deepEqual(replayed.body, first.body)
    assert.equal(second.status, 200)
    assert.equal((second.body as { duplicate: boolean }).duplicate, true)
    assert.equal(host.stores.boardEdits.list().filter((edit) => edit.id === 'edit_idem_1').length, 1)
    await sleep(60)
    const prompts = host.controller.prompts.filter((prompt) => String((prompt.content as Array<{ text: string }>)[0]?.text ?? '').includes('[board-edit]'))
    assert.equal(prompts.length, 1) // 合并窗口只注入一次
  } finally {
    host.restoreEnv()
  }
})

test('PATCH board: 30s 合并窗口内多条 edit 合并为一条 [board-edit] 注入（最终态）', async () => {
  const host = await setup({ mergeMs: 30 })
  try {
    seedTask(host.stores)
    await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', { field: 'title', value: '新标题', editId: 'edit_merge_1', requestId: 'req_m2_merge_1' })
    await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', { field: 'priority', value: 'urgent', editId: 'edit_merge_2', requestId: 'req_m2_merge_2' })
    await sleep(120)
    const prompts = host.controller.prompts.filter((prompt) => String((prompt.content as Array<{ text: string }>)[0]?.text ?? '').includes('[board-edit]'))
    assert.equal(prompts.length, 1, 'merged into one injection')
    const text = String((prompts[0]?.content as Array<{ text: string }>)[0]?.text)
    assert.match(text, /editIds=edit_merge_1,edit_merge_2/)
    assert.match(text, /injectionKey=/)
    assert.match(text, /title: M2 任务 → 新标题/)
    assert.match(text, /priority: normal → urgent/)
    assert.match(text, /不要回滚用户改动/)
    const edits = host.stores.boardEdits.list().filter((edit) => edit.taskId === 'task_m2_1')
    assert.ok(edits.every((edit) => edit.injectedAt !== undefined), 'injectedAt written after delivery')
    assert.ok(edits.some((edit) => edit.injectionKey !== undefined))
  } finally {
    host.restoreEnv()
  }
})

test('task detail adds boardEdits/archivedAt; state excludes archived + archiveSummary; no stale field', async () => {
  const host = await setup({ mergeMs: 20 })
  try {
    // 长静默任务（running 且 21min 无活动）：历史 stale 判定会置 true，移除后不得出现该字段。
    seedTask(host.stores, { status: 'running', lastActivityAt: Date.now() - 21 * 60 * 1000 })
    await host.webServer.invoke('PATCH', '/commander/board/tasks/task_m2_1', { field: 'priority', value: 'high', editId: 'edit_detail_1', requestId: 'req_m2_detail_1' })
    const detail = await host.webServer.invoke('GET', '/commander/tasks/task_m2_1')
    assert.equal(detail.status, 200)
    const detailBody = detail.body as { boardEdits: Array<{ editId: string; field: string; injectedAt: number | null }> } & Record<string, unknown>
    assert.equal('stale' in detailBody, false)
    assert.equal(detailBody.boardEdits[0]?.editId, 'edit_detail_1')
    assert.equal(detailBody.boardEdits[0]?.field, 'priority')
    const state = await host.webServer.invoke('GET', '/commander/state')
    const stateBody = state.body as { tasks: Array<{ id: string; acceptanceCount: number; evidenceInsufficientCount: number } & Record<string, unknown>>; archiveSummary: { archivedCount: number; cancelledCount: number }; counts: Record<string, number> }
    const view = stateBody.tasks.find((task) => task.id === 'task_m2_1')
    assert.equal(view !== undefined && 'stale' in view, false)
    assert.equal(view?.acceptanceCount, 0)
    assert.deepEqual(stateBody.archiveSummary, { archivedCount: 0, cancelledCount: 0 })
  } finally {
    host.restoreEnv()
  }
})

test('archive/restore: review→archived、回收站列表、restore→draft；非法源状态 conflict', async () => {
  const host = await setup({ mergeMs: 20 })
  try {
    seedTask(host.stores, { status: 'review', acceptance: [{ id: 'acc_1', text: 'A', source: 'commander', state: 'insufficient' }] })
    const archived = await host.webServer.invoke('POST', '/commander/tasks/task_m2_1/archive', { requestId: 'req_m2_arch_1' })
    assert.equal(archived.status, 200)
    assert.equal((archived.body as { task: { status: string } }).task.status, 'archived')
    assert.equal(host.stores.tasks.get('task_m2_1')?.archivedAt !== undefined, true)
    const state = await host.webServer.invoke('GET', '/commander/state')
    const stateBody = state.body as { tasks: Array<{ id: string }>; archiveSummary: { archivedCount: number }; counts: Record<string, number> }
    assert.equal(stateBody.tasks.some((task) => task.id === 'task_m2_1'), false)
    assert.equal(stateBody.archiveSummary.archivedCount, 1)
    assert.equal(stateBody.counts.archived, 1)
    const list = await host.webServer.invoke('GET', '/commander/archive?limit=10')
    assert.equal(list.status, 200)
    const listBody = list.body as { tasks: Array<{ id: string; status: string }>; nextCursor: number | null }
    assert.deepEqual(listBody.tasks.map((task) => task.id), ['task_m2_1'])
    assert.equal(listBody.nextCursor, null)
    assert.equal(host.stores.tasks.get('task_m2_1')?.archivedFrom, 'review')
    const restored = await host.webServer.invoke('POST', '/commander/tasks/task_m2_1/restore', {})
    assert.equal(restored.status, 200)
    // 按 archivedFrom 回退：review 来源恢复为 review（不再一律 draft）
    assert.equal((restored.body as { task: { status: string } }).task.status, 'review')
    assert.equal(host.stores.tasks.get('task_m2_1')?.archivedAt, undefined)
    const illegalRestore = await host.webServer.invoke('POST', '/commander/tasks/task_m2_1/restore', {})
    assert.equal(illegalRestore.status, 409)
    const archiveAgain = await host.webServer.invoke('POST', '/commander/tasks/task_m2_1/archive', {})
    assert.equal(archiveAgain.status, 200)
    assert.equal(host.stores.tasks.get('task_m2_1')?.archivedFrom, 'review')

  } finally {
    host.restoreEnv()
  }
})


test('注入以 DSH 上下文消息投递到 live 指挥官（system-reminder + 非 user source，不再发用户消息）', async () => {
  const { webServer, stores, ctx, controller, setLiveAgent } = await setup({ mergeMs: 20 })
  const captured: Array<{ id: string; role: string; content: Array<{ type: string; text: string }>; source: Record<string, unknown> }> = []
  setLiveAgent({ followup: (message) => { captured.push(message as typeof captured[number]) } })
  seedTask(stores, { id: 'task_ctx_1', status: 'draft' })
  const patched = await webServer.invoke('PATCH', '/commander/board/tasks/task_ctx_1', { field: 'priority', value: 'high', editId: 'edit_0123456789abcdef0123456789abcdef', requestId: 'req_ctx_board_1' })
  assert.equal(patched.status, 200)
  await sleep(60)
  assert.equal(captured.length >= 1, true, '看板改动应作为上下文消息投递')
  const boardMessage = captured[0] as (typeof captured)[number]
  assert.equal(boardMessage.role, 'user')
  assert.equal(boardMessage.source.kind, 'commander-board-edit')
  assert.notEqual(boardMessage.source.kind, 'user')
  assert.match(boardMessage.content[0]?.text ?? '', /^<system-reminder>/)
  assert.match(boardMessage.content[0]?.text ?? '', /\[board-edit\]/)
  // 上下文注入不走 sessionController.prompt（不再产生用户消息）
  assert.equal(controller.prompts.length, 0)

  await stores.tasks.put({
    v: 1, id: 'task_ctx_2', title: 'ctx', goal: '', status: 'running', workspaceId: 'ws-a', priority: 'normal', commandId: '',
    assignments: ['session-ctx-work'], primarySessionId: 'session-ctx-work', acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-ctx-work', workspaceId: 'ws-a', taskId: 'task_ctx_2', role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  ctx.emit('session/event', { id: 'session-ctx-work' }, { seq: 9, type: 'turn/end', time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(80)
  const reply = captured.find((message) => message.source.kind === 'commander-session-reply') as (typeof captured)[number] | undefined
  assert.notEqual(reply, undefined, '工作会话 turn/end 应作为上下文消息注入')
  assert.equal(reply?.source.senderSessionId, 'session-ctx-work')
  assert.equal(reply?.source.form, 'relay')
  assert.match(reply?.content[0]?.text ?? '', /^<system-reminder>[\s\S]*\[session-reply\][\s\S]*<\/system-reminder>$/)
  assert.equal(controller.prompts.length, 0)
})

test('工作会话 turn/end 推整行 task.updated + 链接置 idle（看板/详情无需重启）', async () => {
  const { webServer, stores, ctx } = await setup()
  await stores.tasks.put({
    v: 1, id: 'task_live_1', title: 'live', goal: '', status: 'running', workspaceId: 'ws-a', priority: 'normal', commandId: '',
    assignments: ['session-work-live'], primarySessionId: 'session-work-live', acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-work-live', workspaceId: 'ws-a', taskId: 'task_live_1', role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  const sse = await webServer.invoke('GET', '/commander/state', undefined, { accept: 'text/event-stream' })
  ctx.emit('session/event', { id: 'session-work-live' }, { seq: 9, type: 'turn/end', time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(30)
  const blocks = sse.events.join('').split('\n\n').filter((block) => block.includes('event: task.updated'))
  assert.ok(blocks.length >= 1, sse.events.join('').slice(0, 300))
  const data = JSON.parse((blocks.at(-1) ?? '').split('data: ')[1] ?? '{}') as { task?: { id?: string; lastActivityAt?: number } }
  assert.equal(data.task?.id, 'task_live_1')
  assert.equal(data.task?.lastActivityAt, 2_000)
  // 面板头部计数同源：任务变化必须同时推 tasks.changed（否则 chip 停留在旧状态）
  const changedBlocks = sse.events.join('').split('\n\n').filter((block) => block.includes('event: tasks.changed'))
  assert.ok(changedBlocks.length >= 1, 'tasks.changed 应随 task.updated 一起推送')
  const changed = JSON.parse((changedBlocks.at(-1) ?? '').split('data: ')[1] ?? '{}') as { counts?: Record<string, number> }
  assert.equal(changed.counts?.running, 1)
  assert.equal(changed.counts?.draft, 0)
  const link = stores.sessions.list().find((item) => item.sessionId === 'session-work-live')
  // 注入链路并发写 lastInjected，不能把 turn/end 写的 idle 覆盖回 running
  assert.equal(link?.status, 'idle')
  assert.equal(link?.lastInjected?.seq, 9)
})

test('详情关联会话补 工作区名 + 会话标题（抽屉不再只显示裸 sessionId）', async () => {
  const sessionQuery = createFakeSessionQuery([{ id: 'session-named', workspaceId: 'ws-a', title: '订单导出改造', updatedAt: 5 }])
  const { webServer, stores } = await setup({ services: { sessionQuery } })
  await stores.tasks.put({
    v: 1, id: 'task_named_1', title: 'named', goal: '', status: 'running', workspaceId: 'ws-a', priority: 'normal', commandId: '',
    assignments: ['session-named'], primarySessionId: 'session-named', acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-named', workspaceId: 'ws-a', taskId: 'task_named_1', role: 'work', mode: 'attach', createdAt: 1, status: 'running' })
  const detail = await webServer.invoke('GET', '/commander/tasks/task_named_1')
  assert.equal(detail.status, 200)
  const body = detail.body as { sessions: Array<{ sessionId: string; workspaceName?: string; sessionTitle?: string }> }
  assert.deepEqual(
    body.sessions.map((row) => [row.sessionId, row.workspaceName, row.sessionTitle]),
    [['session-named', 'A', '订单导出改造']],
  )
})

test('详情里会话已不在内存 → running 派生为 idle（历史残留记录）', async () => {
  const { webServer, stores } = await setup()
  await stores.tasks.put({
    v: 1, id: 'task_gone_1', title: 'gone', goal: '', status: 'running', workspaceId: 'ws-a', priority: 'normal', commandId: '',
    assignments: ['session-gone'], primarySessionId: 'session-gone', acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-gone', workspaceId: 'ws-a', taskId: 'task_gone_1', role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  const detail = await webServer.invoke('GET', '/commander/tasks/task_gone_1')
  assert.equal(detail.status, 200)
  const body = detail.body as { sessions: Array<{ sessionId: string; status: string }> }
  assert.deepEqual(body.sessions.map((row) => [row.sessionId, row.status]), [['session-gone', 'idle']])
})

test('archive list: q/status/workspace/range filters, total/summary/months, cursor, row fields, invalid params', async () => {
  const host = await setup({ mergeMs: 20 })
  try {
    const day = 86_400_000
    const base = Date.now()
    const seed = (id: string, title: string, status: TaskRecord['status'], workspaceId: string, updatedAt: number, round = 1): void => {
      seedTask(host.stores, { id, title, status, workspaceId, updatedAt, round })
    }
    seed('arc_a1', '调研 SSE 断线', 'archived', 'ws-a', base - 2 * day, 2)
    seed('arc_a2', '回收站 分页', 'archived', 'ws-a', base - 40 * day)
    seed('arc_a3', '取消的 SSE 实验', 'cancelled', 'ws-b', base - 10 * day)
    seed('arc_a4', '别的任务', 'archived', 'ws-b', base - 70 * day)

    const monthKey = (ms: number): string => {
      const date = new Date(ms)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    }

    const all = await host.webServer.invoke('GET', '/commander/archive?limit=10')
    assert.equal(all.status, 200)
    const allBody = all.body as {
      tasks: Array<{ id: string; round: number; sessionCount: number }>
      total: number
      summary: { archivedCount: number; cancelledCount: number; last30dCount: number }
      months: Array<{ key: string; count: number }>
      nextCursor: number | null
    }
    assert.equal(allBody.total, 4)
    assert.equal(allBody.tasks.length, 4)
    assert.equal(allBody.summary.archivedCount, 3)
    assert.equal(allBody.summary.cancelledCount, 1)
    assert.equal(allBody.summary.last30dCount, 2) // a1(2d) + a3(10d)
    assert.equal(allBody.tasks.find((task) => task.id === 'arc_a1')?.round, 2)
    assert.equal(allBody.tasks.find((task) => task.id === 'arc_a1')?.sessionCount, 0)
    assert.deepEqual(allBody.months.map((row) => row.key).includes(monthKey(base - 2 * day)), true)
    assert.deepEqual(allBody.months.map((row) => row.key).includes(monthKey(base - 70 * day)), true)
    assert.deepEqual([...allBody.months].map((row) => row.key), [...allBody.months].map((row) => row.key).sort((a, b) => b.localeCompare(a)))

    const q = await host.webServer.invoke('GET', '/commander/archive?q=SSE')
    const qBody = q.body as { tasks: Array<{ id: string }>; total: number }
    assert.equal(qBody.total, 2)
    assert.deepEqual(qBody.tasks.map((task) => task.id).sort(), ['arc_a1', 'arc_a3'])

    const cancelled = await host.webServer.invoke('GET', '/commander/archive?status=cancelled')
    assert.equal((cancelled.body as { total: number }).total, 1)
    const wsA = await host.webServer.invoke('GET', '/commander/archive?workspaceId=ws-a')
    assert.equal((wsA.body as { total: number }).total, 2)

    const from = base - 15 * day
    const to = base + day
    const ranged = await host.webServer.invoke('GET', `/commander/archive?from=${String(from)}&to=${String(to)}`)
    const rangedBody = ranged.body as { total: number; months: Array<{ key: string; count: number }> }
    assert.equal(rangedBody.total, 2)
    // 月份导航忽略 from/to：仍列出全部月份（a1/a2/a4 的 3 个月份）。
    assert.equal(rangedBody.months.length >= 3, true)
    assert.equal(rangedBody.months.reduce((sum, row) => sum + row.count, 0), 4)

    // 筛选后的月份只统计 status=archived（忽略区间），a3 不计入。
    const archivedRanged = await host.webServer.invoke('GET', `/commander/archive?status=archived&from=${String(from)}&to=${String(to)}`)
    const archivedBody = archivedRanged.body as { total: number; months: Array<{ count: number }> }
    assert.equal(archivedBody.total, 1)
    assert.equal(archivedBody.months.reduce((sum, row) => sum + row.count, 0), 3)

    const first = await host.webServer.invoke('GET', '/commander/archive?limit=2')
    const firstBody = first.body as { tasks: Array<{ id: string }>; nextCursor: number | null; total: number }
    assert.equal(firstBody.tasks.length, 2)
    assert.equal(firstBody.total, 4)
    assert.equal(typeof firstBody.nextCursor, 'number')
    const second = await host.webServer.invoke('GET', `/commander/archive?limit=2&cursor=${String(firstBody.nextCursor)}`)
    const secondBody = second.body as { tasks: Array<{ id: string }>; total: number }
    assert.equal(secondBody.tasks.length, 2)
    assert.equal(secondBody.total, 4)
    assert.deepEqual(secondBody.tasks.map((task) => task.id), ['arc_a2', 'arc_a4'])

    for (const path of [
      '/commander/archive?status=nope',
      '/commander/archive?from=10&to=10',
      '/commander/archive?limit=101',
      `/commander/archive?q=${'x'.repeat(101)}`,
    ]) {
      const invalid = await host.webServer.invoke('GET', path)
      assert.equal(invalid.status, 400, path)
      assert.equal((invalid.body as { code: string }).code, 'invalid_request')
    }
  } finally {
    host.restoreEnv()
  }
})
