// 依赖编排集成（task-state-machine-final §6）：dispatch 守卫、单确认卡、accept 解锁提醒、
// cancel/archive 受阻提醒；Host 不自动派发、不自动改后继状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { defaultWorkspaceRecord, type TaskRecord } from '../../src/host/schema.ts'
import {
  createFakeAgent, createFakeCtx, createFakeSessionController, createFakeStorageDomain, createFakeTools,
  createFakeWebServer, createFakeWorkspaceRegistry,
} from '../fakes/fakes.ts'

type ToolSpec = { execute: (args: unknown, exec: unknown) => Promise<unknown> }

async function setup() {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const toolsService = createFakeTools()
  let liveAgent: { followup(message: unknown): void } | undefined
  const captured: Array<{ content?: Array<{ text?: string }>; source?: Record<string, unknown> }> = []
  liveAgent = { followup: (message) => { captured.push(message as typeof captured[number]) } }
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      tools: toolsService,
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: [] }]),
      agents: { get: () => liveAgent, list: () => [] },
    },
  })
  await apply(ctx)
  const stores = createStores(await storage.open(commanderDomainSpec))
  await stores.workspaces.replaceAll([{ ...defaultWorkspaceRecord({ id: 'ws-a', name: 'A', path: '/tmp/a' }), allowed: true }])
  const bound = await webServer.invoke('POST', '/commander/binding', { mode: 'new', cwd: '/tmp/commander-ws', requestId: 'req_dep_bind' })
  assert.equal(bound.status, 200)
  const commanderSid = (bound.body as { binding: { sessionId: string } }).binding.sessionId
  const specOf = (name: string): ToolSpec => {
    const entry = toolsService.registered.find((item) => (item.definition as { name?: string }).name === name)
    assert.ok(entry !== undefined, `tool ${name} is registered`)
    return entry.definition as ToolSpec
  }
  const exec = { agent: createFakeAgent({ sessionId: commanderSid }), signal: { throwIfAborted: () => undefined } }
  const texts = (): string[] => captured
    .map((message) => (message.content ?? []).map((block) => block.text ?? '').join(''))
    .filter((text) => text.includes('[task-unblocked]') || text.includes('[task-dependency-blocked]'))
  return { stores, webServer, specOf, exec, texts, captured }
}

