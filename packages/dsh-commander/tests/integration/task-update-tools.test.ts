// commander_task_get / commander_task_update action+CAS 集成（task-state-machine-final §5.3/§5.4）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommanderTools } from '../../src/host/tools/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createFakeAgent, createFakeStorageDomain } from '../fakes/fakes.ts'
import type { TaskRecord } from '../../src/host/schema.ts'

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 1,
    id: 'task_u',
    title: 'T',
    goal: 'G',
    status: 'draft',
    workspaceId: 'ws',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 3,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }
}

async function setup(task: TaskRecord = baseTask(), pendingTaskId?: string) {
  const stores = createStores(await createFakeStorageDomain().open(commanderDomainSpec))
  await stores.tasks.put(task)
  const calls: string[] = []
  const tools = createCommanderTools({
    ctx: { get: () => undefined } as never,
    stores,
    dispatchService: {
      dispatchTask: async () => ({ status: 'rejected' as const, code: 'x', message: 'x' }),
      currentPending: () => (pendingTaskId === undefined ? null : { taskId: pendingTaskId }),
      prune: () => 0,
      decisions: {} as never,
    },
    commanderSessionId: () => 'session-commander',
    now: () => 500,
    hasPendingDispatch: (taskId) => pendingTaskId === taskId,
    dependencyNotifier: {
      afterTasksChanged: async (taskId?: string) => { calls.push(`changed:${taskId ?? ''}`) },
      afterDependencyInvalidated: async (taskId: string) => { calls.push(`blocked:${taskId}`) },
      afterDispatchSettled: async () => { calls.push('settled') },
    },
    onTaskSettled: (taskId) => { calls.push(`settled:${taskId}`) },
  })
  await tools.prepare()
  const specs = tools.specs() as Record<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>
  const exec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  return { stores, tools, specs, exec, calls }
}

test('commander_task_get returns latest version/status/dependsOn/waitingFor/ready/pendingDispatch/acceptanceCount', async () => {
  const { stores, specs, exec } = await setup(baseTask({
    dependsOn: ['task_done'],
    acceptance: [{ id: 'acc_1', text: 'A', source: 'commander', state: 'insufficient' }],
  }), 'task_u')
  await stores.tasks.put(baseTask({ id: 'task_done', status: 'done' }))
  const result = (await specs.commander_task_get.execute({ taskId: 'task_u' }, exec)) as Record<string, unknown>
  assert.equal(result.version, 3)
  assert.equal(result.status, 'draft')
  assert.equal(result.pendingDispatch, true)
  assert.deepEqual(result.dependsOn, ['task_done'])
  assert.deepEqual(result.waitingFor, [])
  assert.equal(result.ready, true)
  assert.equal(result.acceptanceCount, 1)
  assert.equal(result.evidenceInsufficientCount, 1)
})

test('commander_task_get 暴露写 prompt 所需的任务定义与上一轮信息', async () => {
  const { specs, exec } = await setup(baseTask({
    goal: '写清目标',
    acceptance: [
      { id: 'acc_1', text: '验收一', verify: 'pnpm test', evidence: 'out.txt', source: 'commander', state: 'evidence_present' },
      { id: 'acc_2', text: '验收二', source: 'commander', state: 'insufficient' },
    ],
    reportSummary: { text: '上一轮结论', at: 9, round: 1 },
    pendingInstruction: { text: '看板批注原文', at: 8, source: 'rework' },
    acceptanceHistory: [{ round: 1, at: 7, items: [{ id: 'acc_0', text: '历史验收', source: 'commander', state: 'evidence_present' }], reportSummary: { text: '历史结论', at: 7, round: 1 } }],
  }))
  const result = (await specs.commander_task_get.execute({ taskId: 'task_u' }, exec)) as Record<string, unknown>
  assert.equal(result.goal, '写清目标')
  assert.deepEqual(result.acceptance, [
    { id: 'acc_1', text: '验收一', verify: 'pnpm test', evidence: 'out.txt', state: 'evidence_present' },
    { id: 'acc_2', text: '验收二', state: 'insufficient' },
  ])
  assert.deepEqual(result.reportSummary, { text: '上一轮结论', at: 9, round: 1 })
  assert.deepEqual(result.pendingInstruction, { text: '看板批注原文', at: 8 })
  const history = result.acceptanceHistory as Array<Record<string, unknown>>
  assert.equal(history.length, 1)
  assert.equal(history[0]?.round, 1)
  assert.deepEqual((history[0]?.items as Array<Record<string, unknown>>)[0], { id: 'acc_0', text: '历史验收', state: 'evidence_present' })
  assert.deepEqual(history[0]?.reportSummary, { text: '历史结论', at: 7, round: 1 })
})

