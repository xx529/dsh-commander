// M5 追加派发：review 可续派、round+1、上一轮验收归档、默认原会话、brief 落库、跨工作区。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createDispatchService } from '../../src/host/dispatch/service.ts'
import { VersionConflictError } from '../../src/host/store/base.ts'
import { defaultWorkspaceRecord, type TaskRecord } from '../../src/host/schema.ts'
import {
  createFakeCtx,
  createFakeSessionController,
  createFakeSessionQuery,
  createFakeStorageDomain,
  createFakeWorkspaceRegistry,
} from '../fakes/fakes.ts'
import type { JevCallResult } from '../../src/host/jev/client.ts'

const okJev = (): JevCallResult => ({
  ok: true,
  latencyMs: 7,
  response: {
    answers: {
      workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 0.9, w_1: 0.1 }, confidence: 0.8 },
      session: { type: 'choice', choice: 'new', probabilities: { new: 0.9, s_0: 0.1 }, confidence: 0.6 },
    },
  },
})

async function setup(options: { status?: TaskRecord['status']; autoDispatch?: boolean } = {}) {
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.config.update((current) => ({ ...current, commander: { ...current.commander, sessionId: 'session-commander' } }), 1)
  if (options.autoDispatch === true) {
    const config = stores.config.get()
    await stores.config.update((current) => ({ ...current, jev: { ...current.jev, autoDispatch: true } }), config.version)
  }
  const records = ['ws-a', 'ws-b'].map((id) => ({ ...defaultWorkspaceRecord({ id, name: id, path: `/tmp/${id}` }), allowed: true }))
  await stores.workspaces.replaceAll(records)
  const controller = createFakeSessionController()
  const ctx = createFakeCtx({
    services: {
      workspaceRegistry: createFakeWorkspaceRegistry([
        { id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: ['s-1'] },
        { id: 'ws-b', name: 'B', path: '/tmp/b', sessionIds: ['s-2'] },
      ]),
      sessions: createFakeSessionQuery([
        { id: 's-1', workspaceId: 'ws-a', title: 'session one', updatedAt: 5 },
        { id: 's-2', workspaceId: 'ws-b', title: 'session two', updatedAt: 4 },
      ]),
      sessionQuery: createFakeSessionQuery([
        { id: 's-1', workspaceId: 'ws-a', title: 'session one', updatedAt: 5 },
        { id: 's-2', workspaceId: 'ws-b', title: 'session two', updatedAt: 4 },
      ]),
      sessionController: controller,
    },
  })
  const task: TaskRecord = {
    v: 1,
    id: 'task_m5',
    title: 'M5 任务',
    goal: '继续深入',
    status: options.status ?? 'review',
    workspaceId: 'ws-a',
    priority: 'normal',
    commandId: '',
    round: 1,
    assignments: ['s-1'],
    primarySessionId: 's-1',
    acceptance: [{ id: 'acc_1', text: '第一轮验收', source: 'commander', state: 'evidence_present' }],
    reportSummary: { text: '第一轮结论：已确认无新模型。', at: 100, round: 1 },
    reportMaterials: [{ id: 'mat_1', kind: 'link', title: '第一轮来源', url: 'https://example.com/round-1', source: 'commander', state: 'unverified' }],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
  await stores.tasks.put(task)
  await stores.sessions.upsert({ v: 1, sessionId: 's-1', workspaceId: 'ws-a', taskId: task.id, role: 'work', mode: 'new', createdAt: 1, status: 'idle', round: 1 })
  const service = createDispatchService({
    ctx,
    stores,
    jevCall: async () => okJev(),
    controllerOverride: controller,
  })
  return { stores, controller, service }
}

test('review 可以续派：needs_confirmation 保持 review，默认原会话，round=N+1', async () => {
  const { stores, service } = await setup()
  const first = await service.dispatchTask({ taskId: 'task_m5', requestId: 'req_m5_1' })
  assert.equal(first.status, 'needs_confirmation')
  if (first.status !== 'needs_confirmation') return
  assert.equal(first.kind, 'continue')
  assert.equal(first.round, 2)
  assert.equal(first.recommendation.mode, 'attach')
  assert.equal(first.recommendation.sessionId, 's-1')
  assert.equal(stores.tasks.get('task_m5')?.status, 'review')
})

test('续派确认：round+1、上轮验收归档、brief/userRequest 落库、link round 更新', async () => {
  const { stores, controller, service } = await setup()
  const first = await service.dispatchTask({
    taskId: 'task_m5',
    requestId: 'req_m5_2',
    instruction: '深入分析第 3 条',
    userRequest: '基于第 3 条再深入',
  })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const dispatched = await service.dispatchTask({
    taskId: 'task_m5',
    decisionId: first.decisionId,
    confirmTarget: first.recommendation,
    requestId: 'req_m5_3',
  })
  assert.equal(dispatched.status, 'dispatched')
  if (dispatched.status !== 'dispatched') return
  assert.equal(dispatched.round, 2)
  const task = stores.tasks.get('task_m5')
  assert.equal(task?.status, 'queued')
  assert.equal(task?.round, 2)
  assert.equal(task?.reportMaterials, undefined)
  assert.equal(task?.acceptanceHistory?.[0]?.materials?.[0]?.title, '第一轮来源')
  assert.deepEqual(task?.acceptance, [])
  assert.equal(task?.acceptanceHistory?.length, 1)
  assert.equal(task?.acceptanceHistory?.[0]?.round, 1)
  assert.equal(task?.acceptanceHistory?.[0]?.items[0]?.text, '第一轮验收')
  assert.equal(task?.acceptanceHistory?.[0]?.reportSummary?.text, '第一轮结论：已确认无新模型。')
  assert.equal(task?.reportSummary, undefined)
  assert.deepEqual(task?.workspaceIds, ['ws-a'])
  const link = stores.sessions.list().find(item => item.sessionId === 's-1')
  assert.equal(link?.round, 2)
  const record = stores.dispatches.get(first.decisionId)
  assert.equal(record?.round, 2)
  assert.equal(record?.kind, 'continue')
  assert.equal(record?.userRequest?.text, '基于第 3 条再深入')
  assert.equal(record?.userRequest?.source, 'chat')
  assert.match(record?.brief ?? '', /本轮要求：深入分析第 3 条/)
  assert.match(record?.brief ?? '', /上一轮结论：第一轮结论/)
  // 同一会话续派只发增量：不重复目标/上一轮验收整段
  assert.doesNotMatch(record?.brief ?? '', /目标：/)
  assert.doesNotMatch(record?.brief ?? '', /上一轮验收项/)
  const prompt = controller.prompts.at(-1)
  assert.equal(prompt?.sessionId, 's-1')
  assert.match(String((prompt?.content as Array<{ text: string }>)[0]?.text), /本轮要求：深入分析第 3 条/)
})

test('续派可换新工作区/新会话，workspaceIds 累积', async () => {
  const { stores, controller, service } = await setup()
  const first = await service.dispatchTask({ taskId: 'task_m5', requestId: 'req_m5_4' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const dispatched = await service.dispatchTask({
    taskId: 'task_m5',
    decisionId: first.decisionId,
    confirmTarget: { workspaceId: 'ws-b', mode: 'new' },
    requestId: 'req_m5_5',
  })
  assert.equal(dispatched.status, 'dispatched')
  const task = stores.tasks.get('task_m5')
  assert.equal(task?.workspaceId, 'ws-b')
  assert.deepEqual(task?.workspaceIds, ['ws-a', 'ws-b'])
  assert.equal(task?.primarySessionId, controller.nextSessionId)
  // 换新会话：brief 需要完整目标/上一轮验收，避免新会话缺少上下文
  const record = stores.dispatches.get(first.decisionId)
  assert.match(record?.brief ?? '', /目标：/)
  assert.match(record?.brief ?? '', /上一轮验收项：.*第一轮验收/)
})

test('续派复用 autoDispatch：开关打开且门控通过时自动开新一轮', async () => {
  const { stores, service } = await setup({ autoDispatch: true })
  const first = await service.dispatchTask({ taskId: 'task_m5', requestId: 'req_m5_6' })
  assert.equal(first.status, 'dispatched')
  if (first.status !== 'dispatched') return
  assert.equal(first.round, 2)
  const task = stores.tasks.get('task_m5')
  assert.equal(task?.status, 'queued')
  assert.equal(task?.round, 2)
  assert.equal(task?.acceptanceHistory?.length, 1)
})

test('运行中的任务拒绝续派；draft 首派仍然正常', async () => {
  const running = await setup({ status: 'running' })
  const rejected = await running.service.dispatchTask({ taskId: 'task_m5', requestId: 'req_m5_7' })
  assert.equal(rejected.status, 'rejected')
  if (rejected.status === 'rejected') assert.equal(rejected.code, 'task_state')
  const draft = await setup({ status: 'draft' })
  const first = await draft.service.dispatchTask({ taskId: 'task_m5', requestId: 'req_m5_8' })
  assert.equal(first.status, 'needs_confirmation')
  if (first.status === 'needs_confirmation') assert.equal(first.kind, 'initial')
})

test('prompt 已发出后 task version 被 turn/start 顶掉：重试写入，不重复派发', async () => {
  const { stores, controller, service } = await setup({ autoDispatch: true })
  const originalUpdate = stores.tasks.update.bind(stores.tasks)
  let remainingConflicts = 1
  stores.tasks.update = async (taskId, mutate, expectedVersion) => {
    if (remainingConflicts > 0) {
      remainingConflicts -= 1
      throw new VersionConflictError()
    }
    return originalUpdate(taskId, mutate, expectedVersion)
  }
  const result = await service.dispatchTask({ taskId: 'task_m5', requestId: 'req_m5_conflict' })
  assert.equal(result.status, 'dispatched')
  const task = stores.tasks.get('task_m5')
  assert.equal(task?.status, 'queued')
  assert.equal(task?.round, 2)
  assert.equal(controller.prompts.length, 1)
})