function seed(stores: ReturnType<typeof createStores>, overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  const task: TaskRecord = {
    v: 1,
    title: overrides.id,
    goal: 'G',
    status: 'draft',
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

const acceptance = [{ id: 'acc_1', text: 'A', source: 'commander' as const, state: 'evidence_present' as const }]

test('dispatch: unmet dependency is rejected without creating a confirmation card', async () => {
  const host = await setup()
  seed(host.stores, { id: 'task_dep', status: 'review' })
  seed(host.stores, { id: 'task_next', status: 'draft', dependsOn: ['task_dep'] })
  const result = (await host.specOf('commander_task_dispatch').execute({ taskId: 'task_next', requestId: 'req_dep_1' }, host.exec)) as { status: string; code: string; message: string }
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'dependency_unmet')
  assert.match(result.message, /task_dep/)
  const state = await host.webServer.invoke('GET', '/commander/state')
  assert.equal((state.body as { pendingDispatch: unknown }).pendingDispatch, null)
  assert.equal(host.stores.tasks.get('task_next')?.status, 'draft')
})

test('dispatch: another task with a pending card returns pending_dispatch_exists; same-task retry still allowed', async () => {
  const host = await setup()
  seed(host.stores, { id: 'task_a', status: 'draft' })
  seed(host.stores, { id: 'task_b', status: 'draft' })
  const first = (await host.specOf('commander_task_dispatch').execute({ taskId: 'task_a', requestId: 'req_card_a' }, host.exec)) as { status: string }
  assert.equal(first.status, 'needs_confirmation')
  const other = (await host.specOf('commander_task_dispatch').execute({ taskId: 'task_b', requestId: 'req_card_b' }, host.exec)) as { status: string; code: string }
  assert.equal(other.status, 'rejected')
  assert.equal(other.code, 'pending_dispatch_exists')
  const retry = (await host.specOf('commander_task_dispatch').execute({ taskId: 'task_a', requestId: 'req_card_a2' }, host.exec)) as { status: string }
  assert.equal(retry.status, 'needs_confirmation')
})

test('accept first success injects one [task-unblocked] and marks dependencyNotifiedAt; duplicate accept does not repeat', async () => {
  const host = await setup()
  seed(host.stores, { id: 'task_done_a', status: 'review', acceptance })
  seed(host.stores, { id: 'task_next_b', status: 'draft', dependsOn: ['task_done_a'] })
  seed(host.stores, { id: 'task_next_c', status: 'draft', dependsOn: ['task_done_a'] })
  const accepted = await host.webServer.invoke('POST', '/commander/tasks/task_done_a/accept', { requestId: 'req_accept_1' })
  assert.equal(accepted.status, 200)
  // 一次只投一条：两个 ready 后继，先投 updatedAt 较早的那条。
  assert.equal(host.texts().length, 1)
  assert.match(host.texts()[0] ?? '', /\[task-unblocked\] taskId=task_next_b/)
  assert.match(host.texts()[0] ?? '', /task_done_a/)
  assert.equal(host.stores.tasks.get('task_next_b')?.dependencyNotifiedAt !== undefined, true)
  assert.equal(host.stores.tasks.get('task_next_c')?.dependencyNotifiedAt, undefined)
  // 幂等重复 accept 不再提醒
  await host.webServer.invoke('POST', '/commander/tasks/task_done_a/accept', {})
  assert.equal(host.texts().length, 1)
  // Host 只提醒，不改后继状态
  assert.equal(host.stores.tasks.get('task_next_b')?.status, 'draft')
  assert.equal(host.stores.tasks.get('task_next_c')?.status, 'draft')
})

test('confirmed dispatch clears the card and pumps the next ready task only', async () => {
  const host = await setup()
  seed(host.stores, { id: 'task_done_a', status: 'review', acceptance })
  seed(host.stores, { id: 'task_next_b', status: 'draft', dependsOn: ['task_done_a'] })
  seed(host.stores, { id: 'task_next_c', status: 'draft', dependsOn: ['task_done_a'] })
  await host.webServer.invoke('POST', '/commander/tasks/task_done_a/accept', {})
  assert.equal(host.texts().length, 1)
  // 首轮生成确认卡：有未决卡时不 pump（避免顶掉单确认卡）。
  const first = (await host.specOf('commander_task_dispatch').execute({ taskId: 'task_next_b', requestId: 'req_pump_b' }, host.exec)) as { status: string; decisionId: string; recommendation: unknown }
  assert.equal(first.status, 'needs_confirmation')
  assert.equal(host.texts().length, 1)
  // 确认派发成功（卡被消费）后 pump 下一条 C。
  const confirmed = (await host.specOf('commander_task_dispatch').execute({
    taskId: 'task_next_b', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_pump_b2',
  }, host.exec)) as { status: string }
  assert.equal(confirmed.status, 'dispatched')
  assert.equal(host.texts().length, 2)
  assert.match(host.texts()[1] ?? '', /\[task-unblocked\] taskId=task_next_c/)
  assert.equal(host.stores.tasks.get('task_next_c')?.dependencyNotifiedAt !== undefined, true)
})

test('cancel notifies draft/proposed dependents with [task-dependency-blocked] and leaves their status unchanged', async () => {
  const host = await setup()
  seed(host.stores, { id: 'task_cancel_a', status: 'running', primarySessionId: 's-work', assignments: ['s-work'] })
  seed(host.stores, { id: 'task_next_b', status: 'draft', dependsOn: ['task_cancel_a'] })
  const cancelled = await host.webServer.invoke('POST', '/commander/tasks/task_cancel_a/cancel', { requestId: 'req_cancel_1' })
  assert.equal(cancelled.status, 200)
  assert.equal((cancelled.body as { task: { status: string } }).task.status, 'cancelled')
  const blocked = host.texts().filter((text) => text.includes('[task-dependency-blocked]'))
  assert.equal(blocked.length, 1)
  assert.match(blocked[0] ?? '', /taskId=task_next_b/)
  assert.equal(host.stores.tasks.get('task_next_b')?.status, 'draft')
})

test('archive from review notifies dependents; restore returns to archivedFrom', async () => {
  const host = await setup()
  seed(host.stores, { id: 'task_arch_a', status: 'review', acceptance })
  seed(host.stores, { id: 'task_next_d', status: 'proposed', dependsOn: ['task_arch_a'] })
  const archived = await host.webServer.invoke('POST', '/commander/tasks/task_arch_a/archive', { requestId: 'req_arch_1' })
  assert.equal(archived.status, 200)
  assert.equal(host.stores.tasks.get('task_arch_a')?.archivedFrom, 'review')
  const blocked = host.texts().filter((text) => text.includes('[task-dependency-blocked]'))
  assert.equal(blocked.length, 1)
  assert.match(blocked[0] ?? '', /task_next_d/)
  const restored = await host.webServer.invoke('POST', '/commander/tasks/task_arch_a/restore', {})
  assert.equal(restored.status, 200)
  assert.equal((restored.body as { task: { status: string } }).task.status, 'review')
})