test('commander_task_update rejects stale revision and raw status without writing', async () => {
  const { stores, specs, exec } = await setup()
  const stale = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 2, action: 'edit', title: 'new' }, exec)) as { ok: boolean; code: string }
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'task_stale_revision')
  assert.equal(stores.tasks.get('task_u')?.title, 'T')
  assert.equal(stores.tasks.get('task_u')?.version, 3)
  const raw = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, action: 'edit', status: 'running' }, exec)) as { ok: boolean; code: string }
  assert.equal(raw.ok, false)
  assert.equal(raw.code, 'invalid_request')
  assert.equal(stores.tasks.get('task_u')?.status, 'draft')
})

test('edit updates metadata and version; set_dependencies validates DAG; block/recover go through state machine', async () => {
  const { stores, specs, exec, calls } = await setup()
  const edited = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, action: 'edit', title: '新标题', priority: 'high', progress: { label: '半程', pct: 0.5 } }, exec)) as { ok: boolean; version: number; status: string }
  assert.equal(edited.status, 'draft')
  assert.equal(edited.version, 4)
  assert.equal(stores.tasks.get('task_u')?.title, '新标题')
  assert.equal(stores.tasks.get('task_u')?.priority, 'high')
  assert.equal(stores.tasks.get('task_u')?.progress?.pct, 0.5)
  const deps = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 4, action: 'set_dependencies', dependsOn: [] }, exec)) as { ok?: boolean; version?: number }
  assert.equal((deps as { version?: number }).version, 5)
  assert.ok(calls.includes('changed:task_u'))
  const blocked = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 5, action: 'block', reason: '外部依赖' }, exec)) as { ok: boolean; status: string }
  assert.equal(blocked.status, 'blocked')
  assert.equal(stores.tasks.get('task_u')?.block?.reason, '外部依赖')
  const recovered = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 6, action: 'recover', recoverTo: 'proposed' }, exec)) as { ok: boolean; status: string }
  assert.equal(recovered.status, 'proposed')
  assert.equal(stores.tasks.get('task_u')?.block, undefined)
  // set_dependencies 不允许 queued/running/review
  await stores.tasks.put(baseTask({ id: 'task_other', status: 'queued', version: 1 }))
  const invalid = (await specs.commander_task_update.execute({ taskId: 'task_other', expectedRevision: 1, action: 'set_dependencies', dependsOn: ['task_u'] }, exec)) as { ok: boolean; code: string }
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'invalid_status')
})

test('pending_dispatch blocks edit/block/recover but cancel is allowed and notifies dependents', async () => {
  const { stores, specs, exec, calls } = await setup(baseTask({ status: 'proposed', pendingInstruction: { text: 'x', at: 1, source: 'rework' } }), 'task_u')
  for (const args of [
    { action: 'edit', title: 'x' },
    { action: 'block', reason: 'x' },
    { action: 'recover', recoverTo: 'proposed' },
  ]) {
    const result = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, ...args }, exec)) as { ok: boolean; code: string; message: string }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'conflict')
    assert.match(result.message, /pending_dispatch/)
  }
  const cancel = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, action: 'cancel' }, exec)) as { ok?: boolean; status: string }
  assert.equal(cancel.status, 'cancelled')
  assert.equal(stores.tasks.get('task_u')?.pendingInstruction, undefined)
  assert.ok(calls.includes('settled:task_u'))
  assert.ok(calls.includes('blocked:task_u'))
})

test('set_dependencies rejects cycles/self/missing and clears dependencyNotifiedAt', async () => {
  const { stores, specs, exec } = await setup(baseTask({ dependencyNotifiedAt: 1 }))
  await stores.tasks.put(baseTask({ id: 'task_a', status: 'done' }))
  await stores.tasks.put(baseTask({ id: 'task_b', dependsOn: ['task_u'] }))
  const cycle = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, action: 'set_dependencies', dependsOn: ['task_b'] }, exec)) as { ok: boolean; code: string }
  assert.equal(cycle.ok, false)
  assert.equal(cycle.code, 'dependency_cycle')
  const self = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, action: 'set_dependencies', dependsOn: ['task_u'] }, exec)) as { ok: boolean; code: string }
  assert.equal(self.code, 'invalid_request')
  const missing = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, action: 'set_dependencies', dependsOn: ['nope'] }, exec)) as { ok: boolean; code: string }
  assert.equal(missing.code, 'unknown_task')
  const applied = (await specs.commander_task_update.execute({ taskId: 'task_u', expectedRevision: 3, action: 'set_dependencies', dependsOn: ['task_a'] }, exec)) as { ok?: boolean; version?: number }
  assert.equal(applied.version, 4)
  assert.equal(stores.tasks.get('task_u')?.dependencyNotifiedAt, undefined)
  assert.deepEqual(stores.tasks.get('task_u')?.dependsOn, ['task_a'])
})
